import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { getServiceRestartScriptCommand, resolveWindowsPowerShellPath } from './service_scripts.js';

test('resolveWindowsPowerShellPath uses the provided system root', () => {
  assert.equal(
    resolveWindowsPowerShellPath('D:\\Windows'),
    path.join('D:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  );
});

test('getServiceRestartScriptCommand returns a bash invocation on Unix hosts', () => {
  const rootDir = path.join('repo-root');
  assert.deepEqual(getServiceRestartScriptCommand('linux', { rootDir }), {
    command: '/bin/bash',
    args: [path.join(rootDir, 'scripts', 'service', 'restart-safe.sh')],
    scriptPath: path.join(rootDir, 'scripts', 'service', 'restart-safe.sh'),
  });
});

test('getServiceRestartScriptCommand returns a PowerShell invocation on Windows hosts', () => {
  const rootDir = 'C:\\repo-root';
  const systemRoot = 'D:\\Windows';
  assert.deepEqual(getServiceRestartScriptCommand('win32', { rootDir, systemRoot }), {
    command: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(rootDir, 'scripts', 'service', 'restart-safe.ps1'),
    ],
    scriptPath: path.join(rootDir, 'scripts', 'service', 'restart-safe.ps1'),
  });
});
