import fs from 'node:fs';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
import { DEFAULT_STATUS_PATH, loadConfig } from './config.js';
import { Logger } from './logger.js';
import { BridgeStore } from './store/database.js';
import { TelegramGateway } from './telegram/gateway.js';
import { CodexAppClient } from './codex_app/client.js';
import { BridgeController } from './controller/controller.js';
import { readRuntimeStatus, writeRuntimeStatus } from './runtime.js';

const command = process.argv[2] || 'serve';
dotenv.config();

async function main(): Promise<void> {
  if (command === 'status') {
    const status = readRuntimeStatus(process.env.STATUS_PATH || DEFAULT_STATUS_PATH);
    if (!status) {
      console.log('No runtime status found.');
      process.exit(1);
    }
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  if (command === 'doctor') {
    const checks = [
      ['node >= 24', Number(process.versions.node.split('.')[0]) >= 24],
      ['codex cli available', hasCommand('codex')],
      ['telegram bot token configured', Boolean(process.env.TG_BOT_TOKEN)],
      ['telegram allowed user configured', Boolean(process.env.TG_ALLOWED_USER_ID)],
    ];
    let failed = false;
    for (const [name, ok] of checks) {
      console.log(`${ok ? '[OK]' : '[FAIL]'} ${name}`);
      if (!ok) failed = true;
    }
    try {
      const cwd = process.env.DEFAULT_CWD || process.cwd();
      fs.accessSync(cwd);
      console.log(`[OK] default cwd exists: ${cwd}`);
    } catch {
      const cwd = process.env.DEFAULT_CWD || process.cwd();
      console.log(`[FAIL] default cwd missing: ${cwd}`);
      failed = true;
    }
    process.exit(failed ? 1 : 0);
  }

  const config = loadConfig();
  const logger = new Logger(config.logLevel, config.logPath);
  const store = new BridgeStore(config.storePath);
  const bot = new TelegramGateway(
    config.tgBotToken,
    config.tgAllowedUserId,
    config.telegramPollIntervalMs,
    store,
    logger,
  );
  const app = new CodexAppClient(
    config.codexCliBin,
    config.codexAppLaunchCmd,
    config.codexAppAutolaunch,
    logger,
  );
  const controller = new BridgeController(config, store, logger, bot, app);

  process.on('unhandledRejection', (error) => {
    logger.error('process.unhandled_rejection', { error: serializeError(error) });
  });

  process.on('uncaughtException', (error) => {
    logger.error('process.uncaught_exception', { error: serializeError(error) });
  });

  await controller.start();
  logger.info('bridge.started', controller.getRuntimeStatus());

  const shutdown = async (signal: string): Promise<void> => {
    logger.info('bridge.shutting_down', { signal });
    await controller.stop();
    writeRuntimeStatus(config.statusPath, {
      running: false,
      connected: false,
      userAgent: app.getUserAgent(),
      botUsername: bot.username,
      currentBindings: 0,
      pendingApprovals: 0,
      activeTurns: 0,
      lastError: null,
      updatedAt: new Date().toISOString(),
    });
    store.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});

function hasCommand(commandName: string): boolean {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(which, [commandName], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { error: String(error) };
}
