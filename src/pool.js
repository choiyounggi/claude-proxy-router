// The account pool: keeps every account's token and usage warm in the background so a request can be
// routed to the account with the most headroom without waiting on any check.
import { discoverAccounts, parseCredential } from './accounts.js';
import { keychainAccount as defaultKeychainAccount, readItem, writeItem } from './keychain.js';
import { fetchUsage, readCachedUsage } from './usage.js';
import { refreshAccount, EXPIRY_MARGIN_MS } from './refresh.js';

const BACKOFF_MAX_MS = 15 * 60_000;
const REFRESH_BACKOFF_START_MS = 5 * 60_000;
const REFRESH_BACKOFF_MAX_MS = 60 * 60_000;
// A 429 without a usable reset time keeps the account out for this long.
const LIMITED_FALLBACK_MS = 5 * 60_000;

/** A window past its reset time counts 0; a missing window counts nothing. */
function windowPct(w, nowMs) {
  if (!w) return null;
  if (w.resetsAt !== null && w.resetsAt <= nowMs) return 0;
  return w.utilization;
}

/** The account's load: max over 5h and 7d (and the Fable window for a Fable request); null when unknown. */
export function scoreOf(usage, nowMs, { fable = false } = {}) {
  if (!usage) return null;
  const parts = [usage.fiveHour, usage.sevenDay, ...(fable ? [usage.fable] : [])]
    .map((w) => windowPct(w, nowMs))
    .filter((v) => v !== null);
  if (fable && windowPct(usage.fable, nowMs) === null) return null;
  return parts.length ? Math.max(...parts) : null;
}

export function isFableModel(model) {
  return typeof model === 'string' && model.toLowerCase().includes('fable');
}

/** When a full account frees up again: the reset of the windows at or above `limitPct`. */
function freeAt(usage, nowMs, limitPct, fable) {
  const resets = [usage?.fiveHour, usage?.sevenDay, ...(fable ? [usage?.fable] : [])]
    .filter((w) => w && windowPct(w, nowMs) !== null && windowPct(w, nowMs) >= limitPct && w.resetsAt !== null)
    .map((w) => w.resetsAt);
  return resets.length ? Math.max(...resets) : null;
}

export class Pool {
  /**
   * @param {object} opts
   * @param {object} [opts.config] router config (usagePollS, limitPct, profilesRoot, includeDefaultAccount, tokenRefresh)
   * @param {object} [opts.deps] seams for tests: discover, readItem, writeItem, fetchUsage, readCachedUsage, refresh, now, log
   */
  constructor({ config = {}, deps = {} } = {}) {
    this.pollMs = Math.max(15, config.usagePollS ?? 60) * 1000;
    this.limitPct = config.limitPct ?? 100;
    this.tokenRefresh = config.tokenRefresh ?? true;
    this.discover = deps.discover ?? (() => discoverAccounts({
      profilesRoot: config.profilesRoot, includeDefault: config.includeDefaultAccount ?? true,
    }));
    this.readItem = deps.readItem ?? readItem;
    this.writeItem = deps.writeItem ?? writeItem;
    this.fetchUsage = deps.fetchUsage ?? fetchUsage;
    this.readCachedUsage = deps.readCachedUsage ?? readCachedUsage;
    this.refresh = deps.refresh ?? refreshAccount;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.kcAccount = deps.keychainAccount ?? defaultKeychainAccount();
    /** @type {Map<string, object>} id -> state */
    this.states = new Map();
    this.timer = null;
    this.ticking = null;
  }

  _state(account) {
    let s = this.states.get(account.id);
    if (!s) {
      s = { account, credential: null, rawFingerprint: null, usage: null, usageSource: null, usageAt: null,
        usageError: null, nextUsageAt: 0, usageIntervalMs: this.pollMs, limitedUntil: 0, limitReason: null,
        lastRejection: null, refresh: { state: null, reason: null, at: null, nextAt: 0, stoppedRaw: null },
        pending: null, keychainCredential: null, tokenError: null, rejectedToken: null };
      this.states.set(account.id, s);
    }
    s.account = account;
    return s;
  }

  /** Re-read an account's Keychain item; picks up refreshes done by Claude Code or the rotator. */
  async loadCredential(s) {
    const raw = await this.readItem(s.account.keychainService, this.kcAccount);
    const cred = parseCredential(raw);
    if (s.pending !== null) {
      // A rotated set whose write failed lives only here (its old refresh token is already spent):
      // it stays until the Keychain holds it or something newer.
      if (cred && cred.expiresAtMs >= s.pending.credential.expiresAtMs) {
        s.pending = null;
      } else {
        if (s.pending.credential.accessToken !== s.rejectedToken) s.credential = s.pending.credential;
        return;
      }
    }
    if (!cred) {
      // A failed read keeps a token already held: one `security` hiccup must not take the account out.
      s.tokenError = raw === null ? 'no_credential' : 'bad_credential';
      return;
    }
    s.keychainCredential = cred;
    s.rawFingerprint = raw;
    // A new item (re-login or someone else's refresh) lifts a stop.
    if (s.refresh.stoppedRaw !== null && s.refresh.stoppedRaw !== raw) {
      s.refresh = { state: null, reason: null, at: null, nextAt: 0, stoppedRaw: null };
    }
    // A token the API already refused stays out until the item holds another one or a refresh replaces it.
    if (cred.accessToken === s.rejectedToken) {
      s.credential = null;
      s.tokenError = 'rejected_401';
      return;
    }
    s.rejectedToken = null;
    s.credential = cred;
    s.tokenError = null;
  }

  async _maybeRefresh(s) {
    const now = this.now();
    if (!this.tokenRefresh) return;
    if (s.pending !== null) {
      if (await this.writeItem(s.account.keychainService, this.kcAccount, s.pending.raw)) {
        this.log('info', `token_write_recovered account=${s.account.id}`);
        s.pending = null;
      }
      return;
    }
    // A 401-refused token is refreshed even before it expires: the refresh token may still be good.
    const rejected = s.credential === null && s.rejectedToken !== null && s.keychainCredential !== null;
    if (!s.credential && !rejected) return;
    if (!rejected && s.credential.expiresAtMs - EXPIRY_MARGIN_MS > now) return;
    if (s.refresh.stoppedRaw !== null || s.refresh.nextAt > now) return;
    const r = await this.refresh(s.account, this.kcAccount, undefined, { rejectedToken: rejected ? s.rejectedToken : null });
    s.refresh.state = r.state;
    s.refresh.reason = r.reason ?? null;
    s.refresh.at = now;
    if (r.credential && r.credential.accessToken !== s.rejectedToken) {
      s.credential = r.credential;
      s.rejectedToken = null;
      s.tokenError = null;
    }
    if (r.pendingWrite) {
      s.pending = { raw: r.pendingWrite, credential: r.credential };
      this.log('error', `token_write_failed account=${s.account.id} (new tokens held in memory, write retried)`);
    }
    if (r.state === 'stopped') s.refresh.stoppedRaw = s.rawFingerprint ?? '';
    if (r.state === 'failed') {
      const prev = s.refresh.backoffMs ?? 0;
      s.refresh.backoffMs = Math.min(REFRESH_BACKOFF_MAX_MS, prev ? prev * 2 : REFRESH_BACKOFF_START_MS);
      s.refresh.nextAt = now + s.refresh.backoffMs;
    } else {
      s.refresh.backoffMs = 0;
    }
    this.log('info', `token_refresh account=${s.account.id} state=${r.state} reason=${r.reason ?? '-'}`);
  }

  async _maybeUsage(s) {
    const now = this.now();
    if (s.nextUsageAt > now) return;
    const usable = s.credential && s.credential.expiresAtMs > now;
    const r = usable ? await this.fetchUsage(s.credential.accessToken) : { ok: false, status: -1, retryAfterS: null };
    if (r.ok) {
      s.usage = r.usage;
      s.usageSource = 'live';
      s.usageAt = now;
      s.usageError = null;
      s.usageIntervalMs = this.pollMs;
    } else {
      s.usageError = r.status === -1 ? 'token_unusable' : r.status === 0 ? 'network' : `http_${r.status}`;
      // The last live reading stays unless Claude Code's own cache is newer.
      const cached = this.readCachedUsage(s.account.claudeJson);
      if (cached && (s.usageAt === null || cached.fetchedAt > s.usageAt)) {
        s.usage = cached.usage;
        s.usageSource = 'cache';
        s.usageAt = cached.fetchedAt;
      }
      if (r.status === 429) {
        s.usageIntervalMs = r.retryAfterS !== null
          ? Math.max(this.pollMs, Math.min(BACKOFF_MAX_MS, r.retryAfterS * 1000))
          : Math.min(BACKOFF_MAX_MS, s.usageIntervalMs * 2);
      } else {
        s.usageIntervalMs = this.pollMs;
      }
    }
    s.nextUsageAt = now + s.usageIntervalMs;
  }

  /** One background pass: discover accounts, re-read tokens, refresh expiring ones, poll due usage. */
  async tick() {
    if (this.ticking) return this.ticking;
    this.ticking = (async () => {
      let accounts;
      try {
        accounts = this.discover();
      } catch (e) {
        this.log('error', `discover_failed ${e?.message ?? e}`);
        return;
      }
      const ids = new Set(accounts.map((a) => a.id));
      for (const id of [...this.states.keys()]) if (!ids.has(id)) this.states.delete(id);
      await Promise.all(accounts.map(async (a) => {
        const s = this._state(a);
        try {
          await this.loadCredential(s);
          await this._maybeRefresh(s);
          await this._maybeUsage(s);
        } catch (e) {
          this.log('error', `tick_failed account=${a.id} ${e?.message ?? e}`);
        }
      }));
    })().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  /** Start background checks every `intervalMs`; the first pass runs now and is awaited. */
  async start(intervalMs = 10_000) {
    await this.tick();
    this.timer = setInterval(() => { this.tick(); }, intervalMs);
    this.timer.unref?.();
  }

  /** Stop the checks and wait for a pass in flight, so a refresh never dies holding Claude Code's lock. */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.ticking) await this.ticking;
  }

  /**
   * Whether ranked() may pick this account now, exclusions aside: a live token, no limit, and a score
   * (Fable window included for a Fable request) that is unknown or under limitPct.
   */
  isEligible(s, now, fable) {
    if (!s.credential || s.credential.expiresAtMs <= now) return false;
    if (s.limitedUntil > now) return false;
    const score = scoreOf(s.usage, now, { fable });
    return !(score !== null && score >= this.limitPct);
  }

  /**
   * Accounts that can take a request now, best first: lowest load, then lowest 5h use. An account with
   * unknown usage goes after every known one. `exclude` holds ids already tried for this request.
   */
  ranked({ model = null, exclude = new Set() } = {}) {
    const now = this.now();
    const fable = isFableModel(model);
    const out = [];
    for (const s of this.states.values()) {
      if (exclude.has(s.account.id)) continue;
      if (!this.isEligible(s, now, fable)) continue;
      const score = scoreOf(s.usage, now, { fable });
      out.push({ s, score, five: windowPct(s.usage?.fiveHour, now) ?? 0 });
    }
    out.sort((a, b) => {
      if ((a.score === null) !== (b.score === null)) return a.score === null ? 1 : -1;
      return (a.score ?? 0) - (b.score ?? 0) || a.five - b.five || a.s.account.id.localeCompare(b.s.account.id);
    });
    return out.map((x) => x.s);
  }

  /** Fold the unified rate-limit headers of an answer into the account's usage. */
  noteHeaders(s, info) {
    if (!info) return;
    const now = this.now();
    const usage = { ...(s.usage ?? { fiveHour: null, sevenDay: null, fable: null }) };
    if (info.fiveHour) usage.fiveHour = info.fiveHour;
    if (info.sevenDay) usage.sevenDay = info.sevenDay;
    if (info.fiveHour || info.sevenDay) {
      s.usage = usage;
      s.usageSource = 'headers';
      s.usageAt = now;
    }
  }

  /** The account answered a subscription-limit 429: keep it out until it resets. */
  markLimited(s, info, rejection) {
    const now = this.now();
    const until = info?.resetAt && info.resetAt > now ? info.resetAt : now + LIMITED_FALLBACK_MS;
    s.limitedUntil = until;
    s.limitReason = info?.claim ?? 'rate_limited';
    s.lastRejection = rejection ?? null;
    this.log('info', `account_limited account=${s.account.id} until=${new Date(until).toISOString()} claim=${s.limitReason}`);
  }

  /** The upstream refused the token (401): re-read the Keychain; true when a different token is now there. */
  async reloadAfter401(s) {
    const before = s.credential?.accessToken;
    // A second 401 for a token another request already reported: nothing new to learn.
    if (before === undefined) return false;
    s.rejectedToken = before;
    s.credential = null;
    await this.loadCredential(s);
    if (s.credential && s.credential.accessToken !== before) return true;
    s.credential = null;
    s.tokenError = 'rejected_401';
    return false;
  }

  /**
   * The earliest moment any account frees up, with the window that binds it; used for the "all limited"
   * answer. `{resetAt, claim, rejection}`; resetAt null when nothing is known.
   */
  earliestRelease({ model = null } = {}) {
    const now = this.now();
    const fable = isFableModel(model);
    let best = null;
    for (const s of this.states.values()) {
      if (!s.credential) continue;
      let at = null;
      let claim = null;
      if (s.limitedUntil > now) {
        at = s.limitedUntil;
        claim = s.limitReason;
      } else {
        const score = scoreOf(s.usage, now, { fable });
        if (score !== null && score >= this.limitPct) {
          at = freeAt(s.usage, now, this.limitPct, fable);
          const full = (w) => windowPct(w, now) !== null && windowPct(w, now) >= this.limitPct;
          // Claude Code knows only five_hour / seven_day claims; a full Fable window is a weekly limit.
          claim = full(s.usage.sevenDay) || (fable && full(s.usage.fable)) ? 'seven_day' : 'five_hour';
        }
      }
      if (at !== null && (best === null || at < best.resetAt)) best = { resetAt: at, claim, rejection: s.lastRejection, s };
    }
    return best ?? { resetAt: null, claim: null, rejection: null, s: null };
  }

  /** A secret-free view of every account for the status endpoint and CLI. */
  snapshot() {
    const now = this.now();
    return [...this.states.values()].map((s) => ({
      id: s.account.id,
      kind: s.account.kind,
      label: s.account.label,
      organization: s.account.identity.organizationName,
      token: s.credential ? (s.credential.expiresAtMs > now ? 'ok' : 'expired') : (s.tokenError ?? 'unknown'),
      tokenExpiresAt: s.credential ? new Date(s.credential.expiresAtMs).toISOString() : null,
      score: scoreOf(s.usage, now),
      fiveHour: s.usage?.fiveHour ?? null,
      sevenDay: s.usage?.sevenDay ?? null,
      fable: s.usage?.fable ?? null,
      usageSource: s.usageSource,
      usageAt: s.usageAt ? new Date(s.usageAt).toISOString() : null,
      usageError: s.usageError,
      limitedUntil: s.limitedUntil > now ? new Date(s.limitedUntil).toISOString() : null,
      // What ranked() would do right now: pick this account for a request, and for a Fable request.
      available: this.isEligible(s, now, false),
      availableForFable: this.isEligible(s, now, true),
      refresh: { state: s.refresh.state, reason: s.refresh.reason },
      pendingWrite: s.pending !== null,
    }));
  }
}
