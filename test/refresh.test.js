import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildDocument, parseTokenResponse, refreshAccount, requestScopes, takeCcLock, CLIENT_ID, TOKEN_URL } from '../src/refresh.js';
import { account, credJson, scratch } from './helpers.js';

const NOW = 1_800_000_000_000;
const okLock = () => ({ lock: { touch() {}, release() {} } });

/** Fake Keychain + token endpoint around refreshAccount. */
function harness({ raw = credJson('old', NOW + 1000, { scopes: ['user:inference'], subscriptionType: 'max' }), post, writeOk = true } = {}) {
  const store = { value: raw, writes: [], posts: [] };
  const deps = {
    now: () => NOW,
    takeCcLock: okLock,
    readItem: async () => store.value,
    writeItem: async (svc, acct, text) => {
      store.writes.push(text);
      if (!writeOk) return false;
      store.value = text;
      return true;
    },
    post: async (url, opts) => {
      store.posts.push({ url, opts });
      return post ? post(opts) : { status: 200, body: Buffer.from(JSON.stringify({ access_token: 'new', refresh_token: 'rt-new', expires_in: 28800, scope: 'user:inference user:profile' })) };
    },
  };
  return { store, deps };
}

test('requestScopes mirrors Claude Code: full base set for a subscription token without a client id', () => {
  const s = requestScopes({ scopes: ['user:inference', 'user:projects:read'], subscriptionType: 'max' });
  assert.ok(s.includes('user:sessions:claude_code'));
  assert.ok(s.includes('user:projects:read'));
  assert.deepEqual(requestScopes({ scopes: ['a'], clientId: 'c' }), ['a']);
  assert.deepEqual(requestScopes({}), []);
});

test('parseTokenResponse validates the body and keeps the old refresh token when none is sent', () => {
  const t = parseTokenResponse(JSON.stringify({ access_token: 'a', expires_in: 10 }), NOW, 'keep');
  assert.equal(t.refreshToken, 'keep');
  assert.equal(t.expiresAtMs, NOW + 10_000);
  assert.equal(parseTokenResponse('{', NOW, 'x'), null);
  assert.equal(parseTokenResponse(JSON.stringify({ access_token: 'a', expires_in: 0 }), NOW, 'x'), null);
  assert.equal(parseTokenResponse(JSON.stringify({ access_token: 'a b', expires_in: 5 }), NOW, 'x'), null);
});

test('buildDocument replaces only the token fields and keeps everything else', () => {
  const doc = { claudeAiOauth: { accessToken: 'o', refreshToken: 'r', expiresAt: 1, subscriptionType: 'max', rateLimitTier: 't' }, mcpOAuth: { k: 1 } };
  const out = buildDocument(doc, { accessToken: 'n', refreshToken: 'r2', expiresAtMs: 9, refreshExpiresAtMs: null, scopes: null });
  assert.deepEqual(out, { claudeAiOauth: { accessToken: 'n', refreshToken: 'r2', expiresAt: 9, subscriptionType: 'max', rateLimitTier: 't' }, mcpOAuth: { k: 1 } });
});

test('refreshAccount refreshes, writes the new set back and returns it', async () => {
  const { store, deps } = harness();
  const r = await refreshAccount(account('a'), 'tester', deps);
  assert.equal(r.state, 'refreshed');
  assert.equal(r.credential.accessToken, 'new');
  assert.equal(JSON.parse(store.value).claudeAiOauth.refreshToken, 'rt-new');
  assert.equal(JSON.parse(store.value).claudeAiOauth.subscriptionType, 'max');
  assert.equal(store.writes.length, 2, 'probe write, then the real write');
  const sent = JSON.parse(store.posts[0].opts.body);
  assert.equal(store.posts[0].url, TOKEN_URL);
  assert.equal(sent.grant_type, 'refresh_token');
  assert.equal(sent.refresh_token, 'rt-old');
  assert.equal(sent.client_id, CLIENT_ID);
});

test('refreshAccount does nothing when someone else already refreshed', async () => {
  const { store, deps } = harness({ raw: credJson('fresh', NOW + 3600_000) });
  const r = await refreshAccount(account('a'), 'tester', deps);
  assert.equal(r.state, 'fresh');
  assert.equal(r.credential.accessToken, 'fresh');
  assert.equal(store.posts.length, 0);
});

test('refreshAccount never spends the refresh token when the Keychain refuses writes', async () => {
  const { store, deps } = harness({ writeOk: false });
  const r = await refreshAccount(account('a'), 'tester', deps);
  assert.deepEqual(r, { state: 'failed', reason: 'keychain_write_unavailable' });
  assert.equal(store.posts.length, 0);
});

test('refreshAccount stops on invalid_grant and backs off on 5xx and 429', async () => {
  for (const [status, body, want] of [
    [400, { error: 'invalid_grant' }, { state: 'stopped', reason: 'invalid_grant' }],
    [503, {}, { state: 'failed', reason: 'server_error' }],
    [429, {}, { state: 'failed', reason: 'rate_limited' }],
    [403, {}, { state: 'failed', reason: 'server_error' }],
    [418, { error: 'teapot' }, { state: 'stopped', reason: 'rejected' }],
    [200, { nope: 1 }, { state: 'stopped', reason: 'malformed_response' }],
  ]) {
    const { deps } = harness({ post: () => ({ status, body: Buffer.from(JSON.stringify(body)) }) });
    assert.deepEqual(await refreshAccount(account('a'), 'tester', deps), want, `status ${status}`);
  }
});

test('refreshAccount: a failure after connecting is outcome_unknown, before connecting is retryable', async () => {
  const sent = harness({ post: () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET', requestSent: true }); } });
  assert.deepEqual(await refreshAccount(account('a'), 'tester', sent.deps), { state: 'stopped', reason: 'outcome_unknown' });
  for (const code of ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT', undefined]) {
    const h = harness({ post: () => { throw Object.assign(new Error('x'), { code, requestSent: false }); } });
    assert.deepEqual(await refreshAccount(account('a'), 'tester', h.deps), { state: 'failed', reason: 'network_error' }, String(code));
  }
  const unknown = harness({ post: () => { throw new Error('no flag'); } });
  assert.deepEqual(await refreshAccount(account('a'), 'tester', unknown.deps), { state: 'stopped', reason: 'outcome_unknown' });
});

test('the real HTTP client marks a refused connection as not sent', async () => {
  const { request } = await import('../src/http.js');
  const e = await request('http://127.0.0.1:1/x').catch((err) => err);
  assert.equal(e.requestSent, false);
});

test('refreshAccount refreshes a 401-refused token even before it expires', async () => {
  const { store, deps } = harness({ raw: credJson('refused', NOW + 3600_000) });
  const r = await refreshAccount(account('a'), 'tester', deps, { rejectedToken: 'refused' });
  assert.equal(r.state, 'refreshed');
  assert.equal(store.posts.length, 1);
});

test('refreshAccount skips a busy lock and a missing item', async () => {
  const { deps } = harness();
  deps.takeCcLock = () => ({ reason: 'cc_lock_busy' });
  assert.deepEqual(await refreshAccount(account('a'), 'tester', deps), { state: 'skipped', reason: 'cc_lock_busy' });
  const h2 = harness({ raw: null });
  assert.deepEqual(await refreshAccount(account('a'), 'tester', h2.deps), { state: 'skipped', reason: 'no_credential' });
  const h3 = harness({ raw: JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: NOW } }) });
  assert.deepEqual(await refreshAccount(account('a'), 'tester', h3.deps), { state: 'stopped', reason: 'no_refresh_token' });
});

test('takeCcLock makes both dirs, refuses while held, and releases only its own', (t) => {
  const dir = path.join(scratch(t), 'home');
  fs.mkdirSync(dir);
  const first = takeCcLock(dir);
  assert.ok(first.lock);
  assert.ok(fs.existsSync(path.join(dir, '.oauth_refresh.lock')));
  assert.ok(fs.existsSync(`${fs.realpathSync(dir)}.lock`));
  assert.deepEqual(takeCcLock(dir), { reason: 'cc_lock_busy' });
  assert.ok(fs.existsSync(path.join(dir, '.oauth_refresh.lock')), 'a failed attempt leaves the holder alone');
  first.lock.release();
  assert.ok(!fs.existsSync(path.join(dir, '.oauth_refresh.lock')));
  assert.ok(!fs.existsSync(`${fs.realpathSync(dir)}.lock`));
});

test('takeCcLock takes over an abandoned (stale, empty) lock dir but never a non-empty one', (t) => {
  const dir = path.join(scratch(t), 'home');
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, '.oauth_refresh.lock'));
  const later = Date.now() + 120_000;
  const r = takeCcLock(dir, later);
  assert.ok(r.lock, 'stale empty dir is reclaimed');
  r.lock.release();
  fs.mkdirSync(path.join(dir, '.oauth_refresh.lock'));
  fs.writeFileSync(path.join(dir, '.oauth_refresh.lock', 'x'), '');
  assert.deepEqual(takeCcLock(dir, later), { reason: 'cc_lock_busy' });
  assert.deepEqual(takeCcLock(dir), { reason: 'cc_lock_busy' }, 'a fresh lock is never taken');
});
