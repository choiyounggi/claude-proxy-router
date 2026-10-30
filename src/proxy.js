// The router's HTTP server: authenticates the caller, picks the account with the most headroom, swaps in
// its OAuth token and streams Anthropic's answer back unchanged.
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream';
import zlib from 'node:zlib';
import { timingSafeEqual } from 'node:crypto';
import { open } from './http.js';
import { OAUTH_BETA, parseUnifiedHeaders } from './usage.js';
import { limitedResponse } from './ratelimit.js';

export const SERVICE = 'claude-proxy-router';
export const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;
// A caller that stops sending its body mid-way must not hold the buffer forever.
const BODY_IDLE_MS = 60_000;
const UPSTREAM_HEADER_TIMEOUT_MS = 10 * 60_000;
// An answer stream that sends nothing for this long is treated as dead (Anthropic streams send pings).
const UPSTREAM_IDLE_MS = 5 * 60_000;
// Request headers never forwarded: hop-by-hop, the caller's credentials and what the router sets itself.
const DROP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection', 'te',
  'trailer', 'transfer-encoding', 'upgrade', 'authorization', 'x-api-key', 'x-router-key', 'content-length']);
const DROP_RESPONSE = new Set(['connection', 'keep-alive', 'transfer-encoding', 'proxy-authenticate', 'trailer', 'upgrade']);

/** The router key the caller sent: `x-router-key`, `x-api-key` or `Authorization: Bearer`. */
export function callerKey(headers) {
  if (typeof headers['x-router-key'] === 'string') return headers['x-router-key'];
  if (typeof headers['x-api-key'] === 'string') return headers['x-api-key'];
  const a = headers.authorization;
  if (typeof a === 'string' && /^bearer /i.test(a)) return a.slice(7).trim();
  return null;
}

export function keyMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || expected === '') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** `anthropic-beta` with the OAuth beta added once. */
export function withOauthBeta(value) {
  const parts = (Array.isArray(value) ? value.join(',') : value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.includes(OAUTH_BETA)) parts.push(OAUTH_BETA);
  return parts.join(',');
}

export function upstreamHeaders(incoming, accessToken, bodyLength) {
  const out = {};
  for (const [k, v] of Object.entries(incoming)) if (!DROP_REQUEST.has(k)) out[k] = v;
  out.authorization = `Bearer ${accessToken}`;
  out['anthropic-beta'] = withOauthBeta(incoming['anthropic-beta']);
  out['content-length'] = String(bodyLength);
  return out;
}

function json(res, status, obj, extra = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, ...extra });
  res.end(body);
}

function anthropicError(res, status, type, message) {
  json(res, status, { type: 'error', error: { type, message } });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.setTimeout(BODY_IDLE_MS, () => {
      reject(Object.assign(new Error('body idle'), { code: 'IDLE' }));
      req.destroy();
    });
    req.on('data', (c) => {
      if (size > MAX_REQUEST_BYTES) return;
      size += c.length;
      if (size > MAX_REQUEST_BYTES) {
        // Stop buffering but keep the socket so the 413 can still be written; the caller closes it after.
        chunks.length = 0;
        req.setTimeout(0);
        reject(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      req.setTimeout(0);
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** The body as plain bytes whatever Content-Encoding it came with (for a rejection kept for replay). */
function decoded(body, encoding) {
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(body);
    if (encoding === 'br') return zlib.brotliDecompressSync(body);
    if (encoding === 'deflate') return zlib.inflateSync(body);
  } catch {
    return null;
  }
  return body;
}

/**
 * The upstream URL for a caller's request target, or null unless it stays on the upstream origin under /v1/.
 * Checked after URL parsing: `/v1/../api/x` and `/v1/%2e%2e/api/x` resolve to `/api/x`.
 */
export function upstreamUrl(base, target) {
  if (typeof target !== 'string' || !target.startsWith('/v1/') || target.includes('\\')) return null;
  let u;
  try {
    u = new URL(base + target);
  } catch {
    return null;
  }
  return u.origin === new URL(base).origin && u.pathname.startsWith('/v1/') ? u.href : null;
}

function modelOf(body) {
  try {
    const m = JSON.parse(body.toString('utf8'))?.model;
    return typeof m === 'string' ? m : null;
  } catch {
    return null;
  }
}

/**
 * Build the request handler.
 * @param {object} opts
 * @param {import('./pool.js').Pool} opts.pool
 * @param {string} opts.routerKey
 * @param {string} [opts.upstream] base URL, default https://api.anthropic.com
 * @param {string} [opts.version]
 * @param {Function} [opts.log]
 */
export function createHandler({ pool, routerKey, upstream = 'https://api.anthropic.com', version = '0.0.0', log = () => {} }) {
  const base = upstream.replace(/\/+$/, '');
  const agent = base.startsWith('http:') ? new http.Agent({ keepAlive: true }) : new https.Agent({ keepAlive: true });

  async function forward(req, res, target) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      if (e.code === 'TOO_LARGE') {
        // Closing while the caller still uploads would reset the socket before it reads the 413: discard the
        // rest of the body (readBody no longer buffers it) for at most 5 s, then close.
        res.once('finish', () => {
          const t = setTimeout(() => req.destroy(), 5_000);
          req.once('end', () => { clearTimeout(t); req.destroy(); });
        });
        anthropicError(res, 413, 'request_too_large', 'Request exceeds the router limit');
      }
      return;
    }
    // A caller that goes away (Claude Code's Esc) aborts the upstream request at any point: while waiting
    // for headers, between account retries, or mid-stream.
    const abort = new AbortController();
    res.on('close', () => { if (!res.writableFinished) abort.abort(); });
    const model = modelOf(body);
    const tried = new Set();
    const retried401 = new Set();
    let lastRejection = null;
    for (;;) {
      if (abort.signal.aborted) return;
      const [s] = pool.ranked({ model, exclude: tried });
      if (!s) break;
      tried.add(s.account.id);
      let up;
      try {
        up = await open(target, {
          method: req.method,
          headers: upstreamHeaders(req.headers, s.credential.accessToken, body.length),
          body,
          timeoutMs: UPSTREAM_HEADER_TIMEOUT_MS,
          agent,
          signal: abort.signal,
        });
      } catch (e) {
        if (abort.signal.aborted) return;
        log('warn', `upstream_error account=${s.account.id} code=${e?.code ?? e?.message}`);
        anthropicError(res, 502, 'api_error', 'Router could not reach the Anthropic API');
        return;
      }
      const info = parseUnifiedHeaders(up.headers);
      pool.noteHeaders(s, info);
      if (up.status === 429 && info?.status === 'rejected') {
        const raw = await readAll(up.stream).catch(() => Buffer.alloc(0));
        const plain = decoded(raw, up.headers['content-encoding']);
        const headers = { ...up.headers };
        delete headers['content-encoding'];
        lastRejection = plain ? { headers, body: plain } : null;
        pool.markLimited(s, info, lastRejection);
        continue;
      }
      if (up.status === 401) {
        await readAll(up.stream).catch(() => {});
        const changed = await pool.reloadAfter401(s);
        log('warn', `upstream_401 account=${s.account.id} token_changed=${changed}`);
        // One retry per account with the token found in the Keychain, never a loop.
        if (changed && !retried401.has(s.account.id)) {
          retried401.add(s.account.id);
          tried.delete(s.account.id);
        }
        continue;
      }
      const headers = {};
      for (const [k, v] of Object.entries(up.headers)) if (!DROP_RESPONSE.has(k)) headers[k] = v;
      res.writeHead(up.status, headers);
      res.flushHeaders();
      up.req.setTimeout(UPSTREAM_IDLE_MS, () => up.req.destroy(new Error('upstream idle')));
      // pipeline destroys both sides on any failure: a cut upstream ends the caller's connection instead of
      // leaving it waiting, and a gone caller tears the upstream down.
      pipeline(up.stream, res, (err) => {
        if (err && !abort.signal.aborted) log('warn', `stream_cut account=${s.account.id} code=${err.code ?? err.message}`);
      });
      return;
    }
    const release = pool.earliestRelease({ model });
    const answer = limitedResponse({ ...release, rejection: lastRejection ?? release.rejection });
    if (!release.s && !lastRejection) {
      // Nothing is limited: no account has a usable token at all.
      anthropicError(res, 503, 'api_error', 'Router has no account with a usable token; run `claude-proxy-router status`');
      return;
    }
    log('info', `all_limited reset=${release.resetAt ? new Date(release.resetAt).toISOString() : '-'}`);
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  }

  return async function handler(req, res) {
    const url = req.url ?? '/';
    if (!keyMatches(callerKey(req.headers), routerKey)) {
      // The service name lets a caller tell "router reached, wrong key" from "something else answered".
      json(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid router key' }, service: SERVICE });
      return;
    }
    if (req.method === 'GET' && url === '/_router/ping') {
      json(res, 200, { pong: true, service: SERVICE, protocol: PROTOCOL_VERSION, version,
        accounts: pool.ranked().length });
      return;
    }
    if (req.method === 'GET' && url === '/_router/status') {
      json(res, 200, { service: SERVICE, protocol: PROTOCOL_VERSION, version, generatedAt: new Date().toISOString(),
        accounts: pool.snapshot() });
      return;
    }
    const target = upstreamUrl(base, url);
    if (target === null) {
      anthropicError(res, 404, 'not_found_error', 'Only /v1/* is routed');
      return;
    }
    try {
      await forward(req, res, target);
    } catch (e) {
      log('error', `handler_error ${e?.message ?? e}`);
      if (!res.headersSent) anthropicError(res, 500, 'api_error', 'Router internal error');
      else res.destroy();
    }
  };
}

/** Start listening; resolves the server once bound. */
export function listen(handler, { host, port }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    // Streams can stay open for many minutes while a long answer is generated.
    server.requestTimeout = 0;
    server.headersTimeout = 60_000;
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
