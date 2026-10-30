// Small HTTP client on node:http/https: no redirects, raw bytes (no decompression), bounded bodies.
import http from 'node:http';
import https from 'node:https';

const MAX_BODY = 1_048_576;

function lib(url) {
  return url.protocol === 'http:' ? http : https;
}

/**
 * Send one request and resolve once response headers arrive: `{status, headers, stream, req}`.
 * Rejects on a network error, on `signal` abort, or when no headers arrive within `timeoutMs`. A rejection
 * carries `requestSent`: false only when nothing of the request can have reached the server.
 */
export function open(urlString, { method = 'GET', headers = {}, body = null, timeoutMs = 30_000, agent, signal } = {}) {
  const url = new URL(urlString);
  return new Promise((resolve, reject) => {
    const req = lib(url).request(url, { method, headers, agent, signal });
    let connected = false;
    req.on('socket', (sock) => {
      // A reused keep-alive socket is already connected; a new one connects later.
      if (!sock.connecting) connected = true;
      else sock.once('connect', () => { connected = true; });
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    req.on('response', (res) => {
      clearTimeout(timer);
      resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, stream: res, req });
    });
    req.on('error', (e) => {
      clearTimeout(timer);
      reject(Object.assign(e, { requestSent: connected }));
    });
    req.end(body ?? undefined);
  });
}

/** Like `open` but reads the whole body (at most 1 MiB): `{status, headers, body: Buffer}`. */
export async function request(urlString, opts = {}) {
  const res = await open(urlString, opts);
  const chunks = [];
  let size = 0;
  await new Promise((resolve, reject) => {
    res.stream.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        res.stream.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    res.stream.on('end', resolve);
    res.stream.on('error', reject);
  });
  return { status: res.status, headers: res.headers, body: Buffer.concat(chunks) };
}
