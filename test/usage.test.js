import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fetchUsage, parseFable, parseRetryAfter, parseUnifiedHeaders, parseUsage, readCachedUsage } from '../src/usage.js';
import { fakeUpstream, scratch } from './helpers.js';

const BODY = {
  five_hour: { utilization: 42.5, resets_at: '2026-10-30T10:00:00Z' },
  seven_day: { utilization: 130, resets_at: null },
  limits: [
    { kind: 'weekly_scoped', percent: 10, scope: { model: { display_name: 'Fable' } }, resets_at: '2026-11-01T00:00:00Z' },
    { kind: 'weekly_scoped', percent: 30, scope: { model: { display_name: ' fable ' } } },
    { kind: 'weekly_scoped', percent: 99, scope: { model: { display_name: 'Opus' } } },
  ],
};

test('parseUsage reads both windows, clamps to 0..100 and picks the highest Fable limit', () => {
  const u = parseUsage(BODY);
  assert.deepEqual(u.fiveHour, { utilization: 42.5, resetsAt: Date.parse('2026-10-30T10:00:00Z') });
  assert.deepEqual(u.sevenDay, { utilization: 100, resetsAt: null });
  assert.deepEqual(u.fable, { utilization: 30, resetsAt: null });
});

test('parseUsage is null without a usable window', () => {
  assert.equal(parseUsage({}), null);
  assert.equal(parseUsage(null), null);
  assert.equal(parseUsage({ five_hour: { utilization: 'x' } }), null);
  assert.equal(parseFable({ limits: 'nope' }), null);
});

test('parseRetryAfter takes seconds or an HTTP-date and rejects junk', () => {
  assert.equal(parseRetryAfter('120'), 120);
  assert.equal(parseRetryAfter('Thu, 30 Oct 2026 10:00:10 GMT', Date.parse('2026-10-30T10:00:00Z')), 10);
  assert.equal(parseRetryAfter('-5'), null);
  assert.equal(parseRetryAfter(''), null);
  assert.equal(parseRetryAfter(undefined), null);
});

test('parseUnifiedHeaders converts fractions to percent and epoch seconds to ms', () => {
  const info = parseUnifiedHeaders({
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
    'anthropic-ratelimit-unified-reset': '1790000000',
    'anthropic-ratelimit-unified-5h-utilization': '0.97',
    'anthropic-ratelimit-unified-5h-reset': '1790000000',
  });
  assert.equal(info.status, 'rejected');
  assert.equal(info.claim, 'five_hour');
  assert.equal(info.resetAt, 1790000000000);
  assert.equal(info.fiveHour.utilization, 97);
  assert.equal(parseUnifiedHeaders({ 'anthropic-ratelimit-unified-status': 'allowed',
    'anthropic-ratelimit-unified-7d-utilization': '0.55' }).sevenDay.utilization, 55);
  assert.equal(info.sevenDay, null);
  assert.equal(parseUnifiedHeaders({}), null);
});

test('fetchUsage sends the OAuth beta and bearer token; reports HTTP failures', async (t) => {
  const up = await fakeUpstream(t, (req, body, res, n) => {
    if (n === 1) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(BODY));
    } else {
      res.writeHead(429, { 'retry-after': '90' });
      res.end();
    }
  });
  const ok = await fetchUsage('tok', { url: `${up.url}/api/oauth/usage` });
  assert.equal(ok.ok, true);
  assert.equal(ok.usage.fiveHour.utilization, 42.5);
  assert.equal(up.calls[0].headers.authorization, 'Bearer tok');
  assert.equal(up.calls[0].headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.deepEqual(await fetchUsage('tok', { url: `${up.url}/u` }), { ok: false, status: 429, retryAfterS: 90 });
  assert.deepEqual(await fetchUsage('tok', { url: 'http://127.0.0.1:1/u' }), { ok: false, status: 0, retryAfterS: null });
});

test('readCachedUsage reads Claude Code cache and ignores a broken file', (t) => {
  const dir = scratch(t);
  const f = path.join(dir, '.claude.json');
  fs.writeFileSync(f, JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: 5, utilization: BODY } }));
  assert.equal(readCachedUsage(f).fetchedAt, 5);
  fs.writeFileSync(f, '{');
  assert.equal(readCachedUsage(f), null);
  assert.equal(readCachedUsage(path.join(dir, 'missing.json')), null);
});
