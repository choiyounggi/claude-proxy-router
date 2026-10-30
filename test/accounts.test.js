import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { discoverAccounts, discoverOrcaProfiles, keychainServiceFor, labelOf, parseCredential } from '../src/accounts.js';
import { scratch, credJson } from './helpers.js';

const UUID_A = '808f0d68-c00a-4b76-96c3-3adc122865eb';
const UUID_B = '11111111-2222-4333-8444-555555555555';

function profile(root, id, oauthAccount, accountId = id) {
  const home = path.join(root, id, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, id, 'profile.json'), JSON.stringify({ accountId }));
  if (oauthAccount) fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount }));
  return home;
}

test('keychainServiceFor hashes the config dir exactly as given', () => {
  const dir = '/Users/x/Library/Application Support/orca/claude-profiles/a/home';
  const want = `Claude Code-credentials-${createHash('sha256').update(dir).digest('hex').slice(0, 8)}`;
  assert.equal(keychainServiceFor(dir), want);
  assert.notEqual(keychainServiceFor(`${dir}/`), want);
});

test('discoverOrcaProfiles keeps only uuid folders whose profile.json names them', (t) => {
  const root = scratch(t);
  profile(root, UUID_A, { emailAddress: 'alice@example.com', organizationName: 'Org' });
  profile(root, UUID_B, null, 'someone-else');
  fs.mkdirSync(path.join(root, 'not-a-uuid', 'home'), { recursive: true });
  const list = discoverOrcaProfiles(`${root}/`);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, UUID_A);
  assert.equal(list[0].label, 'alice');
  assert.equal(list[0].keychainService, keychainServiceFor(path.join(root, UUID_A, 'home')));
});

test('discoverOrcaProfiles on a missing root is empty', () => {
  assert.deepEqual(discoverOrcaProfiles('/nonexistent/cpr-root'), []);
});

test('discoverAccounts drops the default login when an Orca profile is the same seat', (t) => {
  const root = scratch(t);
  const home = scratch(t);
  const seat = { accountUuid: 'acc-1', organizationUuid: 'org-1', emailAddress: 'a@example.com' };
  profile(root, UUID_A, seat);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: seat }));
  assert.deepEqual(discoverAccounts({ profilesRoot: root, home }).map((a) => a.id), [UUID_A]);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { ...seat, organizationUuid: 'org-2' } }));
  const ids = discoverAccounts({ profilesRoot: root, home }).map((a) => a.id);
  assert.deepEqual(ids, [UUID_A, 'default']);
  assert.deepEqual(discoverAccounts({ profilesRoot: root, home, includeDefault: false }).map((a) => a.id), [UUID_A]);
});

test('labelOf falls back from email to display name to id prefix', () => {
  assert.equal(labelOf({ email: 'bob@x.io' }, 'id'), 'bob');
  assert.equal(labelOf({ email: null, displayName: 'Bob' }, 'id'), 'Bob');
  assert.equal(labelOf({ email: null, displayName: null }, '0123456789'), '01234567');
});

test('parseCredential accepts a valid item and rejects broken ones', () => {
  const c = parseCredential(credJson('tok', 123));
  assert.equal(c.accessToken, 'tok');
  assert.equal(c.refreshToken, 'rt-tok');
  assert.equal(c.expiresAtMs, 123);
  assert.equal(parseCredential(''), null);
  assert.equal(parseCredential(null), null);
  assert.equal(parseCredential('{not json'), null);
  assert.equal(parseCredential(JSON.stringify({ claudeAiOauth: { accessToken: 'has space', expiresAt: 1 } })), null);
  assert.equal(parseCredential(JSON.stringify({ claudeAiOauth: { accessToken: 'ok', expiresAt: '1' } })), null);
  assert.equal(parseCredential(JSON.stringify({ claudeAiOauth: { accessToken: 'ok', expiresAt: 1 } })).refreshToken, null);
});
