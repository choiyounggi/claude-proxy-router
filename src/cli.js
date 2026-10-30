// Command line: onboard | start | status | key | ping | install | uninstall
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { ConfigError, configPath, loadConfig } from './config.js';
import { discoverAccounts } from './accounts.js';
import { Pool } from './pool.js';
import { createHandler, listen } from './proxy.js';
import { onboard } from './onboard.js';
import { pingRouter, publicUrl } from './network.js';
import * as launchd from './launchd.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'bin', 'claude-proxy-router.js');
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const USAGE = `claude-proxy-router ${VERSION}

  onboard [--host IP] [--port N] [--install|--no-install] [--yes]
                       주소·포트 선택, 키 생성, 설정 저장, 백그라운드 시작
  start                포그라운드로 라우터 실행
  status [--json]      실행 중인 라우터의 계정 상태
  key                  보내는 쪽 온보딩에 넣을 주소·키 출력
  ping <url> <key>     라우터 연결 확인 (핑퐁)
  install | uninstall  launchd 백그라운드 서비스 등록/해제

  공통: --config PATH (기본 ${configPath()})
`;

/** `{cmd, args, opts}`: flags may appear anywhere; unknown flags raise. */
export function parseArgs(argv) {
  const opts = {};
  const args = [];
  const valued = new Set(['--config', '--host', '--port']);
  const bools = new Set(['--json', '--install', '--no-install', '--yes', '--help', '-h', '--version']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (valued.has(a)) {
      if (i + 1 >= argv.length) throw new ConfigError(`${a}: needs a value`);
      opts[a.slice(2)] = argv[++i];
    } else if (bools.has(a)) {
      opts[a.replace(/^-+/, '')] = true;
    } else if (a.startsWith('-')) {
      throw new ConfigError(`${a}: unknown option`);
    } else {
      args.push(a);
    }
  }
  if (opts.port !== undefined) {
    const n = Number(opts.port);
    if (!Number.isInteger(n)) throw new ConfigError('--port: must be an integer');
    opts.port = n;
  }
  return { cmd: args.shift() ?? null, args, opts };
}

/**
 * The command path the launchd agent should run: the path this process was started by (npm's or Homebrew's
 * bin symlink survives upgrades, the versioned path it points to does not), else the repo's bin script.
 */
export function launcherPath(argv1 = process.argv[1]) {
  return typeof argv1 === 'string' && path.isAbsolute(argv1) && fs.existsSync(argv1) ? argv1 : SCRIPT;
}

function logger(line) {
  return (level, msg) => line(`${new Date().toISOString()} ${level} ${msg}`);
}

function requireConfig(file) {
  const c = loadConfig(file);
  if (!c || !c.routerKey) throw new ConfigError(`${file}: no config yet; run \`claude-proxy-router onboard\``);
  return c;
}

function pct(w) {
  return w ? `${Math.floor(w.utilization)}%` : '-';
}

export async function main(argv, io = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) }) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    io.err(e.message);
    return 2;
  }
  const { cmd, args, opts } = parsed;
  const file = path.resolve(opts.config ?? configPath());
  if (opts.version) {
    io.out(VERSION);
    return 0;
  }
  if (!cmd || opts.help || opts.h) {
    io.out(USAGE);
    return cmd || opts.help || opts.h ? 0 : 2;
  }
  try {
    switch (cmd) {
      case 'onboard': {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        // Input ending (Ctrl-D, closed pipe) must fail the onboarding, not leave a question pending forever.
        const closed = new Promise((_, reject) => rl.once('close', () => reject(new Error('입력이 끝나 온보딩을 중단했어요'))));
        closed.catch(() => {});
        const ask = (q) => Promise.race([rl.question(q), closed]);
        try {
          const existing = loadConfig(file);
          const install = opts.install ? true : opts['no-install'] ? false : undefined;
          const r = await onboard({ ask, print: io.out }, {
            configFile: file,
            existing,
            flags: { host: opts.host, port: opts.port, install, yes: opts.yes },
            deps: {
              discover: () => discoverAccounts({
                profilesRoot: existing?.profilesRoot, includeDefault: existing?.includeDefaultAccount ?? true,
              }),
              install: () => launchd.install({ script: launcherPath(), configFile: file }),
            },
          });
          return r.ok ? 0 : 1;
        } finally {
          rl.close();
        }
      }
      case 'start': {
        const config = requireConfig(file);
        const log = logger(io.out);
        const pool = new Pool({ config, deps: { log } });
        await pool.start();
        const server = await listen(createHandler({ pool, routerKey: config.routerKey, upstream: config.upstream, version: VERSION, log }), config);
        log('info', `listening host=${config.host} port=${config.port} accounts=${pool.states.size} usable=${pool.ranked().length}`);
        await new Promise((resolve) => {
          const stop = () => {
            server.close();
            // Open streams would otherwise hold the process past launchd's stop timeout.
            server.closeAllConnections?.();
            // A refresh in flight finishes first so Claude Code's lock dirs are released.
            pool.stop().then(resolve, resolve);
          };
          process.once('SIGTERM', stop);
          process.once('SIGINT', stop);
        });
        return 0;
      }
      case 'status': {
        const config = requireConfig(file);
        const url = publicUrl(config.host, config.port);
        const ping = await pingRouter(url, config.routerKey);
        if (!ping.ok) {
          io.err(`라우터 응답 없음 (${ping.reason}): ${url}`);
          return 1;
        }
        const res = await fetch(`${url}/_router/status`, { headers: { 'x-router-key': config.routerKey } });
        const body = await res.json();
        if (opts.json) {
          io.out(JSON.stringify(body, null, 2));
          return 0;
        }
        io.out(`라우터 ${url}  v${body.version}  사용 가능 ${ping.info.accounts}/${body.accounts.length}`);
        for (const a of body.accounts) {
          const state = a.limitedUntil ? `제한 ~${a.limitedUntil}` : a.token !== 'ok' ? `토큰 ${a.token}` : 'ok';
          io.out(`  ${a.label.padEnd(20)} 5h ${pct(a.fiveHour).padStart(4)}  7d ${pct(a.sevenDay).padStart(4)}  fable ${pct(a.fable).padStart(4)}  ${state}  (${a.usageSource ?? '-'})`);
        }
        return 0;
      }
      case 'key': {
        const config = requireConfig(file);
        io.out(`라우터 주소: ${publicUrl(config.host, config.port)}`);
        io.out(`라우터 키:   ${config.routerKey}`);
        return 0;
      }
      case 'ping': {
        if (args.length !== 2) {
          io.err('usage: claude-proxy-router ping <url> <key>');
          return 2;
        }
        const r = await pingRouter(args[0], args[1]);
        io.out(r.ok ? `pong: ${r.info.service} v${r.info.version} protocol ${r.info.protocol}, 사용 가능 계정 ${r.info.accounts}개` : `실패: ${r.reason}`);
        return r.ok ? 0 : 1;
      }
      case 'install': {
        requireConfig(file);
        io.out(`설치됨: ${launchd.install({ script: launcherPath(), configFile: file })}`);
        return 0;
      }
      case 'uninstall': {
        const r = launchd.uninstall();
        io.out(`중지: ${r.loaded ? '예' : '실행 중 아니었음'}, plist 삭제: ${r.removed ? '예' : '없었음'}`);
        return 0;
      }
      default:
        io.err(`unknown command: ${cmd}\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    if (e instanceof ConfigError) {
      io.err(e.message);
      return 2;
    }
    throw e;
  }
}
