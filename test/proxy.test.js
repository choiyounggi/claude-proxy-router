import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { Pool } from '../src/pool.js';
import { createHandler, listen, withOauthBeta, callerKey, upstreamUrl } from '../src/proxy.js';
import { pingRouter } from '../src/network.js';
import { account, credJson, fakeUpstream } from './helpers.js';

const KEY = 'cpr_test_key_0123456789';
const HOUR = 3600_000;

async function router(t, upstreamUrl, spec) {
  const accounts = Object.keys(spec).map((id) => account(id, { keychainService: `Claude Code-credentials-${id}` }));
  const items = Object.fromEntries(Object.keys(spec).map((id) => [id, credJson(`tok-${id}`, Date.now() + 8 * HOUR)]));
  const pool = new Pool({
    deps: {
      discover: () => accounts,
      keychainAccount: 'tester',
      readItem: async (svc) => items[svc.replace('Claude Code-credentials-', '')],
      writeItem: async () => true,
      fetchUsage: async (tok) => ({ ok: true, usage: spec[tok.slice(4)] }),
      readCachedUsage: () => null,
      refresh: async () => ({ state: 'skipped' }),
    },
  });
  await pool.tick();
  const server = await listen(createHandler({ pool, routerKey: KEY, upstream: upstreamUrl, version: '9.9.9' }), { host: '127.0.0.1', port: 0 });
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { url: `http://127.0.0.1:${server.address().port}`, pool, items };
}

const u = (five, seven = 0) => ({ fiveHour: { utilization: five, resetsAt: Date.now() + HOUR }, sevenDay: { utilization: seven, resetsAt: Date.now() + 5 * HOUR }, fable: null });

function rejected(res, resetS) {
  res.writeHead(429, {
    'content-type': 'application/json',
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': String(resetS),
  });
  res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'upstream says no' } }));
}

const post = (url, headers = {}, body = '{"model":"claude-opus-5-5","messages":[]}') =>
  fetch(`${url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY, ...headers }, body });

test('withOauthBeta adds the OAuth beta once and keeps the rest', () => {
  assert.equal(withOauthBeta(undefined), 'oauth-2025-04-20');
  assert.equal(withOauthBeta('a, b'), 'a,b,oauth-2025-04-20');
  assert.equal(withOauthBeta('oauth-2025-04-20,x'), 'oauth-2025-04-20,x');
});

test('callerKey reads x-router-key, x-api-key or a bearer token', () => {
  assert.equal(callerKey({ 'x-router-key': 'a' }), 'a');
  assert.equal(callerKey({ 'x-api-key': 'b' }), 'b');
  assert.equal(callerKey({ authorization: 'Bearer c' }), 'c');
  assert.equal(callerKey({}), null);
});

test('a wrong or missing key is refused with the service name, ping answers pong', async (t) => {
  const up = await fakeUpstream(t, (req, body, res) => res.end());
  const r = await router(t, up.url, { a: u(10) });
  const bad = await post(r.url, { 'x-api-key': 'wrong' });
  assert.equal(bad.status, 401);
  assert.equal((await bad.json()).service, 'claude-proxy-router');
  assert.equal(up.calls.length, 0);
  assert.deepEqual(await pingRouter(r.url, 'wrong'), { ok: false, reason: 'bad_key' });
  const ok = await pingRouter(r.url, KEY);
  assert.equal(ok.ok, true);
  assert.equal(ok.info.accounts, 1);
  assert.equal(ok.info.protocol, 1);
  assert.deepEqual(await pingRouter('http://127.0.0.1:1', KEY), { ok: false, reason: 'unreachable' });
});

test('forwards to the account with most headroom with its token, streams the answer unchanged', async (t) => {
  const up = await fakeUpstream(t, (req, body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.5', 'anthropic-ratelimit-unified-5h-reset': '1790000000' });
    res.write('event: a\ndata: 1\n\n');
    setTimeout(() => res.end('event: b\ndata: 2\n\n'), 20);
  });
  const r = await router(t, up.url, { busy: u(80), free: u(5) });
  const res = await post(r.url, { 'anthropic-beta': 'claude-code-20250219', 'anthropic-version': '2023-06-01' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
  const call = up.calls[0];
  assert.equal(call.url, '/v1/messages');
  assert.equal(call.headers.authorization, 'Bearer tok-free');
  assert.equal(call.headers['x-api-key'], undefined, 'the router key never goes upstream');
  assert.equal(call.headers['anthropic-beta'], 'claude-code-20250219,oauth-2025-04-20');
  assert.equal(call.headers['anthropic-version'], '2023-06-01');
  assert.equal(call.body.toString(), '{"model":"claude-opus-5-5","messages":[]}');
  assert.equal(r.pool.states.get('free').usage.fiveHour.utilization, 50, 'answer headers update usage');
});

test('a subscription-limit 429 moves the request to the next account', async (t) => {
  const up = await fakeUpstream(t, (req, body, res) => {
    if (req.headers.authorization === 'Bearer tok-a') rejected(res, Math.floor(Date.now() / 1000) + 600);
    else res.end('{"ok":true}');
  });
  const r = await router(t, up.url, { a: u(1), b: u(50) });
  const res = await post(r.url);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"ok":true}');
  assert.deepEqual(up.calls.map((c) => c.headers.authorization), ['Bearer tok-a', 'Bearer tok-b']);
  assert.ok(r.pool.states.get('a').limitedUntil > Date.now());
  await post(r.url);
  assert.equal(up.calls.at(-1).headers.authorization, 'Bearer tok-b', 'a stays out until its reset');
});

test('when every account is limited the caller gets Anthropic\'s own limit answer', async (t) => {
  const reset = Math.floor(Date.now() / 1000) + 900;
  const up = await fakeUpstream(t, (req, body, res) => rejected(res, reset));
  const r = await router(t, up.url, { a: u(1), b: u(2) });
  const res = await post(r.url);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('anthropic-ratelimit-unified-status'), 'rejected');
  assert.equal(res.headers.get('anthropic-ratelimit-unified-representative-claim'), 'five_hour');
  assert.equal(res.headers.get('anthropic-ratelimit-unified-reset'), String(reset));
  assert.equal(res.headers.get('x-should-retry'), 'false');
  assert.equal((await res.json()).error.message, 'upstream says no');
  assert.equal(up.calls.length, 2);
});

test('accounts already full by usage get a built limit answer without any upstream call', async (t) => {
  const up = await fakeUpstream(t, (req, body, res) => res.end());
  const r = await router(t, up.url, { a: u(100), b: u(10, 100) });
  const res = await post(r.url);
  assert.equal(res.status, 429);
  assert.equal(up.calls.length, 0);
  assert.equal(res.headers.get('anthropic-ratelimit-unified-status'), 'rejected');
  assert.equal(res.headers.get('anthropic-ratelimit-unified-representative-claim'), 'five_hour');
  const resetS = Number(res.headers.get('anthropic-ratelimit-unified-reset'));
  assert.ok(resetS * 1000 > Date.now() && resetS * 1000 <= Date.now() + HOUR + 1000);
  assert.equal((await res.json()).error.type, 'rate_limit_error');
});

test('a gzip rejection is stored decoded so the replay is readable', async (t) => {
  const reset = Math.floor(Date.now() / 1000) + 900;
  const up = await fakeUpstream(t, (req, body, res) => {
    const z = zlib.gzipSync(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'zipped' } }));
    res.writeHead(429, { 'content-encoding': 'gzip', 'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-representative-claim': 'seven_day', 'anthropic-ratelimit-unified-reset': String(reset) });
    res.end(z);
  });
  const r = await router(t, up.url, { a: u(1) });
  const res = await post(r.url);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('content-encoding'), null);
  assert.equal((await res.json()).error.message, 'zipped');
  assert.equal(res.headers.get('anthropic-ratelimit-unified-representative-claim'), 'seven_day');
});

test('a 401 re-reads the Keychain and retries once with a changed token', async (t) => {
  const up = await fakeUpstream(t, (req, body, res) => {
    if (req.headers.authorization === 'Bearer tok-a') { res.writeHead(401); res.end(); } else res.end('fine');
  });
  const r = await router(t, up.url, { a: u(1) });
  r.items.a = credJson('tok-a2', Date.now() + HOUR);
  const res = await post(r.url);
  assert.equal(await res.text(), 'fine');
  assert.deepEqual(up.calls.map((c) => c.headers.authorization), ['Bearer tok-a', 'Bearer tok-a2']);
});

test('no usable token at all is a 503, other paths are 404, other statuses pass through', async (t) => {
  const up = await fakeUpstream(t, (req, body, res) => { res.writeHead(529, { 'x-test': '1' }); res.end('overloaded'); });
  const r = await router(t, up.url, { a: u(1) });
  const res = await post(r.url);
  assert.equal(res.status, 529);
  assert.equal(res.headers.get('x-test'), '1');
  assert.equal(await res.text(), 'overloaded');
  const nf = await fetch(`${r.url}/api/other`, { headers: { 'x-api-key': KEY } });
  assert.equal(nf.status, 404);
  r.pool.states.get('a').credential = null;
  r.pool.states.get('a').rejectedToken = 'tok-a';
  const none = await post(r.url);
  assert.equal(none.status, 503);
});

test('the status endpoint lists accounts without tokens', async (t) => {
  const up = await fakeUpstream(t, (req, body, res) => res.end());
  const r = await router(t, up.url, { a: u(12) });
  const res = await fetch(`${r.url}/_router/status`, { headers: { authorization: `Bearer ${KEY}` } });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!text.includes('tok-a'));
  assert.equal(JSON.parse(text).accounts[0].score, 12);
});

test('upstreamUrl keeps every request on the upstream origin under /v1/', () => {
  const base = 'https://api.anthropic.com';
  assert.equal(upstreamUrl(base, '/v1/messages?beta=true'), 'https://api.anthropic.com/v1/messages?beta=true');
  for (const bad of ['/v1/../api/oauth/profile', '/v1/%2e%2e/api/x', '/v1/./../x', '/api/oauth/usage', '//evil.example/v1/x',
    '/v1\\..\\x', 'http://evil.example/v1/x', '', null]) {
    assert.equal(upstreamUrl(base, bad), null, String(bad));
  }
});

test('a dot-segment path never reaches the upstream with a token', async (t) => {
  const up = await fakeUpstream(t, (req, body, res) => res.end('reached'));
  const r = await router(t, up.url, { a: u(1) });
  const { status } = await new Promise((resolve, reject) => {
    // fetch() would normalise the path itself; send it raw.
    const req = http.request(`${r.url}/v1/../api/oauth/profile`, { headers: { 'x-api-key': KEY } }, (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.path = '/v1/../api/oauth/profile';
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 404);
  assert.equal(up.calls.length, 0);
});

test('streamed chunks reach the caller before the upstream finishes', async (t) => {
  let finish;
  const up = await fakeUpstream(t, (req, body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: first\n\n');
    finish = () => res.end('event: last\n\n');
  });
  const r = await router(t, up.url, { a: u(1) });
  const res = await post(r.url);
  const reader = res.body.getReader();
  const first = await reader.read();
  assert.equal(Buffer.from(first.value).toString(), 'event: first\n\n', 'arrives while upstream is still open');
  finish();
  let rest = '';
  for (let c = await reader.read(); !c.done; c = await reader.read()) rest += Buffer.from(c.value).toString();
  assert.equal(rest, 'event: last\n\n');
});

test('a caller that leaves before headers aborts the upstream request', { timeout: 5000 }, async (t) => {
  let upstreamClosed;
  const closed = new Promise((r) => { upstreamClosed = r; });
  const up = await fakeUpstream(t, (req, body, res) => { res.on('close', upstreamClosed); /* never answers */ });
  const r = await router(t, up.url, { a: u(1), b: u(2) });
  const ac = new AbortController();
  const req = http.request(`${r.url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': KEY, 'content-type': 'application/json' }, signal: ac.signal });
  req.on('error', () => {});
  req.end('{"model":"m"}');
  await new Promise((res) => setTimeout(res, 50));
  ac.abort();
  await closed;
  await new Promise((res) => setTimeout(res, 50));
  assert.ok(up.calls.length >= 1);
  assert.ok(up.calls.every((c) => c.headers.authorization === 'Bearer tok-a'), 'no retry on another account after the caller left');
});

test('an upstream cut mid-stream ends the caller connection instead of hanging', { timeout: 5000 }, async (t) => {
  const up = await fakeUpstream(t, (req, body, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: a\n\n');
    setTimeout(() => res.socket.destroy(), 20);
  });
  const r = await router(t, up.url, { a: u(1) });
  const res = await post(r.url);
  // Before the fix the caller waited forever here (the test timeout catches that).
  const outcome = await res.text().then(() => 'ended', () => 'errored');
  assert.equal(outcome, 'errored', 'a cut stream must surface as an error, not as a complete answer');
});

test('an oversized body gets a 413 answer, not a reset', async (t) => {
  const up = await fakeUpstream(t, (req, body, res) => res.end());
  const r = await router(t, up.url, { a: u(1) });
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${r.url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': KEY } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    const chunk = Buffer.alloc(1024 * 1024, 97);
    let sent = 0;
    const pump = () => {
      while (sent < 66) {
        sent += 1;
        if (!req.write(chunk)) { req.once('drain', pump); return; }
      }
      req.end();
    };
    pump();
  });
  assert.equal(status, 413);
  assert.equal(up.calls.length, 0);
});
