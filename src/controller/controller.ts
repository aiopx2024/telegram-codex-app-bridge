import crypto from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { PendingApprovalRecord, RuntimeStatus, ThreadBinding } from '../types.js';
import { parseCommand } from './commands.js';
import type { TelegramGateway, TelegramTextEvent, TelegramCallbackEvent } from '../telegram/gateway.js';
import type { CodexAppClient, JsonRpcNotification, JsonRpcServerRequest } from '../codex_app/client.js';
import { writeRuntimeStatus } from '../runtime.js';

interface ActiveTurn {
  chatId: string;
  threadId: string;
  turnId: string;
  previewMessageId: number;
  buffer: string;
  finalText: string | null;
  lastFlushAt: number;
  resolver: () => void;
}

type ApprovalAction = 'accept' | 'session' | 'deny';

export class BridgeController {
  private activeTurns = new Map<string, ActiveTurn>();
  private locks = new Map<string, Promise<void>>();
  private approvalTimers = new Map<string, NodeJS.Timeout>();
  private attachedThreads = new Set<string>();
  private botUsername: string | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly store: BridgeStore,
    private readonly logger: Logger,
    private readonly bot: TelegramGateway,
    private readonly app: CodexAppClient,
  ) {}

  async start(): Promise<void> {
    this.bot.on('text', (event: TelegramTextEvent) => {
      void this.withLock(event.chatId, async () => this.handleText(event)).catch((error) => {
        void this.handleAsyncError('telegram.text', error, event.chatId);
      });
    });
    this.bot.on('callback', (event: TelegramCallbackEvent) => {
      void this.handleCallback(event).catch((error) => {
        void this.handleAsyncError('telegram.callback', error, event.chatId);
      });
    });
    this.app.on('notification', (msg: JsonRpcNotification) => {
      void this.handleNotification(msg).catch((error) => {
        void this.handleAsyncError('codex.notification', error);
      });
    });
    this.app.on('serverRequest', (msg: JsonRpcServerRequest) => {
      void this.handleServerRequest(msg).catch((error) => {
        void this.handleAsyncError('codex.server_request', error);
      });
    });
    this.app.on('connected', () => {
      this.attachedThreads.clear();
      this.lastError = null;
      this.updateStatus();
    });
    this.app.on('disconnected', () => {
      this.attachedThreads.clear();
      this.updateStatus();
    });

    await this.app.start();
    await this.bot.start();
    this.botUsername = this.bot.username;
    this.updateStatus();
  }

  async stop(): Promise<void> {
    this.bot.stop();
    for (const timer of this.approvalTimers.values()) {
      clearTimeout(timer);
    }
    this.approvalTimers.clear();
    await this.app.stop();
    this.updateStatus();
  }

  getRuntimeStatus(): RuntimeStatus {
    return {
      running: true,
      connected: this.app.isConnected(),
      userAgent: this.app.getUserAgent(),
      botUsername: this.botUsername,
      currentBindings: this.store.countBindings(),
      pendingApprovals: this.store.countPendingApprovals(),
      activeTurns: this.activeTurns.size,
      lastError: this.lastError,
      updatedAt: new Date().toISOString(),
    };
  }

  private async handleText(event: TelegramTextEvent): Promise<void> {
    this.store.insertAudit('inbound', event.chatId, 'telegram.message', event.text);
    const command = parseCommand(event.text);
    if (command) {
      await this.handleCommand(event, command.name, command.args);
      return;
    }

    if ([...this.activeTurns.values()].some(turn => turn.chatId === event.chatId)) {
      await this.bot.sendMessage(event.chatId, 'Another turn is already running. Use /interrupt or wait.');
      return;
    }

    const existingBinding = this.store.getBinding(event.chatId);
    const binding = existingBinding
      ? await this.ensureThreadReady(event.chatId, existingBinding)
      : await this.createBinding(event.chatId, null);
    await this.bot.sendTyping(event.chatId);
    const previewMessageId = await this.bot.sendMessage(event.chatId, 'Working...');
    const turnState = await this.startTurnWithRecovery(event.chatId, binding, event.text);
    await this.registerActiveTurn(event.chatId, turnState.threadId, turnState.turnId, previewMessageId);
  }

  private async handleCommand(event: TelegramTextEvent, name: string, args: string[]): Promise<void> {
    switch (name) {
      case 'start':
      case 'help': {
        await this.bot.sendMessage(event.chatId, [
          'Commands:',
          '/help',
          '/status',
          '/threads',
          '/open <n>',
          '/new [cwd]',
          '/where',
          '/interrupt',
          'Plain text continues the current thread, or creates one if none is bound.'
        ].join('\n'));
        return;
      }
      case 'status': {
        const binding = this.store.getBinding(event.chatId);
        const lines = [
          `Connected: ${this.app.isConnected() ? 'yes' : 'no'}`,
          `User agent: ${this.app.getUserAgent() ?? 'unknown'}`,
          `Current thread: ${binding?.threadId ?? 'none'}`,
          `Pending approvals: ${this.store.countPendingApprovals()}`,
          `Active turns: ${this.activeTurns.size}`,
        ];
        await this.bot.sendMessage(event.chatId, lines.join('\n'));
        return;
      }
      case 'where': {
        const binding = this.store.getBinding(event.chatId);
        if (!binding) {
          await this.bot.sendMessage(event.chatId, 'No thread is currently bound. Send a message or use /new.');
          return;
        }
        const thread = await this.app.readThread(binding.threadId, false);
        await this.bot.sendMessage(event.chatId, [
          `Thread: ${binding.threadId}`,
          `CWD: ${thread?.cwd ?? binding.cwd ?? this.config.defaultCwd}`,
          `Preview: ${thread?.preview || '(empty)'}`,
          `Updated: ${formatUnix(thread?.updatedAt)}`,
        ].join('\n'));
        return;
      }
      case 'threads': {
        const threads = await this.app.listThreads(this.config.threadListLimit);
        const cached = threads.map((thread: any) => ({
          threadId: String(thread.id),
          preview: String(thread.preview || '(empty)'),
          cwd: thread.cwd ? String(thread.cwd) : null,
          updatedAt: Number(thread.updatedAt || 0),
        }));
        this.store.cacheThreadList(event.chatId, cached);
        const lines = cached.length === 0
          ? ['No recent threads.']
          : cached.map((thread, index) => `${index + 1}. ${thread.preview.slice(0, 80)}\n   ${thread.threadId}\n   ${thread.cwd ?? '(no cwd)'}`);
        await this.bot.sendMessage(event.chatId, lines.join('\n'));
        return;
      }
      case 'open': {
        const target = Number.parseInt(args[0] || '', 10);
        if (!Number.isFinite(target)) {
          await this.bot.sendMessage(event.chatId, 'Usage: /open <n>');
          return;
        }
        const thread = this.store.getCachedThread(event.chatId, target);
        if (!thread) {
          await this.bot.sendMessage(event.chatId, 'Unknown cached thread. Run /threads first.');
          return;
        }
        this.store.setBinding(event.chatId, thread.threadId, thread.cwd);
        await this.bot.sendMessage(event.chatId, `Bound to thread ${thread.threadId}`);
        return;
      }
      case 'new': {
        const cwd = args.join(' ').trim() || this.config.defaultCwd;
        const binding = await this.createBinding(event.chatId, cwd);
        await this.bot.sendMessage(event.chatId, `Started new thread ${binding.threadId}\nCWD: ${binding.cwd ?? cwd}`);
        return;
      }
      case 'interrupt': {
        const active = [...this.activeTurns.values()].find(turn => turn.chatId === event.chatId);
        if (!active) {
          await this.bot.sendMessage(event.chatId, 'No active turn to interrupt.');
          return;
        }
        await this.app.interruptTurn(active.threadId, active.turnId);
        await this.bot.sendMessage(event.chatId, `Interrupt requested for ${active.turnId}`);
        return;
      }
      default: {
        await this.bot.sendMessage(event.chatId, `Unknown command: /${name}`);
      }
    }
  }

  private async handleCallback(event: TelegramCallbackEvent): Promise<void> {
    const match = /^approval:([a-f0-9]+):(accept|session|deny)$/.exec(event.data);
    if (!match) {
      await this.bot.answerCallback(event.callbackQueryId, 'Unsupported action');
      return;
    }
    const localId = match[1]!;
    const action = match[2]! as ApprovalAction;
    const approval = this.store.getPendingApproval(localId);
    if (!approval || approval.resolvedAt) {
      await this.bot.answerCallback(event.callbackQueryId, 'Approval already resolved');
      return;
    }
    if (approval.chatId !== event.chatId || (approval.messageId !== null && approval.messageId !== event.messageId)) {
      await this.bot.answerCallback(event.callbackQueryId, 'Approval does not match this message');
      return;
    }

    const result = mapApprovalDecision(action);
    await this.app.respond(approval.serverRequestId, result);
    this.store.markApprovalResolved(localId);
    this.clearApprovalTimer(localId);
    await this.bot.answerCallback(event.callbackQueryId, 'Decision recorded');
    if (approval.messageId !== null) {
      await this.bot.editMessage(event.chatId, approval.messageId, renderApprovalMessage(approval, action));
    }
    this.updateStatus();
  }

  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    switch (notification.method) {
      case 'item/agentMessage/delta': {
        const { turnId, delta } = notification.params as { turnId: string; delta: string };
        const active = this.activeTurns.get(turnId);
        if (!active) return;
        active.buffer += delta;
        await this.flushPreview(active, false);
        return;
      }
      case 'item/completed': {
        const params = notification.params as any;
        if (params.item?.type !== 'agentMessage') return;
        const active = this.activeTurns.get(String(params.turnId));
        if (!active) return;
        active.finalText = String(params.item.text || active.buffer || 'Completed.');
        await this.flushPreview(active, true);
        return;
      }
      case 'turn/completed': {
        const params = notification.params as any;
        const active = this.activeTurns.get(String(params.turn?.id));
        if (!active) return;
        await this.flushPreview(active, true);
        active.resolver();
        this.activeTurns.delete(active.turnId);
        this.updateStatus();
        return;
      }
      case 'error': {
        this.lastError = JSON.stringify(notification.params ?? {});
        this.logger.error('codex.notification.error', notification.params);
        this.updateStatus();
        return;
      }
      default:
        return;
    }
  }

  private async handleServerRequest(request: JsonRpcServerRequest): Promise<void> {
    switch (request.method) {
      case 'item/commandExecution/requestApproval': {
        const params = request.params as any;
        const approval = this.createApprovalRecord('command', request.id, params);
        const messageId = await this.bot.sendMessage(approval.chatId, renderApprovalMessage(approval), approvalKeyboard(approval.localId));
        this.store.updatePendingApprovalMessage(approval.localId, messageId);
        this.armApprovalTimer(approval.localId);
        this.updateStatus();
        return;
      }
      case 'item/fileChange/requestApproval': {
        const params = request.params as any;
        const approval = this.createApprovalRecord('fileChange', request.id, params);
        const messageId = await this.bot.sendMessage(approval.chatId, renderApprovalMessage(approval), approvalKeyboard(approval.localId));
        this.store.updatePendingApprovalMessage(approval.localId, messageId);
        this.armApprovalTimer(approval.localId);
        this.updateStatus();
        return;
      }
      case 'item/tool/requestUserInput': {
        const params = request.params as any;
        const chatId = this.findChatByThread(params.threadId);
        if (chatId) {
          await this.bot.sendMessage(chatId, 'Codex requested interactive tool input, but this bridge only supports approvals in v1. Returning empty answers.');
        }
        await this.app.respond(request.id, { answers: {} });
        return;
      }
      default: {
        await this.app.respondError(request.id, `Unsupported server request: ${request.method}`);
      }
    }
  }

  private async createBinding(chatId: string, requestedCwd: string | null): Promise<{ threadId: string; cwd: string | null }> {
    const cwd = requestedCwd || this.config.defaultCwd;
    const thread = await this.app.startThread(cwd, this.config.defaultApprovalPolicy);
    const threadId = String(thread.id);
    const resolvedCwd = String(thread.cwd || cwd);
    this.store.setBinding(chatId, threadId, resolvedCwd);
    this.attachedThreads.add(threadId);
    this.updateStatus();
    return { threadId, cwd: resolvedCwd };
  }

  private async startTurnWithRecovery(chatId: string, binding: Pick<ThreadBinding, 'threadId' | 'cwd'>, text: string): Promise<{ threadId: string; turnId: string }> {
    try {
      const turn = await this.app.startTurn(binding.threadId, text, this.config.defaultApprovalPolicy, binding.cwd ?? this.config.defaultCwd);
      return { threadId: binding.threadId, turnId: turn.id };
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }
      this.logger.warn('codex.turn_thread_not_found', { chatId, threadId: binding.threadId });
      const replacement = await this.createBinding(chatId, binding.cwd ?? this.config.defaultCwd);
      await this.bot.sendMessage(chatId, `Current thread was unavailable. Continued in a new thread ${replacement.threadId}.`);
      const turn = await this.app.startTurn(replacement.threadId, text, this.config.defaultApprovalPolicy, replacement.cwd ?? this.config.defaultCwd);
      return { threadId: replacement.threadId, turnId: turn.id };
    }
  }

  private async registerActiveTurn(chatId: string, threadId: string, turnId: string, previewMessageId: number): Promise<void> {
    await new Promise<void>((resolve) => {
      this.activeTurns.set(turnId, {
        chatId,
        threadId,
        turnId,
        previewMessageId,
        buffer: '',
        finalText: null,
        lastFlushAt: 0,
        resolver: resolve,
      });
      this.updateStatus();
    });
  }

  private async flushPreview(active: ActiveTurn, force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - active.lastFlushAt < this.config.telegramPreviewThrottleMs) return;
    const text = sanitizeTelegramText(active.finalText || active.buffer || 'Working...');
    active.lastFlushAt = now;
    try {
      await this.bot.editMessage(active.chatId, active.previewMessageId, text);
    } catch (error) {
      this.logger.warn('telegram.preview_edit_failed', { error: String(error) });
    }
  }

  private createApprovalRecord(kind: PendingApprovalRecord['kind'], serverRequestId: string | number, params: any): PendingApprovalRecord {
    const threadId = String(params.threadId);
    const chatId = this.findChatByThread(threadId);
    if (!chatId) {
      throw new Error(`No chat binding found for thread ${threadId}`);
    }
    const record: PendingApprovalRecord = {
      localId: crypto.randomBytes(8).toString('hex'),
      serverRequestId: String(serverRequestId),
      kind,
      chatId,
      threadId,
      turnId: String(params.turnId),
      itemId: String(params.itemId),
      approvalId: params.approvalId ? String(params.approvalId) : null,
      reason: params.reason ? String(params.reason) : null,
      command: params.command ? String(params.command) : null,
      cwd: params.cwd ? String(params.cwd) : null,
      messageId: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.store.savePendingApproval(record);
    return record;
  }

  private findChatByThread(threadId: string): string | null {
    for (const turn of this.activeTurns.values()) {
      if (turn.threadId === threadId) return turn.chatId;
    }
    return this.store.findChatIdByThreadId(threadId);
  }

  private withLock(chatId: string, fn: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(chatId) || Promise.resolve();
    const next = previous.then(fn, fn).finally(() => {
      if (this.locks.get(chatId) === next) {
        this.locks.delete(chatId);
      }
    });
    this.locks.set(chatId, next);
    return next;
  }

  private updateStatus(): void {
    writeRuntimeStatus(this.config.statusPath, this.getRuntimeStatus());
  }

  private async ensureThreadReady(chatId: string, binding: ThreadBinding): Promise<ThreadBinding> {
    if (this.attachedThreads.has(binding.threadId)) {
      return binding;
    }
    try {
      const thread = await this.app.resumeThread(binding.threadId);
      const normalized: ThreadBinding = {
        chatId,
        threadId: String(thread.id),
        cwd: String(thread.cwd || binding.cwd || this.config.defaultCwd),
        updatedAt: Date.now(),
      };
      this.store.setBinding(chatId, normalized.threadId, normalized.cwd);
      this.attachedThreads.add(normalized.threadId);
      this.updateStatus();
      return normalized;
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }
      this.logger.warn('codex.thread_binding_stale', { chatId, threadId: binding.threadId });
      const replacement = await this.createBinding(chatId, binding.cwd ?? this.config.defaultCwd);
      await this.bot.sendMessage(chatId, `Previous thread was unavailable. Started a new thread ${replacement.threadId}.`);
      return {
        chatId,
        threadId: replacement.threadId,
        cwd: replacement.cwd,
        updatedAt: Date.now(),
      };
    }
  }

  private async handleAsyncError(source: string, error: unknown, chatId?: string): Promise<void> {
    this.lastError = formatUserError(error);
    this.logger.error(`${source}.failed`, { error: toErrorMeta(error), chatId: chatId ?? null });
    this.updateStatus();
    if (!chatId) return;
    try {
      await this.bot.sendMessage(chatId, `Bridge error: ${formatUserError(error)}`);
    } catch (notifyError) {
      this.logger.error('telegram.error_notification_failed', { error: toErrorMeta(notifyError), chatId });
    }
  }

  private armApprovalTimer(localId: string): void {
    this.clearApprovalTimer(localId);
    const timer = setTimeout(() => {
      void this.expireApproval(localId);
    }, 5 * 60 * 1000);
    this.approvalTimers.set(localId, timer);
  }

  private clearApprovalTimer(localId: string): void {
    const timer = this.approvalTimers.get(localId);
    if (!timer) return;
    clearTimeout(timer);
    this.approvalTimers.delete(localId);
  }

  private async expireApproval(localId: string): Promise<void> {
    const approval = this.store.getPendingApproval(localId);
    if (!approval || approval.resolvedAt) {
      this.clearApprovalTimer(localId);
      return;
    }
    try {
      await this.app.respond(approval.serverRequestId, { decision: 'decline' });
      this.store.markApprovalResolved(localId);
      if (approval.messageId !== null) {
        await this.bot.editMessage(approval.chatId, approval.messageId, renderApprovalMessage(approval, 'deny'));
      } else {
        await this.bot.sendMessage(approval.chatId, `Approval timed out and was denied.\nThread: ${approval.threadId}`);
      }
    } catch (error) {
      this.lastError = String(error);
      this.logger.error('approval.timeout_failed', { localId, error: String(error) });
    } finally {
      this.clearApprovalTimer(localId);
      this.updateStatus();
    }
  }
}

function sanitizeTelegramText(text: string): string {
  if (!text.trim()) return 'Working...';
  return text.length > 4000 ? `${text.slice(0, 3997)}...` : text;
}

function formatUnix(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 'unknown';
  return new Date(numeric * 1000).toISOString();
}

function approvalKeyboard(localId: string): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: 'Allow', callback_data: `approval:${localId}:accept` },
    { text: 'Allow Session', callback_data: `approval:${localId}:session` },
    { text: 'Deny', callback_data: `approval:${localId}:deny` },
  ]];
}

function renderApprovalMessage(record: PendingApprovalRecord, decision?: ApprovalAction): string {
  const lines = [
    `Approval requested: ${record.kind}`,
    `Thread: ${record.threadId}`,
    `Turn: ${record.turnId}`,
  ];
  if (record.command) lines.push(`Command: ${record.command}`);
  if (record.cwd) lines.push(`CWD: ${record.cwd}`);
  if (record.reason) lines.push(`Reason: ${record.reason}`);
  if (decision) lines.push(`Decision: ${decision}`);
  return lines.join('\n');
}

function mapApprovalDecision(action: ApprovalAction): unknown {
  const decision = action === 'accept'
    ? 'accept'
    : action === 'session'
      ? 'acceptForSession'
      : 'decline';
  return { decision };
}

function toErrorMeta(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { error: String(error) };
}

function formatUserError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isThreadNotFoundError(error: unknown): boolean {
  return error instanceof Error && /(thread not found|no rollout found for thread id)/i.test(error.message);
}
