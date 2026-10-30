import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { onboard } from '../src/onboard.js';
import { loadConfig, parseConfig, saveConfig, DEFAULTS, ConfigError } from '../src/config.js';
import { listEndpoints, isTailscale, publicUrl, portFree, findFreePort } from '../src/network.js';
import { parseArgs } from '../src/cli.js';
import { limitedResponse } from '../src/ratelimit.js';
import { scratch } from './helpers.js';

const ENDPOINTS = [
  { host: '100.101.102.103', kind: 'tailscale', label: '100.101.102.103  (Tailscale)' },
  { host: '192.168.0.5', kind: 'lan', label: '192.168.0.5  (LAN en0)' },
  { host: '127.0.0.1', kind: 'local', label: '127.0.0.1' },
  { host: '0.0.0.0', kind: 'all', label: '0.0.0.0' },
];
const ACCOUNTS = [{ id: 'a', kind: 'orca', label: 'alice', identity: { organizationName: 'Org' } }];

function scripted(answers) {
  const lines = [];
  const asked = [];
  return {
    lines,
    asked,
    io: {
      ask: async (q) => { asked.push(q); if (!answers.length) throw new Error(`unexpected question: ${q}`); return answers.shift(); },
      print: (l) => lines.push(l),
    },
  };
}

function deps(over = {}) {
  return { discover: () => ACCOUNTS, listEndpoints: () => ENDPOINTS, portFree: async () => true,
    findFreePort: async () => 18790, pingRouter: async () => ({ ok: true, info: { accounts: 1 } }),
    install: () => {}, wait: async () => {}, ...over };
}

test('onboard: picks Tailscale and the default port, saves a 0600 config with a new key, starts the agent', async (t) => {
  const file = path.join(scratch(t), 'config.json');
  let installed = 0;
  const s = scripted(['', '', 'y']);
  const r = await onboard(s.io, { configFile: file, deps: deps({ install: () => { installed += 1; } }) });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'http://100.101.102.103:18787');
  const c = loadConfig(file);
  assert.equal(c.host, '100.101.102.103');
  assert.equal(c.port, 18787);
  assert.match(c.routerKey, /^cpr_[A-Za-z0-9_-]{32}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(installed, 1);
  assert.ok(s.lines.some((l) => l.includes(c.routerKey)), 'prints the key for the sender');
});

test('onboard: a busy port is refused and asked again; manual address is validated', async (t) => {
  const file = path.join(scratch(t), 'config.json');
  const s = scripted(['5', '999.1.1.1', '5', '10.0.0.7', '', '18800', 'n']);
  const r = await onboard(s.io, { configFile: file, deps: deps({ portFree: async (h, p) => p === 18800 }) });
  assert.equal(r.ok, true);
  assert.equal(loadConfig(file).host, '10.0.0.7');
  assert.equal(loadConfig(file).port, 18800);
  assert.ok(s.asked.some((q) => q.includes('[18790]')), 'suggests a free port when the default is taken');
  assert.ok(s.lines.some((l) => l.includes('이미 사용 중')));
  assert.ok(s.lines.some((l) => l.includes('IPv4 주소 형식이 아니에요')));
});

test('onboard: re-running keeps the key and accepts the port the running router holds', async (t) => {
  const file = path.join(scratch(t), 'config.json');
  const existing = saveConfig({ ...DEFAULTS, host: '192.168.0.5', port: 18787, routerKey: 'cpr_existing_key_000000' }, file);
  const s = scripted([]);
  const r = await onboard(s.io, { configFile: file, existing, flags: { host: '192.168.0.5', port: 18787, install: false },
    deps: deps({ portFree: async () => false }) });
  assert.equal(r.ok, true);
  assert.equal(loadConfig(file).routerKey, 'cpr_existing_key_000000');
});

test('onboard: no accounts or a bad flag ends without writing a config', async (t) => {
  const file = path.join(scratch(t), 'config.json');
  assert.equal((await onboard(scripted([]).io, { configFile: file, deps: deps({ discover: () => [] }) })).ok, false);
  assert.equal((await onboard(scripted([]).io, { configFile: file, flags: { host: 'nope' }, deps: deps() })).ok, false);
  assert.equal((await onboard(scripted([]).io, { configFile: file, flags: { host: '127.0.0.1', port: 70000 }, deps: deps() })).ok, false);
  assert.equal(loadConfig(file), null);
});

test('parseConfig rejects unknown keys and bad values, naming the key', () => {
  assert.throws(() => parseConfig({ nope: 1 }), (e) => e instanceof ConfigError && e.message === 'nope: unknown key');
  assert.throws(() => parseConfig({ port: 0 }), (e) => e instanceof ConfigError && e.message.startsWith('port:'));
  assert.throws(() => parseConfig({ usagePollS: 5 }), /usagePollS/);
  assert.throws(() => parseConfig({ limitPct: 0 }), /limitPct/);
  assert.throws(() => parseConfig({ routerKey: 'short' }), /routerKey/);
  assert.throws(() => parseConfig([]), /config/);
  assert.equal(parseConfig({}).port, 18787);
});

test('loadConfig reports broken JSON', (t) => {
  const file = path.join(scratch(t), 'c.json');
  fs.writeFileSync(file, '{');
  assert.throws(() => loadConfig(file), /not valid JSON/);
});

test('network helpers: Tailscale range, endpoint order, public URL, port probing', async () => {
  assert.equal(isTailscale('100.64.0.1'), true);
  assert.equal(isTailscale('100.128.0.1'), false);
  assert.equal(isTailscale('10.0.0.1'), false);
  const eps = listEndpoints({ en0: [{ family: 'IPv4', internal: false, address: '192.168.1.2' }],
    utun4: [{ family: 'IPv4', internal: false, address: '100.112.1.1' }], lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] });
  assert.deepEqual(eps.map((e) => e.kind), ['tailscale', 'lan', 'local', 'all']);
  assert.equal(publicUrl('0.0.0.0', 1, eps), 'http://100.112.1.1:1');
  assert.equal(publicUrl('0.0.0.0', 1, []), 'http://127.0.0.1:1');
  const free = await findFreePort('127.0.0.1', 40000);
  assert.equal(await portFree('127.0.0.1', free), true);
});

test('parseArgs: flags anywhere, --port must be an integer, unknown flags fail', () => {
  assert.deepEqual(parseArgs(['onboard', '--port', '9000', '--yes']), { cmd: 'onboard', args: [], opts: { port: 9000, yes: true } });
  assert.throws(() => parseArgs(['start', '--port', 'x']), /--port/);
  assert.throws(() => parseArgs(['start', '--bogus']), /unknown option/);
  assert.throws(() => parseArgs(['start', '--config']), /needs a value/);
  assert.equal(parseArgs([]).cmd, null);
});

test('limitedResponse without a captured rejection builds the unified headers', () => {
  const now = 1_800_000_000_000;
  const r = limitedResponse({ resetAt: now + 90_000, claim: 'seven_day', rejection: null }, now);
  assert.equal(r.status, 429);
  assert.equal(r.headers['retry-after'], '90');
  assert.equal(r.headers['anthropic-ratelimit-unified-representative-claim'], 'seven_day');
  assert.equal(r.headers['anthropic-ratelimit-unified-7d-status'], 'rejected');
  assert.equal(r.headers['anthropic-ratelimit-unified-reset'], String((now + 90_000) / 1000));
  const past = limitedResponse({ resetAt: null, claim: null, rejection: null }, now);
  assert.equal(past.headers['anthropic-ratelimit-unified-representative-claim'], 'five_hour');
  assert.ok(Number(past.headers['anthropic-ratelimit-unified-reset']) * 1000 > now, 'reset is always ahead');
});

test('onboard: without Tailscale the default is 127.0.0.1, and a LAN pick prints a plaintext warning', async (t) => {
  const file = path.join(scratch(t), 'config.json');
  const noTs = ENDPOINTS.filter((e) => e.kind !== 'tailscale');
  const s = scripted(['', '', 'n']);
  await onboard(s.io, { configFile: file, deps: deps({ listEndpoints: () => noTs }) });
  assert.equal(loadConfig(file).host, '127.0.0.1');
  assert.ok(!s.lines.some((l) => l.startsWith('주의')));
  const s2 = scripted(['1', '', 'n']);
  await onboard(s2.io, { configFile: file, existing: loadConfig(file), deps: deps({ listEndpoints: () => noTs }) });
  assert.equal(loadConfig(file).host, '192.168.0.5');
  assert.ok(s2.lines.some((l) => l.startsWith('주의') && l.includes('평문 HTTP')));
});

test('onboard: a busy port that is not this router is refused', async (t) => {
  const file = path.join(scratch(t), 'config.json');
  const existing = saveConfig({ ...DEFAULTS, port: 18787, routerKey: 'cpr_existing_key_000000' }, file);
  const r = await onboard(scripted([]).io, { configFile: file, existing, flags: { host: '127.0.0.1', port: 18787, install: false },
    deps: deps({ portFree: async () => false, pingRouter: async () => ({ ok: false, reason: 'not_router' }) }) });
  assert.equal(r.ok, false);
});

test('parseConfig checks upstream, host, profilesRoot and booleans', () => {
  assert.throws(() => parseConfig({ upstream: 'ftp://x' }), /^Error: upstream|upstream:/);
  assert.throws(() => parseConfig({ host: '' }), /host:/);
  assert.throws(() => parseConfig({ profilesRoot: 'rel/path' }), /profilesRoot:/);
  assert.throws(() => parseConfig({ tokenRefresh: 'yes' }), /tokenRefresh:/);
  assert.equal(parseConfig({ upstream: 'http://127.0.0.1:9' }).upstream, 'http://127.0.0.1:9');
});
