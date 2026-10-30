// OAuth token refresh for an account, the way Claude Code does it, written back to the same Keychain item.
// Mutual exclusion with Claude Code and claude-account-rotator: Claude Code's own lock dirs
// (<config dir>/.oauth_refresh.lock and the legacy <realpath(config dir)>.lock), taken without waiting.
import fs from 'node:fs';
import { request } from './http.js';
import { parseCredential } from './accounts.js';
import { readItem, writeItem, addLine, SECURITY_STDIN_MAX } from './keychain.js';

export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// The token endpoint's edge answers 403 to library default agents.
const USER_AGENT = 'claude-proxy-router/0.1';
export const EXPIRY_MARGIN_MS = 5 * 60_000;
const CC_LOCK_STALE_MS = 60_000;
const WRITE_ATTEMPTS = 3;
const PAYLOAD_MARGIN = 800;
const BASE_SCOPES = ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers',
  'user:file_upload', 'user:plugins'];
const PROJECT_SCOPES = ['user:projects:read', 'user:projects:write'];

/** The scope list Claude Code sends for a stored `claudeAiOauth` object. */
export function requestScopes(oauth) {
  const stored = Array.isArray(oauth.scopes) ? oauth.scopes.filter((s) => typeof s === 'string') : [];
  const hasCid = typeof oauth.clientId === 'string' && oauth.clientId !== '';
  const sub = typeof oauth.subscriptionType === 'string' && oauth.subscriptionType !== '';
  if ((stored.includes('user:inference') || sub) && !hasCid) {
    return [...new Set([...BASE_SCOPES, ...stored.filter((s) => PROJECT_SCOPES.includes(s))])];
  }
  return stored;
}

/** Validated token set from a 200 body, or null. */
export function parseTokenResponse(body, nowMs, postedRefreshToken) {
  let o;
  try {
    o = JSON.parse(body);
  } catch {
    return null;
  }
  const tok = /^[\x21-\x7e]{1,4096}$/;
  if (!o || typeof o.access_token !== 'string' || !tok.test(o.access_token)) return null;
  if (typeof o.expires_in !== 'number' || !(o.expires_in > 0) || !Number.isFinite(o.expires_in)) return null;
  let refreshToken = postedRefreshToken;
  if ('refresh_token' in o) {
    if (typeof o.refresh_token !== 'string' || !tok.test(o.refresh_token)) return null;
    refreshToken = o.refresh_token;
  }
  const rexp = typeof o.refresh_token_expires_in === 'number' && o.refresh_token_expires_in > 0
    ? nowMs + Math.trunc(o.refresh_token_expires_in * 1000) : null;
  const scopes = typeof o.scope === 'string' ? o.scope.split(' ').filter(Boolean) : null;
  return { accessToken: o.access_token, refreshToken, expiresAtMs: nowMs + Math.trunc(o.expires_in * 1000),
    refreshExpiresAtMs: rexp, scopes: scopes && scopes.length ? scopes : null };
}

/** The stored document with only the token, expiry and scope fields of `claudeAiOauth` replaced. */
export function buildDocument(doc, t) {
  const inner = { ...doc.claudeAiOauth, accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAtMs };
  if (t.refreshExpiresAtMs !== null) inner.refreshTokenExpiresAt = t.refreshExpiresAtMs;
  if (t.scopes && t.scopes.includes('user:inference')) inner.scopes = [...t.scopes];
  return { ...doc, claudeAiOauth: inner };
}

function dirId(p) {
  try {
    const st = fs.statSync(p);
    return `${st.ino}:${st.birthtimeMs}`;
  } catch {
    return null;
  }
}

/** One non-blocking attempt at Claude Code's lock dirs: `{lock}` or `{reason: 'cc_lock_busy'}`. */
export function takeCcLock(configDir, nowMs = Date.now()) {
  let real = configDir;
  try { real = fs.realpathSync(configDir); } catch { /* the dir may not exist yet: use it as given */ }
  const wanted = [`${configDir}/.oauth_refresh.lock`, `${real}.lock`];
  const made = [];
  const release = () => {
    // A dir Claude Code judged stale and recreated is someone else's lock now: leave it.
    for (const [d, id] of made.reverse()) {
      if (id !== null && dirId(d) === id) {
        try { fs.rmdirSync(d); } catch { /* already gone */ }
      }
    }
    made.length = 0;
  };
  const mk = (d) => {
    try {
      fs.mkdirSync(d);
      return null;
    } catch (e) {
      return e.code;
    }
  };
  for (const d of wanted) {
    let code = mk(d);
    if (code === 'EEXIST') {
      // Claude Code itself treats a lock dir untouched for 60 s as abandoned and takes it over; a dir left by
      // a crash would otherwise block every refresh of an account no Claude session runs on. rmdir only
      // removes an empty dir, so a lock holding anything is left alone.
      try {
        if (nowMs - fs.statSync(d).mtimeMs > CC_LOCK_STALE_MS) {
          fs.rmdirSync(d);
          code = mk(d);
        }
      } catch { /* changed meanwhile: busy for this attempt */ }
    }
    if (code !== null) {
      release();
      return { reason: 'cc_lock_busy' };
    }
    made.push([d, dirId(d)]);
  }
  const touch = () => {
    for (const [d] of made) {
      try { fs.utimesSync(d, new Date(), new Date()); } catch { /* best effort */ }
    }
  };
  return { lock: { touch, release } };
}

async function postRefresh(oauth, refreshToken, scopes, post) {
  const cid = typeof oauth.clientId === 'string' && oauth.clientId ? oauth.clientId : CLIENT_ID;
  const body = JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: cid, scope: scopes.join(' ') });
  return post(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': USER_AGENT },
    body,
    timeoutMs: 15_000,
  });
}

function oauthError(body) {
  try {
    const e = JSON.parse(body)?.error;
    return typeof e === 'string' && /^[a-z0-9_]{1,64}$/.test(e) ? e : null;
  } catch {
    return null;
  }
}

/**
 * Refresh `account`'s token when it expires within 5 minutes. Resolves `{state, reason?, credential?}`:
 * `fresh` (someone else already refreshed; `credential` is the new one), `refreshed`, `skipped`
 * (retry later), `failed` (back off) or `stopped` (needs a re-login; do not retry until the item changes).
 */
export async function refreshAccount(account, keychainAccount, deps = {}, { rejectedToken = null } = {}) {
  const read = deps.readItem ?? readItem;
  const write = deps.writeItem ?? writeItem;
  const post = deps.post ?? request;
  const lockFn = deps.takeCcLock ?? takeCcLock;
  const now = deps.now ?? Date.now;
  const svc = account.keychainService;

  const taken = lockFn(account.configDir, now());
  if (!taken.lock) return { state: 'skipped', reason: taken.reason };
  const { lock } = taken;
  try {
    lock.touch();
    const raw = await read(svc, keychainAccount);
    const cred = parseCredential(raw);
    if (!cred) return { state: 'skipped', reason: 'no_credential' };
    // A token the API refused (401) is refreshed even before it expires.
    if (cred.expiresAtMs - EXPIRY_MARGIN_MS > now() && cred.accessToken !== rejectedToken) {
      return { state: 'fresh', credential: cred };
    }
    if (!cred.refreshToken) return { state: 'stopped', reason: 'no_refresh_token' };
    if (addLine(svc, keychainAccount, raw).length + PAYLOAD_MARGIN > SECURITY_STDIN_MAX) {
      return { state: 'stopped', reason: 'payload_too_large' };
    }
    // Probe the exact write path before the refresh token is spent: a refused write after the
    // refresh would leave only a dead refresh token in the Keychain.
    lock.touch();
    if (!(await write(svc, keychainAccount, raw)) || (await read(svc, keychainAccount)) !== raw) {
      return { state: 'failed', reason: 'keychain_write_unavailable' };
    }
    lock.touch();
    let res;
    try {
      res = await postRefresh(cred.oauth, cred.refreshToken, requestScopes(cred.oauth), post);
    } catch (e) {
      // Only a failure before the connection opened is safe to retry (DNS, refused, unreachable, connect
      // timeout); once connected the server may have rotated the token already.
      return e && e.requestSent === false ? { state: 'failed', reason: 'network_error' } : { state: 'stopped', reason: 'outcome_unknown' };
    }
    const text = res.body.toString('utf8');
    const err = oauthError(text);
    if (res.status === 200) {
      const tokens = parseTokenResponse(text, now(), cred.refreshToken);
      if (!tokens) return { state: 'stopped', reason: 'malformed_response' };
      const next = JSON.stringify(buildDocument(cred.doc, tokens));
      const credential = parseCredential(next);
      for (let i = 0; i < WRITE_ATTEMPTS; i += 1) {
        lock.touch();
        if ((await write(svc, keychainAccount, next)) && (await read(svc, keychainAccount)) === next) {
          return { state: 'refreshed', credential };
        }
      }
      // The new set lives only in memory now: the caller keeps using it and retries the write.
      return { state: 'refreshed', reason: 'write_failed', credential, pendingWrite: next };
    }
    if ((res.status === 400 || res.status === 401) && err === 'invalid_grant') return { state: 'stopped', reason: 'invalid_grant' };
    if (res.status === 400 && err === 'invalid_scope') return { state: 'stopped', reason: 'invalid_scope' };
    if (res.status === 429) return { state: 'failed', reason: 'rate_limited' };
    if (res.status >= 500 || (res.status === 403 && err === null)) return { state: 'failed', reason: 'server_error' };
    return { state: 'stopped', reason: 'rejected' };
  } finally {
    lock.release();
  }
}
