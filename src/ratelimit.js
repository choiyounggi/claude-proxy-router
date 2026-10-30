// The answer sent when every account is at its limit. It mirrors Anthropic's own subscription-limit 429 so
// Claude Code on the calling side shows its usual "limit reached · resets <time>" message.
//
// Claude Code (2.1.314) treats a 429 as a subscription limit when `anthropic-ratelimit-unified-status` is
// `rejected`, `anthropic-ratelimit-unified-representative-claim` is `five_hour` or `seven_day`, and
// `anthropic-ratelimit-unified-reset` (epoch seconds) lies in the future.

const MESSAGE = "This request would exceed your account's rate limit. Please try again later.";
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length', 'content-encoding']);

/**
 * `{status, headers, body}` for the "all accounts limited" answer.
 * With a real rejection captured from Anthropic, its headers and body are replayed (reset time updated);
 * otherwise an equivalent answer is built.
 */
export function limitedResponse({ resetAt, claim, rejection }, nowMs = Date.now()) {
  const resetMs = resetAt && resetAt > nowMs ? resetAt : nowMs + 60_000;
  const resetS = Math.ceil(resetMs / 1000);
  const retryS = Math.max(1, Math.ceil((resetMs - nowMs) / 1000));
  const representative = claim === 'seven_day' ? 'seven_day' : 'five_hour';
  if (rejection) {
    const headers = {};
    for (const [k, v] of Object.entries(rejection.headers)) if (!HOP.has(k)) headers[k] = v;
    headers['anthropic-ratelimit-unified-reset'] = String(resetS);
    headers['retry-after'] = String(retryS);
    // The router already tried every account: the client's SDK retry loop would only repeat this answer.
    headers['x-should-retry'] = 'false';
    headers['content-length'] = String(rejection.body.length);
    return { status: 429, headers, body: rejection.body };
  }
  const body = Buffer.from(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: MESSAGE } }));
  const key = representative === 'seven_day' ? '7d' : '5h';
  return {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'content-length': String(body.length),
      'retry-after': String(retryS),
      'x-should-retry': 'false',
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-representative-claim': representative,
      'anthropic-ratelimit-unified-reset': String(resetS),
      [`anthropic-ratelimit-unified-${key}-status`]: 'rejected',
      [`anthropic-ratelimit-unified-${key}-utilization`]: '1',
      [`anthropic-ratelimit-unified-${key}-reset`]: String(resetS),
      'x-claude-proxy-router': 'all-accounts-limited',
    },
    body,
  };
}
