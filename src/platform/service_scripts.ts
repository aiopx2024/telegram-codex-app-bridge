import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLATFORM_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(PLATFORM_DIR, '../..');

export interface ServiceScriptCommand {
  command: string;
  args: string[];
  scriptPath: string;
}

export function resolveWindowsPowerShellPath(
  systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows',
): string {
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function getServiceRestartScriptCommand(
  platform: NodeJS.Platform = process.platform,
  options: {
    rootDir?: string;
    systemRoot?: string;
  } = {},
): ServiceScriptCommand {
  const rootDir = options.rootDir ?? ROOT_DIR;
  if (platform === 'win32') {
    const scriptPath = path.join(rootDir, 'scripts', 'service', 'restart-safe.ps1');
    return {
      command: resolveWindowsPowerShellPath(options.systemRoot),
      args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      scriptPath,
    };
  }

  const scriptPath = path.join(rootDir, 'scripts', 'service', 'restart-safe.sh');
  return {
    command: '/bin/bash',
    args: [scriptPath],
    scriptPath,
  };
}
