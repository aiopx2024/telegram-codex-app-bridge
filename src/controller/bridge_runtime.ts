import type { AppConfig } from '../config.js';
import type { EngineProvider } from '../engine/types.js';
import type { Logger } from '../logger.js';
import { writeRuntimeStatus } from '../runtime.js';
import type { BridgeStore } from '../store/database.js';
import type { RuntimeStatus } from '../types.js';
import type { ActiveTurn } from './turn_state.js';
import { formatUserError, toErrorMeta } from './utils.js';

export class BridgeRuntime {
  readonly turns = new TurnRegistry();
  readonly attachedThreads = new ThreadAttachmentRegistry();
}

export class TurnRegistry {
  private readonly turns = new Map<string, ActiveTurn>();

  set(turnId: string, active: ActiveTurn): void {
    this.turns.set(turnId, active);
  }

  get(turnId: string): ActiveTurn | undefined {
    return this.turns.get(turnId);
  }

  has(turnId: string): boolean {
    return this.turns.has(turnId);
  }

  delete(turnId: string): void {
    this.turns.delete(turnId);
  }

  list(): ActiveTurn[] {
    return [...this.turns.values()];
  }

  count(): number {
    return this.turns.size;
  }

  findByScope(scopeId: string): ActiveTurn | undefined {
    return [...this.turns.values()].find((turn) => turn.scopeId === scopeId);
  }

  findByThreadId(threadId: string): ActiveTurn | null {
    for (const active of this.turns.values()) {
      if (active.threadId === threadId) {
        return active;
      }
    }
    return null;
  }
}

export class ScopeLockRegistry {
  private readonly locks = new Map<string, Promise<void>>();

  withLock(scopeId: string, fn: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(scopeId) || Promise.resolve();
    const next = previous.then(fn, fn).finally(() => {
      if (this.locks.get(scopeId) === next) {
        this.locks.delete(scopeId);
      }
    });
    this.locks.set(scopeId, next);
    return next;
  }
}

export class ThreadAttachmentRegistry {
  private readonly attachedThreads = new Set<string>();

  has(threadId: string): boolean {
    return this.attachedThreads.has(threadId);
  }

  add(threadId: string): void {
    this.attachedThreads.add(threadId);
  }

  clear(): void {
    this.attachedThreads.clear();
  }
}

export class RuntimeStatusStore {
  private botUsername: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly config: Pick<AppConfig, 'statusPath' | 'bridgeEngine' | 'bridgeInstanceId'>,
    private readonly store: BridgeStore,
    private readonly app: EngineProvider,
    private readonly turns: TurnRegistry,
  ) {}

  setBotUsername(value: string | null): void {
    this.botUsername = value;
  }

  getBotUsername(): string | null {
    return this.botUsername;
  }

  clearLastError(): void {
    this.lastError = null;
  }

  setLastError(error: unknown): void {
    this.lastError = formatUserError(error);
  }

  setSerializedLastError(value: string): void {
    this.lastError = value;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getRuntimeStatus(): RuntimeStatus {
    const accountRateLimits = typeof this.app.getAccountRateLimits === 'function'
      ? this.app.getAccountRateLimits()
      : null;
    return {
      engine: this.config.bridgeEngine,
      instanceId: this.config.bridgeInstanceId,
      running: true,
      connected: this.app.isConnected(),
      userAgent: this.app.getUserAgent(),
      botUsername: this.botUsername,
      currentBindings: this.store.countBindings(),
      pendingApprovals: this.store.countPendingApprovals(),
      pendingUserInputs: this.store.countPendingUserInputs(),
      pendingAttachmentBatches: this.store.countPendingAttachmentBatches(),
      queuedTurns: this.store.countQueuedTurnInputs(),
      activeTurns: this.turns.count(),
      accountRateLimits,
      lastError: this.lastError,
      updatedAt: new Date().toISOString(),
    };
  }

  publish(): void {
    writeRuntimeStatus(this.config.statusPath, this.getRuntimeStatus());
  }
}

export async function notifyAsyncError(
  logger: Logger,
  runtimeStatus: RuntimeStatusStore,
  notifyScope: ((scopeId: string, error: string) => Promise<void>) | null,
  source: string,
  error: unknown,
  scopeId?: string,
): Promise<void> {
  runtimeStatus.setLastError(error);
  logger.error(`${source}.failed`, { error: toErrorMeta(error), scopeId: scopeId ?? null });
  runtimeStatus.publish();
  if (!scopeId || !notifyScope) {
    return;
  }
  try {
    await notifyScope(scopeId, formatUserError(error));
  } catch (notifyError) {
    logger.error('telegram.error_notification_failed', { error: toErrorMeta(notifyError), scopeId });
  }
}
