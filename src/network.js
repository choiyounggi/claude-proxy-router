// Endpoint discovery for onboarding: which local addresses can be bound and whether a port is free.
import net from 'node:net';
import os from 'node:os';
import { request } from './http.js';

/** Tailscale hands out addresses from the CGNAT range 100.64.0.0/10. */
export function isTailscale(ip) {
  const m = /^100\.(\d+)\./.exec(ip);
  return m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

/** Bindable endpoints, Tailscale first: `[{host, kind, label}]`. */
export function listEndpoints(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const kind = isTailscale(a.address) ? 'tailscale' : 'lan';
      out.push({ host: a.address, kind, label: `${a.address}  (${kind === 'tailscale' ? 'Tailscale' : `LAN ${name}`})` });
    }
  }
  out.sort((x, y) => (x.kind === y.kind ? x.host.localeCompare(y.host) : x.kind === 'tailscale' ? -1 : 1));
  out.push({ host: '127.0.0.1', kind: 'local', label: '127.0.0.1  (this Mac only)' });
  out.push({ host: '0.0.0.0', kind: 'all', label: '0.0.0.0  (every interface)' });
  return out;
}

/** True when `host:port` can be bound right now. */
export function portFree(host, port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

/** The first free port from `start` (at most `tries` ports), or null. */
export async function findFreePort(host, start, tries = 50) {
  for (let p = start; p < start + tries && p <= 65535; p += 1) {
    if (await portFree(host, p)) return p;
  }
  return null;
}

/** The URL a caller uses for a bind host (0.0.0.0 is not reachable as such: prefer Tailscale, then LAN). */
export function publicUrl(host, port, endpoints = listEndpoints()) {
  let h = host;
  if (host === '0.0.0.0') h = (endpoints.find((e) => e.kind === 'tailscale') ?? endpoints.find((e) => e.kind === 'lan'))?.host ?? '127.0.0.1';
  return `http://${h}:${port}`;
}

/**
 * Ping a router: `{ok:true, info}`, or `{ok:false, reason}` with reason one of
 * `unreachable`, `bad_key` (a router answered but refused the key), `not_router`.
 */
export async function pingRouter(baseUrl, key, { timeoutMs = 5000 } = {}) {
  let res;
  try {
    res = await request(`${baseUrl.replace(/\/+$/, '')}/_router/ping`, { headers: { 'x-router-key': key }, timeoutMs });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  let body = null;
  try { body = JSON.parse(res.body.toString('utf8')); } catch { /* not JSON: not a router */ }
  if (res.status === 200 && body?.pong === true && body.service === 'claude-proxy-router') return { ok: true, info: body };
  if (res.status === 401 && body?.service === 'claude-proxy-router') return { ok: false, reason: 'bad_key' };
  return { ok: false, reason: 'not_router' };
}
