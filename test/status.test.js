import test from 'node:test';
import assert from 'node:assert/strict';
import { accountLine } from '../src/cli.js';

// Obviously fake accounts in the shape of /_router/status.
const account = (over = {}) => ({
  label: 'account-a', token: 'ok', usageSource: 'live', limitedUntil: null,
  fiveHour: { utilization: 41.9, resetsAt: null }, sevenDay: { utilization: 58, resetsAt: null }, fable: null,
  available: true, availableForFable: true, ...over,
});

test('accountLine shows usage and ok for an account the router would pick', () => {
  assert.equal(accountLine(account()), '  account-a            5h  41%  7d  58%  fable    -  ok  (live)');
});

test('accountLine marks an account the router no longer picks as full, using the router decision', () => {
  // 7d at 95% is under 100 but over the router's limitPct: only `available` knows.
  assert.match(accountLine(account({ sevenDay: { utilization: 95, resetsAt: null }, available: false, availableForFable: false })), / 가득 참 {2}\(live\)$/);
  assert.match(accountLine(account({ available: false, availableForFable: true })), / 가득 참 \(Fable만 가능\) {2}\(live\)$/);
  assert.match(accountLine(account({ availableForFable: false, fable: { utilization: 100, resetsAt: null } })), / ok \(Fable 제외\) {2}\(live\)$/);
});

test('accountLine names a limit or a token problem before fullness', () => {
  assert.match(accountLine(account({ limitedUntil: '2026-01-02T08:00:00.000Z', available: false })), / 제한 ~2026-01-02T08:00:00\.000Z {2}\(live\)$/);
  assert.match(accountLine(account({ token: 'rejected_401', available: false })), / 토큰 rejected_401 {2}\(live\)$/);
});

test('accountLine treats a missing decision as ok and a missing usage source as -', () => {
  const line = accountLine(account({ available: undefined, availableForFable: undefined, usageSource: null, fiveHour: null }));
  assert.equal(line, '  account-a            5h    -  7d  58%  fable    -  ok  (-)');
});
