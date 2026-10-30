import test from 'node:test';
import assert from 'node:assert/strict';
import { Pool, scoreOf } from '../src/pool.js';
import { account, credJson } from './helpers.js';

const NOW = Date.parse('2026-10-30T12:00:00Z');
const HOUR = 3600_000;
const win = (utilization, resetsAt = NOW + HOUR) => ({ utilization, resetsAt });

/** A pool over `spec`: id -> {usage, token?, expiresAt?}; returns {pool, clock, calls}. */
function makePool(spec, { config = {}, refresh, fetchFail = {} } = {}) {
  const clock = { now: NOW };
  const calls = { fetch: [], refresh: [] };
  const items = {};
  const accounts = Object.keys(spec).map((id) => {
    items[id] = spec[id].raw ?? credJson(spec[id].token ?? `tok-${id}`, spec[id].expiresAt ?? NOW + 8 * HOUR);
    return account(id, { keychainService: `Claude Code-credentials-${id}` });
  });
  const byToken = {};
  for (const id of Object.keys(spec)) byToken[spec[id].token ?? `tok-${id}`] = id;
  const pool = new Pool({
    config,
    deps: {
      discover: () => accounts,
      keychainAccount: 'tester',
      readItem: async (svc) => items[svc.replace('Claude Code-credentials-', '')] ?? null,
      writeItem: async () => true,
      fetchUsage: async (tok) => {
        const id = byToken[tok];
        calls.fetch.push(id);
        if (fetchFail[id]) return fetchFail[id];
        return { ok: true, usage: spec[id].usage };
      },
      readCachedUsage: () => null,
      refresh: refresh ?? (async (a) => { calls.refresh.push(a.id); return { state: 'skipped', reason: 'test' }; }),
      now: () => clock.now,
    },
  });
  return { pool, clock, calls, items };
}

const usage = (five, seven, fable = null) => ({ fiveHour: win(five), sevenDay: win(seven), fable: fable === null ? null : win(fable) });

test('scoreOf takes the max window and counts a reset window as 0', () => {
  assert.equal(scoreOf(usage(40, 70), NOW), 70);
  assert.equal(scoreOf({ fiveHour: win(99, NOW - 1), sevenDay: win(20) }, NOW), 20);
  assert.equal(scoreOf(null, NOW), null);
  assert.equal(scoreOf(usage(10, 10), NOW, { fable: true }), null, 'unknown fable window is unknown');
  assert.equal(scoreOf(usage(10, 10, 80), NOW, { fable: true }), 80);
});

test('ranked puts the account with the most headroom first, then lowest 5h', async () => {
  const { pool } = makePool({ a: { usage: usage(50, 60) }, b: { usage: usage(30, 20) }, c: { usage: usage(10, 60) } });
  await pool.tick();
  assert.deepEqual(pool.ranked().map((s) => s.account.id), ['b', 'c', 'a']);
});

test('ranked leaves out full, limited, expired and excluded accounts', async () => {
  const { pool, clock } = makePool({
    full: { usage: usage(100, 10) },
    ok: { usage: usage(90, 90) },
    expired: { usage: usage(0, 0), expiresAt: NOW - 1 },
    lim: { usage: usage(0, 0) },
  }, { config: { tokenRefresh: false } });
  await pool.tick();
  pool.markLimited(pool.states.get('lim'), { resetAt: NOW + HOUR, claim: 'five_hour' });
  assert.deepEqual(pool.ranked().map((s) => s.account.id), ['ok']);
  assert.deepEqual(pool.ranked({ exclude: new Set(['ok']) }), []);
  clock.now = NOW + HOUR + 1;
  assert.ok(pool.ranked().some((s) => s.account.id === 'lim'), 'a limit ends at its reset time');
});

test('a Fable request ranks by the Fable window too', async () => {
  const { pool } = makePool({ a: { usage: usage(10, 10, 95) }, b: { usage: usage(40, 40, 20) }, n: { usage: usage(0, 0) } });
  await pool.tick();
  assert.deepEqual(pool.ranked({ model: 'claude-fable-5-1' }).map((s) => s.account.id), ['b', 'a', 'n']);
  assert.deepEqual(pool.ranked({ model: 'claude-opus-5-5' }).map((s) => s.account.id), ['n', 'a', 'b']);
});

test('limitPct below 100 keeps accounts out earlier', async () => {
  const { pool } = makePool({ a: { usage: usage(91, 0) }, b: { usage: usage(50, 0) } }, { config: { limitPct: 90 } });
  await pool.tick();
  assert.deepEqual(pool.ranked().map((s) => s.account.id), ['b']);
});

test('usage is polled once per interval and backs off on 429', async () => {
  const { pool, clock, calls } = makePool({ a: { usage: usage(1, 1) }, b: { usage: usage(1, 1) } }, {
    config: { usagePollS: 60 },
    fetchFail: { b: { ok: false, status: 429, retryAfterS: 300 } },
  });
  await pool.tick();
  await pool.tick();
  assert.deepEqual(calls.fetch.sort(), ['a', 'b']);
  clock.now += 61_000;
  await pool.tick();
  assert.deepEqual(calls.fetch.filter((x) => x === 'b').length, 1, 'b waits for Retry-After');
  assert.equal(calls.fetch.filter((x) => x === 'a').length, 2);
  assert.equal(pool.states.get('b').usageError, 'http_429');
});

test('an expiring token is refreshed and the new one is used', async () => {
  const fresh = { accessToken: 'new-tok', refreshToken: 'r2', expiresAtMs: NOW + 8 * HOUR };
  const { pool } = makePool({ a: { usage: usage(1, 1), expiresAt: NOW + 60_000 } }, {
    refresh: async () => ({ state: 'refreshed', credential: fresh }),
  });
  await pool.tick();
  assert.equal(pool.states.get('a').credential.accessToken, 'new-tok');
  assert.equal(pool.states.get('a').refresh.state, 'refreshed');
});

test('a stopped refresh is not retried until the Keychain item changes', async () => {
  const { pool, calls, items } = makePool({ a: { usage: usage(1, 1), expiresAt: NOW + 60_000 } }, {
    refresh: async (a) => { calls.refresh.push(a.id); return { state: 'stopped', reason: 'invalid_grant' }; },
  });
  await pool.tick();
  await pool.tick();
  assert.equal(calls.refresh.length, 1);
  items.a = credJson('relogin', NOW + 60_000);
  await pool.tick();
  assert.equal(calls.refresh.length, 2);
});

test('earliestRelease names the soonest reset and its window', async () => {
  const { pool } = makePool({
    a: { usage: { fiveHour: win(100, NOW + 2 * HOUR), sevenDay: win(10), fable: null } },
    b: { usage: { fiveHour: win(10), sevenDay: win(100, NOW + 5 * HOUR), fable: null } },
  });
  await pool.tick();
  assert.deepEqual(pool.ranked(), []);
  const r = pool.earliestRelease();
  assert.equal(r.resetAt, NOW + 2 * HOUR);
  assert.equal(r.claim, 'five_hour');
  pool.markLimited(pool.states.get('b'), { resetAt: NOW + HOUR, claim: 'seven_day' });
  assert.equal(pool.earliestRelease().claim, 'seven_day');
});

test('a token refused with 401 stays out until another one appears', async () => {
  const { pool, items } = makePool({ a: { usage: usage(1, 1) } });
  await pool.tick();
  const s = pool.states.get('a');
  assert.equal(await pool.reloadAfter401(s), false);
  await pool.tick();
  assert.deepEqual(pool.ranked(), []);
  items.a = credJson('other', NOW + 8 * HOUR);
  await pool.tick();
  assert.equal(pool.ranked()[0].credential.accessToken, 'other');
});

test('snapshot never contains a token', async () => {
  const { pool } = makePool({ a: { usage: usage(1, 1), token: 'secret-token-value' } });
  await pool.tick();
  assert.ok(!JSON.stringify(pool.snapshot()).includes('secret-token-value'));
  assert.equal(pool.snapshot()[0].token, 'ok');
});

test('a rotated set whose Keychain write failed survives read failures and is written later', async () => {
  const fresh = { accessToken: 'rotated', refreshToken: 'r2', expiresAtMs: NOW + 8 * HOUR };
  let writes = 0;
  let writeOk = false;
  const { pool, items } = makePool({ a: { usage: usage(1, 1), expiresAt: NOW + 60_000 } }, {
    refresh: async () => ({ state: 'refreshed', reason: 'write_failed', credential: fresh, pendingWrite: 'NEW-RAW' }),
  });
  pool.writeItem = async (svc, acct, raw) => { writes += 1; if (writeOk) items.a = credJson('rotated', NOW + 8 * HOUR); return writeOk; };
  await pool.tick();
  const s = pool.states.get('a');
  assert.equal(s.credential.accessToken, 'rotated');
  items.a = null; // Keychain read fails
  await pool.tick();
  assert.equal(s.credential.accessToken, 'rotated', 'kept through a failed read');
  assert.ok(s.pending, 'still held');
  items.a = credJson('old', NOW + 60_000); // Keychain still shows the spent set
  await pool.tick();
  assert.equal(s.credential.accessToken, 'rotated', 'never falls back to the spent token');
  writeOk = true;
  await pool.tick();
  await pool.tick();
  assert.equal(s.pending, null);
  assert.ok(writes >= 3);
  assert.equal(pool.ranked()[0].credential.accessToken, 'rotated');
});

test('a failed Keychain read keeps the token already held', async () => {
  const { pool, items } = makePool({ a: { usage: usage(1, 1) } });
  await pool.tick();
  items.a = null;
  await pool.tick();
  assert.equal(pool.ranked().length, 1);
  assert.equal(pool.states.get('a').tokenError, 'no_credential');
});

test('a 401-refused account is brought back by a forced refresh', async () => {
  const fresh = { accessToken: 'after-refresh', refreshToken: 'r', expiresAtMs: NOW + 8 * HOUR };
  const seen = [];
  const { pool } = makePool({ a: { usage: usage(1, 1) } }, {
    refresh: async (a, k, d, opts) => { seen.push(opts?.rejectedToken); return { state: 'refreshed', credential: fresh }; },
  });
  await pool.tick();
  await pool.reloadAfter401(pool.states.get('a'));
  assert.deepEqual(pool.ranked(), []);
  await pool.tick();
  assert.deepEqual(seen, ['tok-a']);
  assert.equal(pool.ranked()[0].credential.accessToken, 'after-refresh');
});

test('two concurrent 401s for one token keep it out', async () => {
  const { pool } = makePool({ a: { usage: usage(1, 1) } }, { config: { tokenRefresh: false } });
  await pool.tick();
  const s = pool.states.get('a');
  await Promise.all([pool.reloadAfter401(s), pool.reloadAfter401(s)]);
  assert.equal(s.rejectedToken, 'tok-a');
  await pool.tick();
  assert.deepEqual(pool.ranked(), []);
});

test('earliestRelease ignores a full Fable window for a non-Fable request', async () => {
  const { pool } = makePool({ a: { usage: { fiveHour: win(100, NOW + HOUR), sevenDay: win(10), fable: win(100, NOW + 100 * HOUR) } } });
  await pool.tick();
  assert.deepEqual(pool.earliestRelease(), { resetAt: NOW + HOUR, claim: 'five_hour', rejection: null, s: pool.states.get('a') });
  const f = pool.earliestRelease({ model: 'claude-fable-5-1' });
  assert.equal(f.resetAt, NOW + 100 * HOUR);
  assert.equal(f.claim, 'seven_day');
});

test('stop waits for a pass in flight', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { pool } = makePool({ a: { usage: usage(1, 1) } });
  pool.readItem = async () => { await gate; return credJson('tok-a', NOW + HOUR); };
  const ticking = pool.tick();
  let stopped = false;
  const stopping = pool.stop().then(() => { stopped = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped, false);
  release();
  await ticking;
  await stopping;
  assert.equal(stopped, true);
});
