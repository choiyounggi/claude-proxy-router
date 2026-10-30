// Account usage: the OAuth usage API, Claude Code's cached copy, and the rate-limit headers of proxied answers.
import fs from 'node:fs';
import { request } from './http.js';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const OAUTH_BETA = 'oauth-2025-04-20';
const USAGE_TIMEOUT_MS = 10_000;

function clampPct(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : null;
}

function parseTime(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** `{utilization, resetsAt}` (percent, epoch ms or null) from one usage window object, or null. */
export function parseWindow(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const u = clampPct(obj.utilization);
  return u === null ? null : { utilization: u, resetsAt: parseTime(obj.resets_at) };
}

/** The Fable weekly_scoped window from `limits[]` (highest one), or null. */
export function parseFable(obj) {
  if (!obj || !Array.isArray(obj.limits)) return null;
  let best = null;
  for (const item of obj.limits) {
    if (!item || item.kind !== 'weekly_scoped') continue;
    const name = item.scope?.model?.display_name;
    if (typeof name !== 'string' || name.trim().toLowerCase() !== 'fable') continue;
    const p = clampPct(item.percent);
    if (p === null) continue;
    if (!best || p > best.utilization) best = { utilization: p, resetsAt: parseTime(item.resets_at) };
  }
  return best;
}

/** `{fiveHour, sevenDay, fable}` from a usage response body object; null when neither 5h nor 7d is usable. */
export function parseUsage(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const fiveHour = parseWindow(obj.five_hour);
  const sevenDay = parseWindow(obj.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay, fable: parseFable(obj) };
}

/** Seconds from a Retry-After value (delay-seconds or HTTP-date), or null. */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) return null;
  const v = value.trim();
  if (/^[0-9]{1,10}$/.test(v)) return Number(v);
  if (!/[A-Za-z]/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, (t - nowMs) / 1000) : null;
}

/**
 * Live usage for one access token: `{ok:true, usage}` or `{ok:false, status, retryAfterS}`.
 * One request, no redirects, never throws.
 */
export async function fetchUsage(accessToken, { url = USAGE_URL, timeoutMs = USAGE_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = await request(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}`, 'anthropic-beta': OAUTH_BETA, accept: 'application/json' },
      timeoutMs,
    });
  } catch {
    return { ok: false, status: 0, retryAfterS: null };
  }
  if (res.status !== 200) {
    return { ok: false, status: res.status, retryAfterS: res.status === 429 ? parseRetryAfter(res.headers['retry-after']) : null };
  }
  let obj;
  try {
    obj = JSON.parse(res.body.toString('utf8'));
  } catch {
    return { ok: false, status: 200, retryAfterS: null };
  }
  const usage = parseUsage(obj);
  return usage ? { ok: true, usage } : { ok: false, status: 200, retryAfterS: null };
}

/** Claude Code's cached usage in `.claude.json` (`cachedUsageUtilization`): `{usage, fetchedAt}` or null. */
export function readCachedUsage(claudeJsonPath) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  } catch {
    return null;
  }
  const c = data?.cachedUsageUtilization;
  if (!c || typeof c.fetchedAtMs !== 'number' || !Number.isFinite(c.fetchedAtMs)) return null;
  const usage = parseUsage(c.utilization);
  return usage ? { usage, fetchedAt: c.fetchedAtMs } : null;
}

const H = 'anthropic-ratelimit-unified-';

function headerNum(headers, name) {
  const v = headers[name];
  if (typeof v !== 'string' || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * What the unified rate-limit headers of an Anthropic answer say about the account, or null when the
 * limiter did not run. Utilization headers are fractions 0..1, reset headers epoch seconds (Claude Code's
 * reading of them, 2.1.314).
 */
export function parseUnifiedHeaders(headers) {
  const status = headers[`${H}status`];
  if (typeof status !== 'string') return null;
  const win = (key) => {
    const u = headerNum(headers, `${H}${key}-utilization`);
    const r = headerNum(headers, `${H}${key}-reset`);
    // Rounded to 0.01 so 0.55 reads 55, not 55.00000000000001.
    const pct = Math.round(Math.min(1, Math.max(0, u)) * 10_000) / 100;
    return u === null ? null : { utilization: pct, resetsAt: r === null ? null : r * 1000 };
  };
  const reset = headerNum(headers, `${H}reset`);
  return {
    status,
    claim: typeof headers[`${H}representative-claim`] === 'string' ? headers[`${H}representative-claim`] : null,
    resetAt: reset === null ? null : reset * 1000,
    fiveHour: win('5h'),
    sevenDay: win('7d'),
  };
}
