import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { plist, stableNode, LABEL } from '../src/launchd.js';
import { launcherPath } from '../src/cli.js';
import { scratch } from './helpers.js';

test('plist escapes paths, keeps the agent alive with a throttle, and carries no secret', () => {
  const p = plist({ node: '/n/node', script: '/a&b/<x>.js', configFile: '/c/config.json', logDir: '/l', pathEnv: '/usr/bin' });
  assert.ok(p.includes(`<string>${LABEL}</string>`));
  assert.ok(p.includes('<string>/a&amp;b/&lt;x&gt;.js</string>'));
  assert.ok(p.includes('<key>ThrottleInterval</key>'));
  assert.ok(p.includes('<string>start</string>'));
  assert.ok(!/cpr_/.test(p));
});

test('stableNode prefers a PATH symlink to the same node binary, else the exec path', (t) => {
  const dir = scratch(t);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  assert.equal(stableNode(`/nonexistent:${bin}`), path.join(bin, 'node'));
  assert.equal(stableNode('/nonexistent'), process.execPath);
  assert.equal(stableNode(''), process.execPath);
});

test('launcherPath keeps the invoked path and falls back to the repo script', () => {
  assert.equal(launcherPath(process.argv[1]), process.argv[1]);
  assert.match(launcherPath('/nonexistent/claude-proxy-router'), /bin\/claude-proxy-router\.js$/);
  assert.match(launcherPath(null), /bin\/claude-proxy-router\.js$/);
});
