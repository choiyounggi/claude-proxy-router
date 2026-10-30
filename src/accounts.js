// Discover the Claude accounts logged in on this Mac: Orca's folder-based profiles plus the default ~/.claude login.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROFILES_ROOT_DEFAULT = path.join(os.homedir(), 'Library/Application Support/orca/claude-profiles');
export const DEFAULT_CONFIG_DIR = path.join(os.homedir(), '.claude');
const SERVICE_PREFIX = 'Claude Code-credentials';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Header-safe printable ASCII: anything else could break or leak through an HTTP header.
const TOKEN_RE = /^[\x21-\x7e]{1,4096}$/;

/** Claude Code hashes the config dir string exactly as given (no normalisation). */
export function keychainServiceFor(configDir) {
  return `${SERVICE_PREFIX}-${createHash('sha256').update(configDir, 'utf8').digest('hex').slice(0, 8)}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Identity fields from a `.claude.json`; every field may be null. */
export function readIdentity(claudeJsonPath) {
  const data = readJson(claudeJsonPath);
  const a = data && typeof data === 'object' && data.oauthAccount && typeof data.oauthAccount === 'object'
    ? data.oauthAccount : {};
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    email: str(a.emailAddress),
    displayName: str(a.displayName),
    accountUuid: str(a.accountUuid),
    organizationUuid: str(a.organizationUuid),
    organizationName: str(a.organizationName),
  };
}

/** Short display name: email local part, else display name, else the first 8 chars of the id. */
export function labelOf(identity, id) {
  if (identity.email) return identity.email.split('@')[0];
  if (identity.displayName) return identity.displayName;
  return id.slice(0, 8);
}

function makeAccount(id, kind, configDir, keychainService, claudeJson) {
  const identity = readIdentity(claudeJson);
  return { id, kind, configDir, keychainService, claudeJson, identity, label: labelOf(identity, id) };
}

/** Orca profiles under `root` whose profile.json names the folder, sorted by id. Never throws. */
export function discoverOrcaProfiles(root = PROFILES_ROOT_DEFAULT) {
  // A trailing slash would change every config dir string and therefore every Keychain service name.
  const base = root.replace(/\/+$/, '') || '/';
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    if (!UUID_RE.test(name)) continue;
    const home = path.join(base, name, 'home');
    try {
      if (!fs.statSync(home).isDirectory()) continue;
    } catch {
      continue;
    }
    const profile = readJson(path.join(base, name, 'profile.json'));
    if (!profile || profile.accountId !== name) continue;
    out.push(makeAccount(name, 'orca', home, keychainServiceFor(home), path.join(home, '.claude.json')));
  }
  return out;
}

/** The default login (no CLAUDE_CONFIG_DIR): Keychain item without a hash suffix, identity in ~/.claude.json. */
export function defaultAccount(home = os.homedir()) {
  const claudeJson = path.join(home, '.claude.json');
  const configDir = path.join(home, '.claude');
  return makeAccount('default', 'default', configDir, SERVICE_PREFIX, claudeJson);
}

/**
 * Every account to route over. The default login is dropped when an Orca profile is the same seat
 * (same account and organization), so one seat is never counted twice.
 */
export function discoverAccounts({ profilesRoot = PROFILES_ROOT_DEFAULT, includeDefault = true, home } = {}) {
  const list = discoverOrcaProfiles(profilesRoot);
  if (includeDefault) {
    const d = defaultAccount(home);
    const seat = (a) => (a.identity.accountUuid ? `${a.identity.accountUuid}/${a.identity.organizationUuid}` : null);
    const key = seat(d);
    if (!(key && list.some((a) => seat(a) === key))) list.push(d);
  }
  return list;
}

/**
 * Parse a Keychain item's JSON into the OAuth fields the router needs; null when unusable.
 * The returned object holds secrets: never log it.
 */
export function parseCredential(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = doc && typeof doc === 'object' ? doc.claudeAiOauth : null;
  if (!o || typeof o !== 'object') return null;
  if (typeof o.accessToken !== 'string' || !TOKEN_RE.test(o.accessToken)) return null;
  if (typeof o.expiresAt !== 'number' || !Number.isFinite(o.expiresAt)) return null;
  const refreshToken = typeof o.refreshToken === 'string' && TOKEN_RE.test(o.refreshToken) ? o.refreshToken : null;
  return { doc, oauth: o, accessToken: o.accessToken, refreshToken, expiresAtMs: o.expiresAt };
}
