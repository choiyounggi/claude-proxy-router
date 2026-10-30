// macOS Keychain access through /usr/bin/security, the same items Claude Code reads and writes.
import { spawn } from 'node:child_process';
import os from 'node:os';

export const SECURITY_BIN = '/usr/bin/security';
// `security -i` reads one command line into a fixed buffer; a longer line is cut, so writes refuse it.
export const SECURITY_STDIN_MAX = 4032;
const ACCOUNT_RE = /^[a-zA-Z0-9._-]+$/;
const SERVICE_RE = /^Claude Code-credentials(-[0-9a-f]{8})?$/;
const TIMEOUT_MS = 10_000;

/** The `-a` account name Claude Code stores its credentials item under ($USER first, like Claude Code). */
export function keychainAccount(env = process.env) {
  let name = env.USER;
  if (!name) {
    try { name = os.userInfo().username; } catch { name = ''; }
  }
  return ACCOUNT_RE.test(name) ? name : 'claude-code-user';
}

function checkNames(service, account) {
  if (!SERVICE_RE.test(service) || !ACCOUNT_RE.test(account)) throw new Error('bad keychain item name');
}

/** Run `security` with optional stdin; resolves {code, stdout}. Output never reaches logs or errors. */
export function runSecurity(args, { input = null, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(SECURITY_BIN, args, { stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
    } catch {
      resolve({ code: -1, stdout: '' });
      return;
    }
    const chunks = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, stdout: '' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: Buffer.concat(chunks).toString('utf8') });
    });
    if (input !== null) child.stdin.end(input, 'ascii');
  });
}

/** The item's stored text (one trailing newline removed), or null on any failure. */
export async function readItem(service, account, run = runSecurity) {
  checkNames(service, account);
  const r = await run(['find-generic-password', '-a', account, '-s', service, '-w']);
  if (r.code !== 0 || typeof r.stdout !== 'string') return null;
  return r.stdout.endsWith('\n') ? r.stdout.slice(0, -1) : r.stdout;
}

/** The `security -i` stdin line that upserts the item with hex-encoded secret text. */
export function addLine(service, account, secret) {
  checkNames(service, account);
  return `add-generic-password -U -a "${account}" -s "${service}" -X "${Buffer.from(secret, 'utf8').toString('hex')}"\n`;
}

/** Upsert the item through `security -i` stdin (never argv); true only on exit 0. */
export async function writeItem(service, account, secret, run = runSecurity) {
  const line = addLine(service, account, secret);
  if (line.length > SECURITY_STDIN_MAX) return false;
  const r = await run(['-i'], { input: line });
  return r.code === 0;
}
