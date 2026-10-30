// Shared test helpers. Scratch dirs live inside the repo (.claude/tmp), never in the system temp dir.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function scratch(t) {
  const dir = path.join(ROOT, '.claude', 'tmp', `t-${randomBytes(6).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake upstream: `handle(req, body, res)`; resolves `{url, close, calls}`. */
export async function fakeUpstream(t, handle) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      calls.push({ method: req.method, url: req.url, headers: req.headers, body });
      handle(req, body, res, calls.length);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return { url: `http://127.0.0.1:${server.address().port}`, calls };
}

export function account(id, extra = {}) {
  return { id, kind: 'orca', configDir: `/x/${id}/home`, keychainService: 'Claude Code-credentials-00000000',
    claudeJson: `/x/${id}/home/.claude.json`, identity: { organizationName: null }, label: id, ...extra };
}

export function credJson(token, expiresAtMs, extra = {}) {
  return JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `rt-${token}`, expiresAt: expiresAtMs, ...extra } });
}
