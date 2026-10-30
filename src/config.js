// Router config: one JSON object, mode 0600, written by `onboard`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { PROFILES_ROOT_DEFAULT } from './accounts.js';

export const STATE_DIR = path.join(os.homedir(), 'Library/Application Support/claude-proxy-router');
export const CONFIG_PATH_DEFAULT = path.join(STATE_DIR, 'config.json');
export const LOG_DIR = path.join(os.homedir(), 'Library/Logs/claude-proxy-router');
export const DEFAULT_PORT = 18787;

export const DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: DEFAULT_PORT,
  routerKey: null,
  upstream: 'https://api.anthropic.com',
  usagePollS: 60,
  limitPct: 100,
  tokenRefresh: true,
  includeDefaultAccount: true,
  profilesRoot: PROFILES_ROOT_DEFAULT,
});

export class ConfigError extends Error {}

export function configPath(env = process.env) {
  return env.CLAUDE_PROXY_ROUTER_CONFIG || CONFIG_PATH_DEFAULT;
}

export function generateKey() {
  return `cpr_${randomBytes(24).toString('base64url')}`;
}

/** Validate a decoded object against DEFAULTS; the message starts with the offending key. */
export function parseConfig(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new ConfigError('config: must be a JSON object');
  for (const k of Object.keys(obj)) if (!(k in DEFAULTS)) throw new ConfigError(`${k}: unknown key`);
  const c = { ...DEFAULTS, ...obj };
  if (typeof c.host !== 'string' || c.host === '') throw new ConfigError('host: must be a non-empty string');
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) throw new ConfigError('port: must be an integer 1-65535');
  if (c.routerKey !== null && (typeof c.routerKey !== 'string' || c.routerKey.length < 16)) {
    throw new ConfigError('routerKey: must be a string of at least 16 characters');
  }
  try {
    const u = new URL(c.upstream);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
  } catch {
    throw new ConfigError('upstream: must be an http(s) URL');
  }
  if (typeof c.usagePollS !== 'number' || !(c.usagePollS >= 15)) throw new ConfigError('usagePollS: must be a number >= 15');
  if (typeof c.limitPct !== 'number' || !(c.limitPct > 0 && c.limitPct <= 100)) throw new ConfigError('limitPct: must be a number in (0, 100]');
  for (const k of ['tokenRefresh', 'includeDefaultAccount']) {
    if (typeof c[k] !== 'boolean') throw new ConfigError(`${k}: must be true or false`);
  }
  if (typeof c.profilesRoot !== 'string' || !path.isAbsolute(c.profilesRoot)) throw new ConfigError('profilesRoot: must be an absolute path');
  return c;
}

/** The config at `file`; null when the file does not exist. */
export function loadConfig(file = configPath()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new ConfigError(`${file}: unreadable (${e.code})`);
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new ConfigError(`${file}: not valid JSON`);
  }
  return parseConfig(obj);
}

/** Write atomically with mode 0600 (it holds the router key). */
export function saveConfig(config, file = configPath()) {
  const c = parseConfig(config);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(c, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return c;
}
