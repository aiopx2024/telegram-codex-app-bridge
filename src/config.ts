import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import type { LogLevel } from './logger.js';

export const APP_HOME = path.join(os.homedir(), '.telegram-codex-app-bridge');
export const DEFAULT_STORE_PATH = path.join(APP_HOME, 'data', 'bridge.sqlite');
export const DEFAULT_STATUS_PATH = path.join(APP_HOME, 'runtime', 'status.json');
export const DEFAULT_LOG_PATH = path.join(APP_HOME, 'logs', 'service.log');

export interface AppConfig {
  tgBotToken: string;
  tgAllowedUserId: string;
  codexAppAutolaunch: boolean;
  codexAppLaunchCmd: string;
  storePath: string;
  logLevel: LogLevel;
  defaultCwd: string;
  defaultApprovalPolicy: 'on-request' | 'on-failure' | 'never' | 'untrusted';
  telegramPollIntervalMs: number;
  telegramPreviewThrottleMs: number;
  threadListLimit: number;
  statusPath: string;
  logPath: string;
}

export function loadConfig(): AppConfig {
  dotenv.config();
  const config: AppConfig = {
    tgBotToken: required('TG_BOT_TOKEN'),
    tgAllowedUserId: required('TG_ALLOWED_USER_ID'),
    codexAppAutolaunch: boolEnv('CODEX_APP_AUTOLAUNCH', true),
    codexAppLaunchCmd: process.env.CODEX_APP_LAUNCH_CMD || 'codex app',
    storePath: process.env.STORE_PATH || DEFAULT_STORE_PATH,
    logLevel: parseLogLevel(process.env.LOG_LEVEL || 'info'),
    defaultCwd: process.env.DEFAULT_CWD || process.cwd(),
    defaultApprovalPolicy: parseApprovalPolicy(process.env.DEFAULT_APPROVAL_POLICY || 'on-request'),
    telegramPollIntervalMs: intEnv('TELEGRAM_POLL_INTERVAL_MS', 1200),
    telegramPreviewThrottleMs: intEnv('TELEGRAM_PREVIEW_THROTTLE_MS', 800),
    threadListLimit: intEnv('THREAD_LIST_LIMIT', 10),
    statusPath: DEFAULT_STATUS_PATH,
    logPath: DEFAULT_LOG_PATH
  };
  ensureAppDirs(config);
  return config;
}

export function ensureAppDirs(config: AppConfig): void {
  const dirs = [
    path.dirname(config.storePath),
    path.dirname(config.statusPath),
    path.dirname(config.logPath)
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function required(key: string): string {
  const value = process.env[key];
  if (!value || !value.trim()) {
    throw new Error(`${key} is required`);
  }
  return value.trim();
}

function intEnv(key: string, fallback: number): number {
  const value = process.env[key];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(key: string, fallback: boolean): boolean {
  const value = process.env[key];
  if (!value) return fallback;
  return value !== 'false' && value !== '0';
}

function parseLogLevel(value: string): LogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') return value;
  return 'info';
}

function parseApprovalPolicy(value: string): AppConfig['defaultApprovalPolicy'] {
  if (value === 'on-failure' || value === 'never' || value === 'untrusted' || value === 'on-request') return value;
  return 'on-request';
}
