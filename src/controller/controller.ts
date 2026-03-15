import type { AppConfig } from '../config.js';
import type { EngineProvider, EngineNotification, EngineServerRequest } from '../engine/types.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { TelegramCallbackEvent, TelegramGateway, TelegramTextEvent } from '../telegram/gateway.js';
import type { RuntimeStatus } from '../types.js';
import { createBridgeComposition, type BridgeComposition } from './composition.js';

const HISTORY_RETENTION_MS = 1000 * 60 * 60 * 24 * 30;
const MAX_RESOLVED_PLAN_SESSIONS_PER_CHAT = 20;

export class BridgeController {
  private readonly composition: BridgeComposition;

  constructor(
    config: AppConfig,
    private readonly store: BridgeStore,
    private readonly logger: Logger,
    private readonly bot: TelegramGateway,
    private readonly app: EngineProvider,
  ) {
    this.composition = createBridgeComposition(config, this.store, this.logger, this.bot, this.app);
  }

  async start(): Promise<void> {
    const composition = this.composition;

    this.bot.on('text', (event: TelegramTextEvent) => {
      void this.withLock(event.scopeId, async () => composition.telegramRouter.handleText(event)).catch((error) => {
        void this.handleAsyncError('telegram.text', error, event.scopeId);
      });
    });
    this.bot.on('callback', (event: TelegramCallbackEvent) => {
      void this.withLock(event.scopeId, async () => composition.telegramRouter.handleCallback(event)).catch((error) => {
        void this.handleAsyncError('telegram.callback', error, event.scopeId);
      });
    });
    this.app.on('notification', (msg: EngineNotification) => {
      void composition.codexRouter.handleNotification(msg).catch((error) => {
        void this.handleAsyncError('codex.notification', error);
      });
    });
    this.app.on('serverRequest', (msg: EngineServerRequest) => {
      void composition.codexRouter.handleServerRequest(msg).catch((error) => {
        void this.handleAsyncError('codex.server_request', error);
      });
    });
    this.app.on('connected', () => {
      composition.attachedThreads.clear();
      composition.runtimeStatus.clearLastError();
      composition.updateStatus();
    });
    this.app.on('disconnected', () => {
      composition.attachedThreads.clear();
      void composition.turnLifecycle.abandonAllTurns().catch((error) => {
        this.logger.error('codex.disconnect_cleanup_failed', { error: String(error) });
      });
      composition.updateStatus();
    });

    await this.app.start();
    await composition.turnLifecycle.cleanupStaleTurnPreviews();
    const requeuedTurnInputs = this.store.requeueInterruptedQueuedTurnInputs();
    const cleanupResult = this.store.cleanupHistoricalRecords({
      maxResolvedAgeMs: HISTORY_RETENTION_MS,
      maxResolvedPlanSessionsPerChat: MAX_RESOLVED_PLAN_SESSIONS_PER_CHAT,
    });
    if (requeuedTurnInputs > 0 || Object.values(cleanupResult).some((count) => count > 0)) {
      this.logger.info('store.startup_maintenance', {
        requeuedTurnInputs,
        ...cleanupResult,
      });
    }
    await this.bot.start();
    composition.runtimeStatus.setBotUsername(this.bot.username);
    await this.recoverPersistentState();
    composition.updateStatus();
  }

  async stop(): Promise<void> {
    const composition = this.composition;
    await composition.turnLifecycle.abandonAllTurns();
    composition.threadPanels.clearDrafts();
    composition.turnGuidance.stop();
    this.bot.stop();
    composition.approvalsAndInputs.stop();
    await this.app.stop();
    composition.updateStatus();
  }

  getRuntimeStatus(): RuntimeStatus {
    return this.composition.runtimeStatus.getRuntimeStatus();
  }

  private async recoverPersistentState(): Promise<void> {
    const composition = this.composition;
    await composition.guidedPlans.recoverSessions();
    await composition.approvalsAndInputs.recoverPendingApprovals();
    await composition.approvalsAndInputs.recoverPendingUserInputs();
    const scopeIds = this.store.listQueuedTurnInputs()
      .filter((record) => record.status === 'queued')
      .map((record) => record.scopeId)
      .filter((scopeId, index, values) => values.indexOf(scopeId) === index);
    for (const scopeId of scopeIds) {
      await this.withLock(scopeId, async () => {
        await composition.turnQueue.maybeStartQueuedTurn(scopeId);
      });
    }
  }

  private async handleAsyncError(source: string, error: unknown, scopeId?: string): Promise<void> {
    await this.composition.handleAsyncError(source, error, scopeId);
  }

  private withLock(scopeId: string, fn: () => Promise<void>): Promise<void> {
    return this.composition.locks.withLock(scopeId, fn);
  }
}
