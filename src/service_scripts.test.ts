import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function writeExecutable(pathname: string, content: string): void {
  fs.writeFileSync(pathname, content, { mode: 0o755 });
}

test('linux service scripts manage the systemd user lifecycle through the unified entrypoints', () => {
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-codex-service-test-'));
  const fakeHome = path.join(tempDir, 'home');
  const fakeBin = path.join(tempDir, 'bin');
  const fakeConfigHome = path.join(tempDir, '.config');
  const systemctlLog = path.join(tempDir, 'systemctl.log');
  const journalctlLog = path.join(tempDir, 'journalctl.log');
  const realUname = spawnSync('sh', ['-c', 'command -v uname'], { encoding: 'utf8' }).stdout.trim() || '/usr/bin/uname';
  const distDir = path.join(rootDir, 'dist');
  const distMainPath = path.join(distDir, 'main.js');
  const distMainExisted = fs.existsSync(distMainPath);

  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(fakeConfigHome, { recursive: true });
  if (!distMainExisted) {
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(distMainPath, 'console.log("test stub");\n', 'utf8');
  }

  writeExecutable(path.join(fakeBin, 'systemctl'), `#!/bin/sh
printf '%s\n' "$*" >> "${systemctlLog}"
if [ "\${2:-}" = "status" ]; then
  echo "fake systemd status"
fi
exit 0
`);

  writeExecutable(path.join(fakeBin, 'journalctl'), `#!/bin/sh
printf '%s\n' "$*" >> "${journalctlLog}"
echo "fake journal log"
exit 0
`);

  writeExecutable(path.join(fakeBin, 'uname'), `#!/bin/sh
if [ "\${1:-}" = "-s" ]; then
  echo "Linux"
  exit 0
fi
exec "${realUname}" "$@"
`);

  const env = {
    ...process.env,
    HOME: fakeHome,
    XDG_CONFIG_HOME: fakeConfigHome,
    PATH: `${fakeBin}:${process.env.PATH || ''}`,
    FOLLOW: 'false',
    LINES: '5',
  };

  const runScript = (relativePath: string) => spawnSync('bash', [path.join(rootDir, relativePath)], {
    cwd: rootDir,
    env,
    encoding: 'utf8',
  });

  try {
    const install = runScript('scripts/service/install.sh');
    assert.equal(install.status, 0, install.stderr || install.stdout);

    const unitPath = path.join(fakeConfigHome, 'systemd', 'user', 'com.ganxing.telegram-codex-app-bridge.service');
    const runnerPath = path.join(fakeHome, '.telegram-codex-app-bridge', 'bin', 'run-bridge.sh');
    assert.equal(fs.existsSync(unitPath), true);
    assert.equal(fs.existsSync(runnerPath), true);
    const unitContent = fs.readFileSync(unitPath, 'utf8');
    assert.match(unitContent, /ExecStart=.*run-bridge\.sh/);
    assert.match(unitContent, /WorkingDirectory=/);

    const status = runScript('scripts/service/status.sh');
    assert.equal(status.status, 0, status.stderr || status.stdout);
    assert.match(status.stdout, /fake systemd status/);

    const logs = runScript('scripts/service/logs.sh');
    assert.equal(logs.status, 0, logs.stderr || logs.stdout);
    assert.match(logs.stdout, /fake journal log/);

    const restart = runScript('scripts/service/restart.sh');
    assert.equal(restart.status, 0, restart.stderr || restart.stdout);

    const stop = runScript('scripts/service/stop.sh');
    assert.equal(stop.status, 0, stop.stderr || stop.stdout);

    const uninstall = runScript('scripts/service/uninstall.sh');
    assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
    assert.equal(fs.existsSync(unitPath), false);

    const systemctlCalls = fs.readFileSync(systemctlLog, 'utf8');
    assert.match(systemctlCalls, /--user daemon-reload/);
    assert.match(systemctlCalls, /--user enable --now com\.ganxing\.telegram-codex-app-bridge\.service/);
    assert.match(systemctlCalls, /--user status com\.ganxing\.telegram-codex-app-bridge\.service --no-pager/);
    assert.match(systemctlCalls, /--user restart com\.ganxing\.telegram-codex-app-bridge\.service/);
    assert.match(systemctlCalls, /--user stop com\.ganxing\.telegram-codex-app-bridge\.service/);
    assert.match(systemctlCalls, /--user disable --now com\.ganxing\.telegram-codex-app-bridge\.service/);

    const journalctlCalls = fs.readFileSync(journalctlLog, 'utf8');
    assert.match(journalctlCalls, /--user -u com\.ganxing\.telegram-codex-app-bridge\.service -n 5 --no-pager/);
  } finally {
    if (!distMainExisted && fs.existsSync(distMainPath)) {
      fs.rmSync(distMainPath, { force: true });
    }
  }
});
