// launchd user agent so the router runs in the background and comes back after login or a crash.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOG_DIR } from './config.js';

export const LABEL = 'io.github.choiyounggi.claude-proxy-router';
export const PLIST_PATH = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function plist({ node, script, configFile, logDir = LOG_DIR, pathEnv = process.env.PATH ?? '/usr/bin:/bin' }) {
  const args = [node, script, 'start', '--config', configFile].map((a) => `    <string>${esc(a)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(pathEnv)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${esc(path.join(logDir, 'router.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(path.join(logDir, 'router.err.log'))}</string>
</dict>
</plist>
`;
}

function domain() {
  return `gui/${process.getuid()}`;
}

function launchctl(args, { ignoreFailure = false } = {}) {
  try {
    execFileSync('/bin/launchctl', args, { stdio: 'ignore' });
    return true;
  } catch (e) {
    if (ignoreFailure) return false;
    throw new Error(`launchctl ${args[0]} failed (exit ${e.status})`);
  }
}

/**
 * The node binary to run: the first `node` on PATH that is the same program as this one (a stable
 * symlink such as /opt/homebrew/bin/node keeps working after `brew upgrade node`), else this process's own.
 */
export function stableNode(pathEnv = process.env.PATH ?? '', execPath = process.execPath) {
  let real;
  try { real = fs.realpathSync(execPath); } catch { return execPath; }
  for (const dir of pathEnv.split(':')) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const cand = path.join(dir, 'node');
    try {
      if (fs.realpathSync(cand) === real) return cand;
    } catch { /* not there */ }
  }
  return execPath;
}

/** Write the plist and (re)start the agent. `script` is kept as given (a symlink stays a symlink). */
export function install({ script, configFile }) {
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(PLIST_PATH, plist({ node: stableNode(), script, configFile }));
  // Replacing a loaded agent: bootout by the exact label, then bootstrap the new plist.
  launchctl(['bootout', `${domain()}/${LABEL}`], { ignoreFailure: true });
  launchctl(['bootstrap', domain(), PLIST_PATH]);
  return PLIST_PATH;
}

export function uninstall() {
  const loaded = launchctl(['bootout', `${domain()}/${LABEL}`], { ignoreFailure: true });
  let removed = false;
  try {
    fs.unlinkSync(PLIST_PATH);
    removed = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return { loaded, removed };
}

export function isLoaded() {
  return launchctl(['print', `${domain()}/${LABEL}`], { ignoreFailure: true });
}
