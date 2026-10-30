// Interactive onboarding: pick the endpoint (address + port) the router listens on, keep or create the
// router key, save the config, optionally start the background agent, and print what the sender needs.
import { DEFAULT_PORT, DEFAULTS, generateKey, saveConfig } from './config.js';
import { listEndpoints, portFree, findFreePort, publicUrl, pingRouter } from './network.js';

const isPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535;
const isIPv4 = (s) => /^(\d{1,3})(\.\d{1,3}){3}$/.test(s) && s.split('.').every((p) => Number(p) <= 255);

/**
 * @param {object} io `{ask(question) -> Promise<string>, print(line)}`
 * @param {object} opts `{configFile, existing, flags: {host, port, install, yes}, deps}`
 * @returns {Promise<{ok: boolean, config?: object, url?: string}>}
 */
export async function onboard(io, { configFile, existing = null, flags = {}, deps = {} }) {
  const d = { discover: null, listEndpoints, portFree, findFreePort, pingRouter, install: null, wait: (ms) => new Promise((r) => setTimeout(r, ms)), ...deps };
  const { ask, print } = io;

  const accounts = d.discover();
  print(`로그인된 Claude 계정 ${accounts.length}개`);
  for (const a of accounts) print(`  - ${a.label}${a.identity.organizationName ? ` (${a.identity.organizationName})` : ''} [${a.kind}]`);
  if (accounts.length === 0) {
    print('라우팅할 계정이 없어요. Orca에서 계정에 로그인하거나 `claude` 로 로그인한 뒤 다시 실행하세요.');
    return { ok: false };
  }

  // 1. Endpoint (bind address).
  const endpoints = d.listEndpoints();
  let host = flags.host ?? null;
  if (host === null) {
    print('');
    print('라우터가 받을 주소를 고르세요 (프록시를 보내는 쪽에서 닿는 주소):');
    endpoints.forEach((e, i) => print(`  ${i + 1}) ${e.label}${existing?.host === e.host ? '  ← 현재' : ''}`));
    print(`  ${endpoints.length + 1}) 직접 입력`);
    // Default: the current host, else Tailscale, else this Mac only — never a LAN or every-interface bind.
    const pick = (h) => endpoints.findIndex((e) => e.host === h) + 1;
    const ts = endpoints.findIndex((e) => e.kind === 'tailscale') + 1;
    const fallback = (existing?.host && pick(existing.host)) || ts || pick('127.0.0.1') || 1;
    while (host === null) {
      const raw = (await ask(`번호 [${fallback}]: `)).trim();
      const n = raw === '' ? fallback : Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= endpoints.length) host = endpoints[n - 1].host;
      else if (n === endpoints.length + 1) {
        const typed = (await ask('IPv4 주소: ')).trim();
        if (isIPv4(typed)) host = typed;
        else print('IPv4 주소 형식이 아니에요 (예: 100.101.102.103).');
      } else print(`1-${endpoints.length + 1} 중에서 고르세요.`);
    }
  } else if (!isIPv4(host)) {
    print(`--host ${host}: IPv4 주소가 아니에요.`);
    return { ok: false };
  }
  const kind = endpoints.find((e) => e.host === host)?.kind ?? 'lan';
  if (kind === 'lan' || kind === 'all') {
    print(`주의: ${host} 는 Tailscale 밖에서도 열려요. 라우터는 평문 HTTP라 같은 네트워크의 누구나 라우터 키를 엿볼 수 있어요.`);
    print('      믿을 수 있는 네트워크가 아니면 Tailscale 주소나 127.0.0.1 을 고르세요.');
  }

  // 2. Port. A port held by this router itself (re-onboarding while it runs) counts as usable.
  const ours = async (p) => existing?.routerKey
    && (await d.pingRouter(`http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${p}`, existing.routerKey)).ok;
  const usable = async (p) => (await d.portFree(host, p)) || (await ours(p));
  let port = flags.port ?? null;
  if (port !== null) {
    if (!isPort(port) || !(await usable(port))) {
      print(`포트 ${port}: 쓸 수 없어요 (범위 밖이거나 다른 프로그램이 사용 중).`);
      return { ok: false };
    }
  } else {
    let suggested = existing?.port ?? DEFAULT_PORT;
    if (!(await usable(suggested))) suggested = (await d.findFreePort(host, DEFAULT_PORT)) ?? suggested;
    while (port === null) {
      const raw = (await ask(`포트 [${suggested}]: `)).trim();
      const n = raw === '' ? suggested : Number(raw);
      if (!isPort(n)) print('1-65535 사이 정수를 입력하세요.');
      else if (!(await usable(n))) print(`${host}:${n} 은(는) 이미 사용 중이에요. 다른 포트를 고르세요.`);
      else port = n;
    }
  }

  // 3. Key and config.
  const routerKey = existing?.routerKey ?? generateKey();
  const config = saveConfig({ ...DEFAULTS, ...(existing ?? {}), host, port, routerKey }, configFile);
  print('');
  print(`설정 저장: ${configFile}`);

  // 4. Background agent.
  let install = flags.install;
  if (install === undefined) {
    install = flags.yes ? true : /^(y|yes|ㅇ|네)$/i.test((await ask('백그라운드 서비스로 지금 시작할까요? (launchd) [Y/n]: ')).trim() || 'y');
  }
  const url = publicUrl(host, port, endpoints);
  if (install && d.install) {
    d.install();
    let ping = { ok: false, reason: 'unreachable' };
    for (let i = 0; i < 20 && !ping.ok; i += 1) {
      await d.wait(500);
      ping = await d.pingRouter(url, routerKey);
    }
    print(ping.ok ? `라우터 응답 확인: ${url} (사용 가능 계정 ${ping.info.accounts}개)` : `라우터가 아직 응답하지 않아요 (${ping.reason}). 로그를 확인하세요.`);
  } else {
    print('수동 시작: claude-proxy-router start');
  }

  print('');
  print('프록시를 보내는 쪽(claude-auto-proxy) 온보딩에 아래 두 값을 넣으세요:');
  print(`  라우터 주소: ${url}`);
  print(`  라우터 키:   ${routerKey}`);
  return { ok: true, config, url };
}
