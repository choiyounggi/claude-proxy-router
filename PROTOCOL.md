# Router protocol (v1)

The contract between **claude-proxy-router** (this repo, the receiving side) and **claude-auto-proxy** (the
sending side). The sender only needs two values from the router's onboarding: the **router URL** and the
**router key** (`claude-proxy-router key` prints both).

## Address

- `http://<host>:<port>` — the host and port picked in `claude-proxy-router onboard`. Default port **18787**.
- Plain HTTP: run it on a private network (Tailscale, or `127.0.0.1`). The router key is the only gate.

## Authentication

Every request carries the router key in one of (checked in this order):

1. `x-router-key: <key>`
2. `x-api-key: <key>` — what Claude Code sends with `ANTHROPIC_API_KEY`
3. `Authorization: Bearer <key>` — what Claude Code sends with `ANTHROPIC_AUTH_TOKEN`

A wrong or missing key answers:

```http
HTTP/1.1 401
content-type: application/json

{"type":"error","error":{"type":"authentication_error","message":"invalid router key"},"service":"claude-proxy-router"}
```

The `service` field tells "router reached, wrong key" apart from "something else answered".

## Ping (onboarding connection check)

```http
GET /_router/ping
x-router-key: <key>
```

```json
{"pong": true, "service": "claude-proxy-router", "protocol": 1, "version": "0.1.0", "accounts": 2}
```

`accounts` is how many accounts can take a request right now (0 means every account is limited or has no
usable token). A sender registers the router only when it gets `200` with `pong: true`,
`service: "claude-proxy-router"` and `protocol: 1`.

| Ping result | Meaning for the sender's onboarding |
|---|---|
| connection error / timeout | unreachable: wrong address, router not running, or not on the same tailnet |
| `401` with `service: "claude-proxy-router"` | router reached, key wrong |
| anything else | not a claude-proxy-router at that address |

## Status (per-account view)

```http
GET /_router/status
x-router-key: <key>
```

The key check and its `401` are the same as for every other request.

```json
{"service": "claude-proxy-router", "protocol": 1, "version": "0.2.0", "generatedAt": "2026-01-01T00:00:00.000Z",
 "limitPct": 100,
 "accounts": [{"id": "example-id", "kind": "orca", "label": "example", "organization": "Example Org",
   "token": "ok", "tokenExpiresAt": "2026-01-01T08:00:00.000Z", "score": 41,
   "fiveHour": {"utilization": 41, "resetsAt": 1767232800000}, "sevenDay": {"utilization": 12, "resetsAt": 1767780000000},
   "fable": null, "usageSource": "live", "usageAt": "2026-01-01T00:00:00.000Z", "usageError": null,
   "limitedUntil": null, "available": true, "availableForFable": true,
   "refresh": {"state": "fresh", "reason": null}, "pendingWrite": false}]}
```

- Secret-free: no token value appears. `token` is `ok`, `expired`, or why there is no usable token.
- `available` / `availableForFable`: whether the router would pick this account for a request right now, the
  second for a Fable model. The rule is the one account choice uses: a live token, no `limitedUntil`, and a load
  that is unknown or under `limitPct` — `max(5-hour, weekly)` for `available`, the same plus the Fable window for
  `availableForFable`, where an unknown Fable window makes the load unknown (the account stays in, ranked last).
  A client shows these instead of re-deriving them. `available`, `availableForFable` and `limitPct` are sent
  since 0.2.0; an older router omits them.
- A window is `{utilization (percent), resetsAt (epoch ms or null)}` or `null` when unknown. Windows are sent as
  stored; a window past its `resetsAt` is counted 0 by `score` and by account choice.
- `score` is `max(5-hour, weekly)` without the Fable window, `null` when unknown. `limitPct` is the router's
  threshold (config `limitPct`, default 100).
- `limitedUntil` is set while Anthropic's subscription-limit `429` keeps the account out. `usageSource` is `live`,
  `cache`, `headers` or `null`; `label`, `organization` and `usageError` may be `null`. `refresh.state` is the last
  token-refresh outcome: `null` (not tried yet), `fresh`, `refreshed`, `skipped`, `failed` or `stopped`.
- `generatedAt` is the router's clock; a client comparing reset times uses it, not its own.
- `claude-proxy-router status` and `claude-auto-proxy router status` both read this. Claude Code's own `/status`
  and `/usage` cannot show these accounts: its only credential is the router key.

## Proxying

- Every `/v1/*` request (method, path, query, headers, body) is forwarded to `https://api.anthropic.com` with
  the router key removed (`x-router-key`, `x-api-key`, `Authorization`), the chosen account's OAuth token set as
  `Authorization: Bearer …`, and `oauth-2025-04-20` added to `anthropic-beta`. Other paths answer `404` — the
  check runs on the normalised path, so `/v1/../api/...` is refused too.
- The answer (status, headers, body — SSE streams included) comes back unchanged, streamed as it arrives.
- The body is sent as is. Claude Code as the sender already sends what a subscription token needs (its system
  prompt and betas); another client must do the same.

## Account choice

- The router keeps every local account's token and usage warm in the background and picks, per request, the
  account with the lowest `max(5-hour, weekly)` usage (`max(5-hour, weekly, Fable)` for a model whose id contains
  `fable`). A window past its reset counts 0.
- An account Anthropic answers with a subscription-limit `429` is skipped until its reset, and the same request
  is retried on the next account. A `401` re-reads the account's Keychain item and retries once.

## All accounts limited

The router answers the way Anthropic answers a subscription limit, so Claude Code on the sending side shows its
usual "limit reached · resets …" message:

```http
HTTP/1.1 429
retry-after: <seconds until the first account frees up>
x-should-retry: false
anthropic-ratelimit-unified-status: rejected
anthropic-ratelimit-unified-representative-claim: five_hour | seven_day
anthropic-ratelimit-unified-reset: <epoch seconds when the first account frees up>
content-type: application/json

{"type":"error","error":{"type":"rate_limit_error","message":"..."}}
```

When Anthropic itself sent such a `429` during this request, its headers and body are replayed (reset time and
`retry-after` updated to the earliest account). `x-should-retry: false` stops the SDK's own retry loop: the router
already tried every account.

No account with a usable token at all (none logged in, every token expired) answers `503` `api_error`.
