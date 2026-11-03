import test from 'node:test';
import assert from 'node:assert/strict';
import { bumpVersion, classifyCommit, compareVersions, planRelease, renderNotes } from '../scripts/release.mjs';

const commit = (subject, body = '', hash = 'abcdef1234567890') => ({ hash, subject, body });

test('classifyCommit maps conventional types to bumps', () => {
  assert.equal(classifyCommit(commit('feat: report routing decisions')).bump, 'minor');
  assert.equal(classifyCommit(commit('fix(test): list test files')).bump, 'patch');
  assert.equal(classifyCommit(commit('docs: typo')).bump, 'none');
  assert.equal(classifyCommit(commit('ci: cache npm')).bump, 'none');
});

test('classifyCommit treats ! and BREAKING CHANGE as major, and an unconventional message as a patch', () => {
  assert.equal(classifyCommit(commit('feat!: drop node 18')).bump, 'major');
  assert.equal(classifyCommit(commit('refactor: config', 'BREAKING CHANGE: new path')).bump, 'major');
  assert.deepEqual(classifyCommit(commit('Update stuff')), { type: null, bump: 'patch', title: 'Update stuff' });
});

test('classifyCommit releases nothing for a merge commit, whatever it merges', () => {
  assert.equal(classifyCommit(commit('Merge pull request #12 from someone/feature')).bump, 'none');
  assert.equal(classifyCommit(commit("Merge branch 'main' into topic")).bump, 'none');
  assert.equal(classifyCommit(commit("Merge remote-tracking branch 'origin/main'")).bump, 'none');
  // Only the merge itself is ignored: the merged commits are listed and classified on their own.
  assert.equal(classifyCommit(commit('Merged the parser: faster')).bump, 'patch');
});

test('versions bump, compare numerically and refuse malformed input', () => {
  assert.equal(bumpVersion('0.2.0', 'patch'), '0.2.1');
  assert.equal(bumpVersion('0.2.3', 'minor'), '0.3.0');
  assert.equal(bumpVersion('0.2.3', 'major'), '1.0.0');
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.throws(() => bumpVersion('0.2', 'patch'), /not a release version/);
  assert.throws(() => bumpVersion('0.2.0', 'huge'), /unknown bump/);
});

test('planRelease takes the highest bump since the last tag', () => {
  const plan = planRelease({
    previousTag: 'v0.2.0',
    packageVersion: '0.2.0',
    commits: [commit('fix: one'), commit('feat: two'), commit('docs: three')],
  });
  assert.deepEqual([plan.release, plan.version, plan.bump], [true, '0.3.0', 'minor']);
});

test('planRelease skips non-releasing commits, merge commits and an empty range', () => {
  const quiet = planRelease({ previousTag: 'v0.2.0', packageVersion: '0.2.0',
    commits: [commit('chore: sync formula copy'), commit('ci: add release job'), commit('chore(release): v0.2.0'),
      commit('Merge pull request #3 from choiyounggi/ci'), commit("Merge branch 'main' of github.com:choiyounggi/claude-proxy-router")] });
  assert.deepEqual([quiet.release, quiet.version], [false, '0.2.0']);
  assert.equal(planRelease({ previousTag: 'v0.2.0', packageVersion: '0.2.0', commits: [] }).release, false);
});

test('planRelease honors a version raised by hand, and releases package.json without a tag', () => {
  assert.equal(planRelease({ previousTag: 'v0.2.0', packageVersion: '1.0.0', commits: [commit('fix: x')] }).version, '1.0.0');
  assert.deepEqual(planRelease({ previousTag: null, packageVersion: '0.2.0', commits: [] }).version, '0.2.0');
});

test('renderNotes groups changes and links the compare view', () => {
  const plan = planRelease({ previousTag: 'v0.2.0', packageVersion: '0.2.0', commits: [commit('feat: a'), commit('fix: b')] });
  const notes = renderNotes(plan);
  assert.match(notes, /## Features\n\n- a \(abcdef1\)/);
  assert.match(notes, /## Fixes and other changes\n\n- b \(abcdef1\)/);
  assert.match(notes, /compare\/v0\.2\.0\.\.\.v0\.3\.0/);
  assert.match(renderNotes({ version: '0.2.0', previous: null, commits: [] }), /Initial release\./);
});
