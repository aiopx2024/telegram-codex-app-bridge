import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { normalizeLocale, t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { AppLocale, ModelInfo, PendingApprovalRecord, ReasoningEffortValue, RuntimeStatus, ThreadBinding, ThreadSessionState } from '../types.js';
import { parseCommand } from './commands.js';
import {
  buildModelSettingsKeyboard,
  buildThreadsKeyboard,
  clampEffortToModel,
  formatModelSettingsMessage,
  formatThreadsMessage,
  formatWhereMessage,
  normalizeRequestedEffort,
  resolveCurrentModel,
  resolveRequestedModel,
} from './presentation.js';
import type { TelegramGateway, TelegramTextEvent, TelegramCallbackEvent } from '../telegram/gateway.js';
import {
  TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES,
  buildAttachmentPrompt,
  isNativeImageAttachment,
  planAttachmentStoragePath,
  summarizeTelegramInput,
  type StagedTelegramAttachment,
  type TelegramInboundAttachment,
} from '../telegram/media.js';
import { chunkTelegramMessage, sanitizeTelegramPreview } from '../telegram/text.js';
import type { CodexAppClient, JsonRpcNotification, JsonRpcServerRequest, TurnInput } from '../codex_app/client.js';
import { writeRuntimeStatus } from '../runtime.js';

interface ActiveTurn {
  chatId: string;
  threadId: string;
  turnId: string;
  previewMessageId: number;
  buffer: string;
  finalText: string | null;
  interruptRequested: boolean;
  lastFlushAt: number;
  resolver: () => void;
}

type ApprovalAction = 'accept' | 'session' | 'deny';
class UserFacingError extends Error {}

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
    const locale = this.localeForChat(event.chatId, event.languageCode);
    this.store.insertAudit('inbound', event.chatId, 'telegram.message', summarizeTelegramInput(event.text, event.attachments));
    const command = event.attachments.length === 0 ? parseCommand(event.text) : null;
    if (command && event.text.trim()) {
      await this.handleCommand(event, locale, command.name, command.args);
      return;
    }

    if (this.findActiveTurn(event.chatId)) {
      await this.bot.sendMessage(event.chatId, t(locale, 'another_turn_running'));
      return;
    }

    const existingBinding = this.store.getBinding(event.chatId);
    const binding = existingBinding
      ? await this.ensureThreadReady(event.chatId, existingBinding)
      : await this.createBinding(event.chatId, null);
    await this.bot.sendTyping(event.chatId);
    const previewMessageId = await this.bot.sendMessage(event.chatId, t(locale, 'working'));
    const input = await this.buildTurnInput(binding, event, locale);
    const turnState = await this.startTurnWithRecovery(event.chatId, binding, input);
    await this.registerActiveTurn(event.chatId, turnState.threadId, turnState.turnId, previewMessageId);
  }

  private async handleCommand(event: TelegramTextEvent, locale: AppLocale, name: string, args: string[]): Promise<void> {
    switch (name) {
      case 'start':
      case 'help': {
        await this.bot.sendMessage(event.chatId, [
          t(locale, 'help_commands_title'),
          '/help',
          '/status',
          '/threads [query]',
          '/open <n>',
          '/new [cwd]',
          '/models',
          '/reveal',
          '/where',
          '/interrupt',
          t(locale, 'help_advanced_aliases'),
          t(locale, 'help_plain_text_hint'),
        ].join('\n'));
        return;
      }
      case 'status': {
        const binding = this.store.getBinding(event.chatId);
        const settings = this.store.getChatSettings(event.chatId);
        const lines = [
          t(locale, 'status_connected', { value: t(locale, this.app.isConnected() ? 'yes' : 'no') }),
          t(locale, 'status_user_agent', { value: this.app.getUserAgent() ?? t(locale, 'unknown') }),
          t(locale, 'status_current_thread', { value: binding?.threadId ?? t(locale, 'none') }),
          t(locale, 'status_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
          t(locale, 'status_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
          t(locale, 'status_sync_on_open', { value: t(locale, this.config.codexAppSyncOnOpen ? 'yes' : 'no') }),
          t(locale, 'status_sync_on_turn_complete', { value: t(locale, this.config.codexAppSyncOnTurnComplete ? 'yes' : 'no') }),
          t(locale, 'status_pending_approvals', { value: this.store.countPendingApprovals() }),
          t(locale, 'status_active_turns', { value: this.activeTurns.size }),
        ];
        await this.bot.sendMessage(event.chatId, lines.join('\n'));
        return;
      }
      case 'where': {
        await this.showWherePanel(event.chatId, undefined, locale);
        return;
      }
      case 'threads': {
        const searchTerm = args.join(' ').trim() || null;
        await this.showThreadsPanel(event.chatId, undefined, searchTerm, locale);
        return;
      }
      case 'open': {
        const target = Number.parseInt(args[0] || '', 10);
        if (!Number.isFinite(target)) {
          await this.bot.sendMessage(event.chatId, t(locale, 'usage_open'));
          return;
        }
        const thread = this.store.getCachedThread(event.chatId, target);
        if (!thread) {
          await this.bot.sendMessage(event.chatId, t(locale, 'unknown_cached_thread'));
          return;
        }
        let binding: ThreadBinding;
        try {
          binding = await this.bindCachedThread(event.chatId, thread.threadId);
        } catch (error) {
          if (isThreadNotFoundError(error)) {
            await this.bot.sendMessage(event.chatId, t(locale, 'cached_thread_unavailable'));
            return;
          }
          throw error;
        }
        const settings = this.store.getChatSettings(event.chatId);
        const lines = [
          t(locale, 'bound_to_thread', { threadId: binding.threadId }),
          t(locale, 'line_title', { value: thread.name || thread.preview || t(locale, 'empty') }),
          t(locale, 'status_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
          t(locale, 'status_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
          t(locale, 'line_cwd', { value: binding.cwd ?? this.config.defaultCwd }),
        ];
        if (this.config.codexAppSyncOnOpen) {
          const revealError = await this.tryRevealThread(event.chatId, binding.threadId, 'open');
          lines.push(revealError ? t(locale, 'codex_sync_failed', { error: revealError }) : t(locale, 'opened_in_codex'));
        }
        await this.bot.sendMessage(event.chatId, lines.join('\n'));
        return;
      }
      case 'new': {
        const cwd = args.join(' ').trim() || this.config.defaultCwd;
        const binding = await this.createBinding(event.chatId, cwd);
        const settings = this.store.getChatSettings(event.chatId);
        await this.bot.sendMessage(event.chatId, [
          t(locale, 'started_new_thread', { threadId: binding.threadId }),
          t(locale, 'line_cwd', { value: binding.cwd ?? cwd }),
          t(locale, 'status_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
          t(locale, 'status_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
        ].join('\n'));
        return;
      }
      case 'model': {
        await this.handleModelCommand(event, locale, args);
        return;
      }
      case 'models': {
        await this.showModelSettingsPanel(event.chatId, undefined, locale);
        return;
      }
      case 'effort': {
        await this.handleEffortCommand(event, locale, args);
        return;
      }
      case 'reveal':
      case 'focus': {
        const binding = this.store.getBinding(event.chatId);
        if (!binding) {
          await this.bot.sendMessage(event.chatId, t(locale, 'no_thread_bound_reveal'));
          return;
        }
        const readyBinding = await this.ensureThreadReady(event.chatId, binding);
        const revealError = await this.tryRevealThread(event.chatId, readyBinding.threadId, 'reveal');
        if (revealError) {
          await this.bot.sendMessage(event.chatId, t(locale, 'failed_open_codex', { error: revealError }));
          return;
        }
        await this.bot.sendMessage(event.chatId, t(locale, 'opened_thread_in_codex', { threadId: readyBinding.threadId }));
        return;
      }
      case 'interrupt': {
        const active = this.findActiveTurn(event.chatId);
        if (!active) {
          await this.bot.sendMessage(event.chatId, t(locale, 'no_active_turn'));
          return;
        }
        await this.requestInterrupt(active);
        await this.bot.sendMessage(event.chatId, t(locale, 'interrupt_requested_for', { turnId: active.turnId }));
        return;
      }
      default: {
        await this.bot.sendMessage(event.chatId, t(locale, 'unknown_command', { name }));
      }
    }
  }

  private async handleCallback(event: TelegramCallbackEvent): Promise<void> {
    const locale = this.localeForChat(event.chatId, event.languageCode);
    const interruptMatch = /^turn:interrupt:(.+)$/.exec(event.data);
    if (interruptMatch) {
      await this.handleTurnInterruptCallback(event, interruptMatch[1]!, locale);
      return;
    }
    const threadMatch = /^thread:open:(.+)$/.exec(event.data);
    if (threadMatch) {
      await this.handleThreadOpenCallback(event, threadMatch[1]!, locale);
      return;
    }
    const navMatch = /^nav:(models|threads|reveal)$/.exec(event.data);
    if (navMatch) {
      await this.handleNavigationCallback(event, navMatch[1]! as 'models' | 'threads' | 'reveal', locale);
      return;
    }
    const settingsMatch = /^settings:(model|effort):(.+)$/.exec(event.data);
    if (settingsMatch) {
      await this.handleSettingsCallback(event, settingsMatch[1]! as 'model' | 'effort', settingsMatch[2]!, locale);
      return;
    }
    const match = /^approval:([a-f0-9]+):(accept|session|deny)$/.exec(event.data);
    if (!match) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'unsupported_action'));
      return;
    }
    const localId = match[1]!;
    const action = match[2]! as ApprovalAction;
    const approval = this.store.getPendingApproval(localId);
    if (!approval || approval.resolvedAt) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'approval_already_resolved'));
      return;
    }
    if (approval.chatId !== event.chatId || (approval.messageId !== null && approval.messageId !== event.messageId)) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'approval_mismatch'));
      return;
    }

    const result = mapApprovalDecision(action);
    await this.app.respond(approval.serverRequestId, result);
    this.store.markApprovalResolved(localId);
    this.clearApprovalTimer(localId);
    await this.bot.answerCallback(event.callbackQueryId, t(locale, 'decision_recorded'));
    if (approval.messageId !== null) {
      await this.bot.editMessage(event.chatId, approval.messageId, renderApprovalMessage(locale, approval, action));
    }
    this.updateStatus();
  }

  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    switch (notification.method) {
      case 'sessionConfigured': {
        const params = notification.params as any;
        const threadId = String(params.session_id || '');
        if (!threadId) return;
        const chatId = this.findChatByThread(threadId);
        if (!chatId) return;
        const binding = this.store.getBinding(chatId);
        const cwd = params.cwd ? String(params.cwd) : binding?.cwd ?? null;
        this.store.setBinding(chatId, threadId, cwd);
        const current = this.store.getChatSettings(chatId);
        const preserveDefaultModel = current !== null && current.model === null;
        const preserveDefaultEffort = current !== null && current.reasoningEffort === null;
        this.store.setChatSettings(
          chatId,
          preserveDefaultModel
            ? null
            : params.model
              ? String(params.model)
              : current?.model ?? null,
          preserveDefaultEffort
            ? null
            : params.reasoning_effort === undefined
              ? current?.reasoningEffort ?? null
              : params.reasoning_effort === null
                ? null
                : String(params.reasoning_effort) as ReasoningEffortValue,
        );
        this.updateStatus();
        return;
      }
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
        active.finalText = String(params.item.text || active.buffer || t(this.localeForChat(active.chatId), 'completed'));
        return;
      }
      case 'turn/completed': {
        const params = notification.params as any;
        const active = this.activeTurns.get(String(params.turn?.id));
        if (!active) return;
        try {
          await this.completeTurn(active);
          if (this.config.codexAppSyncOnTurnComplete) {
            const revealError = await this.tryRevealThread(active.chatId, active.threadId, 'turn-complete');
            if (revealError) {
              this.logger.warn('codex.reveal_thread_failed', {
                chatId: active.chatId,
                threadId: active.threadId,
                reason: 'turn-complete',
                error: revealError,
              });
            }
          }
        } finally {
          active.resolver();
          this.activeTurns.delete(active.turnId);
          this.updateStatus();
        }
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
        const locale = this.localeForChat(approval.chatId);
        const messageId = await this.bot.sendMessage(approval.chatId, renderApprovalMessage(locale, approval), approvalKeyboard(locale, approval.localId));
        this.store.updatePendingApprovalMessage(approval.localId, messageId);
        this.armApprovalTimer(approval.localId);
        this.updateStatus();
        return;
      }
      case 'item/fileChange/requestApproval': {
        const params = request.params as any;
        const approval = this.createApprovalRecord('fileChange', request.id, params);
        const locale = this.localeForChat(approval.chatId);
        const messageId = await this.bot.sendMessage(approval.chatId, renderApprovalMessage(locale, approval), approvalKeyboard(locale, approval.localId));
        this.store.updatePendingApprovalMessage(approval.localId, messageId);
        this.armApprovalTimer(approval.localId);
        this.updateStatus();
        return;
      }
      case 'item/tool/requestUserInput': {
        const params = request.params as any;
        const chatId = this.findChatByThread(params.threadId);
        if (chatId) {
          await this.bot.sendMessage(chatId, t(this.localeForChat(chatId), 'interactive_input_unsupported'));
        }
        await this.app.respond(request.id, { answers: {} });
        return;
      }
      default: {
        await this.app.respondError(request.id, `Unsupported server request: ${request.method}`);
      }
    }
  }

  private async createBinding(chatId: string, requestedCwd: string | null): Promise<ThreadBinding> {
    const cwd = requestedCwd || this.config.defaultCwd;
    const settings = this.store.getChatSettings(chatId);
    const session = await this.app.startThread({
      cwd,
      approvalPolicy: this.config.defaultApprovalPolicy,
      model: settings?.model ?? null,
    });
    return this.storeThreadSession(chatId, session, 'seed');
  }

  private async startTurnWithRecovery(chatId: string, binding: Pick<ThreadBinding, 'threadId' | 'cwd'>, input: TurnInput[]): Promise<{ threadId: string; turnId: string }> {
    const settings = this.store.getChatSettings(chatId);
    try {
      const turn = await this.app.startTurn({
        threadId: binding.threadId,
        input,
        approvalPolicy: this.config.defaultApprovalPolicy,
        cwd: binding.cwd ?? this.config.defaultCwd,
        model: settings?.model ?? null,
        effort: settings?.reasoningEffort ?? null,
      });
      return { threadId: binding.threadId, turnId: turn.id };
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }
      this.logger.warn('codex.turn_thread_not_found', { chatId, threadId: binding.threadId });
      const replacement = await this.createBinding(chatId, binding.cwd ?? this.config.defaultCwd);
      await this.bot.sendMessage(chatId, t(this.localeForChat(chatId), 'current_thread_unavailable_continued', { threadId: replacement.threadId }));
      const nextSettings = this.store.getChatSettings(chatId);
      const turn = await this.app.startTurn({
        threadId: replacement.threadId,
        input,
        approvalPolicy: this.config.defaultApprovalPolicy,
        cwd: replacement.cwd ?? this.config.defaultCwd,
        model: nextSettings?.model ?? null,
        effort: nextSettings?.reasoningEffort ?? null,
      });
      return { threadId: replacement.threadId, turnId: turn.id };
    }
  }

  private async buildTurnInput(
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    event: TelegramTextEvent,
    locale: AppLocale,
  ): Promise<TurnInput[]> {
    if (event.attachments.length === 0) {
      return [{
        type: 'text',
        text: event.text,
        text_elements: [],
      }];
    }

    const cwd = binding.cwd ?? this.config.defaultCwd;
    const stagedAttachments = await this.stageAttachments(cwd, binding.threadId, event.attachments, locale);
    const prompt = buildAttachmentPrompt(event.text, stagedAttachments);
    const input: TurnInput[] = [{
      type: 'text',
      text: prompt,
      text_elements: [],
    }];
    for (const attachment of stagedAttachments) {
      if (!attachment.nativeImage) continue;
      input.push({
        type: 'localImage',
        path: attachment.localPath,
      });
    }
    return input;
  }

  private async stageAttachments(
    cwd: string,
    threadId: string,
    attachments: readonly TelegramInboundAttachment[],
    locale: AppLocale,
  ): Promise<StagedTelegramAttachment[]> {
    const staged: StagedTelegramAttachment[] = [];
    for (const attachment of attachments) {
      try {
        const remoteFile = await this.bot.getFile(attachment.fileId);
        const resolvedSize = attachment.fileSize ?? remoteFile.file_size ?? null;
        if (resolvedSize !== null && resolvedSize > TELEGRAM_BOT_API_DOWNLOAD_LIMIT_BYTES) {
          throw new UserFacingError(t(locale, 'attachment_too_large', {
            name: attachment.fileName ?? attachment.fileUniqueId,
            size: resolvedSize,
          }));
        }
        if (!remoteFile.file_path) {
          throw new Error('Telegram file path is missing');
        }
        const planned = planAttachmentStoragePath(cwd, threadId, attachment, remoteFile.file_path);
        await fs.mkdir(path.dirname(planned.localPath), { recursive: true });
        await this.bot.downloadResolvedFile(remoteFile.file_path, planned.localPath);
        const resolvedAttachment: TelegramInboundAttachment = {
          ...attachment,
          fileName: planned.fileName,
          fileSize: resolvedSize,
        };
        staged.push({
          ...resolvedAttachment,
          fileName: planned.fileName,
          localPath: planned.localPath,
          relativePath: planned.relativePath,
          nativeImage: isNativeImageAttachment(resolvedAttachment),
        });
      } catch (error) {
        if (error instanceof UserFacingError) {
          throw error;
        }
        throw new Error(t(locale, 'attachment_download_failed', {
          name: attachment.fileName ?? attachment.fileUniqueId,
          error: formatUserError(error),
        }));
      }
    }
    return staged;
  }

  private async registerActiveTurn(chatId: string, threadId: string, turnId: string, previewMessageId: number): Promise<void> {
    let resolveTurn!: () => void;
    const waitForTurn = new Promise<void>((resolve) => {
      resolveTurn = resolve;
    });
    const active: ActiveTurn = {
      chatId,
      threadId,
      turnId,
      previewMessageId,
      buffer: '',
      finalText: null,
      interruptRequested: false,
      lastFlushAt: 0,
      resolver: resolveTurn,
    };
    this.activeTurns.set(turnId, active);
    this.updateStatus();
    try {
      await this.bot.editMessage(
        chatId,
        previewMessageId,
        this.renderActivePreview(active),
        activeTurnKeyboard(this.localeForChat(chatId), turnId),
      );
    } catch (error) {
      this.logger.warn('telegram.preview_keyboard_attach_failed', { error: String(error), turnId });
    }
    await waitForTurn;
  }

  private async flushPreview(active: ActiveTurn, force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - active.lastFlushAt < this.config.telegramPreviewThrottleMs) return;
    const text = this.renderActivePreview(active);
    active.lastFlushAt = now;
    try {
      await this.bot.editMessage(
        active.chatId,
        active.previewMessageId,
        text,
        active.interruptRequested ? [] : activeTurnKeyboard(this.localeForChat(active.chatId), active.turnId),
      );
    } catch (error) {
      this.logger.warn('telegram.preview_edit_failed', { error: String(error) });
    }
  }

  private async completeTurn(active: ActiveTurn): Promise<void> {
    const locale = this.localeForChat(active.chatId);
    const finalChunks = chunkTelegramMessage(active.finalText || active.buffer || t(locale, 'completed'));
    for (const chunk of finalChunks) {
      await this.bot.sendMessage(active.chatId, chunk);
    }

    try {
      await this.bot.deleteMessage(active.chatId, active.previewMessageId);
    } catch (error) {
      this.logger.warn('telegram.preview_delete_failed', { error: String(error) });
      try {
        await this.bot.editMessage(active.chatId, active.previewMessageId, t(locale, 'completed_see_reply_below'), []);
      } catch (fallbackError) {
        this.logger.warn('telegram.preview_cleanup_failed', { error: String(fallbackError) });
      }
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
      const session = await this.app.resumeThread({ threadId: binding.threadId });
      return this.storeThreadSession(chatId, session, 'seed');
    } catch (error) {
      if (!isThreadNotFoundError(error)) {
        throw error;
      }
      this.logger.warn('codex.thread_binding_stale', { chatId, threadId: binding.threadId });
      const replacement = await this.createBinding(chatId, binding.cwd ?? this.config.defaultCwd);
      await this.bot.sendMessage(chatId, t(this.localeForChat(chatId), 'previous_thread_unavailable_started', { threadId: replacement.threadId }));
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
      await this.bot.sendMessage(chatId, t(this.localeForChat(chatId), 'bridge_error', { error: formatUserError(error) }));
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
      const locale = this.localeForChat(approval.chatId);
      if (approval.messageId !== null) {
        await this.bot.editMessage(approval.chatId, approval.messageId, renderApprovalMessage(locale, approval, 'deny'));
      } else {
        await this.bot.sendMessage(approval.chatId, t(locale, 'approval_timed_out_denied', { threadId: approval.threadId }));
      }
    } catch (error) {
      this.lastError = String(error);
      this.logger.error('approval.timeout_failed', { localId, error: String(error) });
    } finally {
      this.clearApprovalTimer(localId);
      this.updateStatus();
    }
  }

  private async tryRevealThread(chatId: string, threadId: string, reason: 'open' | 'reveal' | 'turn-complete'): Promise<string | null> {
    try {
      await this.app.revealThread(threadId);
      this.store.insertAudit('outbound', chatId, 'codex.app.reveal', `${reason}:${threadId}`);
      return null;
    } catch (error) {
      return formatUserError(error);
    }
  }

  private async bindCachedThread(chatId: string, threadId: string): Promise<ThreadBinding> {
    const session = await this.app.resumeThread({ threadId });
    return this.storeThreadSession(chatId, session, 'replace');
  }

  private storeThreadSession(chatId: string, session: ThreadSessionState, syncMode: 'replace' | 'seed'): ThreadBinding {
    const existing = this.store.getChatSettings(chatId);
    const hasExisting = existing !== null;
    const model = syncMode === 'seed'
      ? hasExisting ? existing.model : session.model
      : session.model;
    const effort = syncMode === 'seed'
      ? hasExisting ? existing.reasoningEffort : session.reasoningEffort
      : session.reasoningEffort;
    const normalized: ThreadBinding = {
      chatId,
      threadId: session.thread.threadId,
      cwd: session.cwd,
      updatedAt: Date.now(),
    };
    this.store.setBinding(chatId, normalized.threadId, normalized.cwd);
    this.store.setChatSettings(chatId, model, effort);
    this.attachedThreads.add(normalized.threadId);
    this.updateStatus();
    return normalized;
  }

  private localeForChat(chatId: string, languageCode?: string | null): AppLocale {
    if (languageCode) {
      const locale = normalizeLocale(languageCode);
      const current = this.store.getChatSettings(chatId);
      if (current?.locale !== locale) {
        this.store.setChatLocale(chatId, locale);
      }
      return locale;
    }
    return this.store.getChatSettings(chatId)?.locale ?? 'en';
  }

  private findActiveTurn(chatId: string): ActiveTurn | undefined {
    return [...this.activeTurns.values()].find(turn => turn.chatId === chatId);
  }

  private async handleModelCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    if (args.length === 0) {
      await this.showModelSettingsPanel(event.chatId, undefined, locale);
      return;
    }

    if (this.findActiveTurn(event.chatId)) {
      await this.bot.sendMessage(event.chatId, t(locale, 'model_change_blocked'));
      return;
    }
    const settings = this.store.getChatSettings(event.chatId);
    const raw = args.join(' ').trim();
    const models = await this.app.listModels();
    if (raw === '' || raw.toLowerCase() === 'default' || raw.toLowerCase() === 'reset') {
      const defaultModel = resolveCurrentModel(models, null);
      const nextEffort = clampEffortToModel(defaultModel, settings?.reasoningEffort ?? null);
      this.store.setChatSettings(event.chatId, null, nextEffort.effort);
      const lines = [
        t(locale, 'model_reset'),
        t(locale, 'status_configured_effort', { value: nextEffort.effort ?? t(locale, 'server_default') }),
        t(locale, 'applies_next_turn'),
        t(locale, 'tip_use_models'),
      ];
      if (nextEffort.adjustedFrom) {
        lines.splice(1, 0, t(locale, 'effort_adjusted_default_model', { effort: nextEffort.adjustedFrom }));
      }
      await this.bot.sendMessage(event.chatId, lines.join('\n'));
      return;
    }

    const selected = resolveRequestedModel(models, raw);
    if (!selected) {
      await this.bot.sendMessage(event.chatId, t(locale, 'unknown_model', { model: raw }));
      return;
    }

    const nextEffort = clampEffortToModel(selected, settings?.reasoningEffort ?? null);
    this.store.setChatSettings(event.chatId, selected.model, nextEffort.effort);
    const lines = [
      t(locale, 'model_configured', { model: selected.model }),
      t(locale, 'status_configured_effort', { value: nextEffort.effort ?? t(locale, 'server_default') }),
      t(locale, 'applies_next_turn'),
      t(locale, 'tip_use_models'),
    ];
    if (nextEffort.adjustedFrom) {
      lines.splice(1, 0, t(locale, 'effort_adjusted_model', { effort: nextEffort.adjustedFrom, model: selected.model }));
    }
    await this.bot.sendMessage(event.chatId, lines.join('\n'));
  }

  private async handleEffortCommand(event: TelegramTextEvent, locale: AppLocale, args: string[]): Promise<void> {
    if (args.length === 0) {
      await this.showModelSettingsPanel(event.chatId, undefined, locale);
      return;
    }

    if (this.findActiveTurn(event.chatId)) {
      await this.bot.sendMessage(event.chatId, t(locale, 'effort_change_blocked'));
      return;
    }
    const settings = this.store.getChatSettings(event.chatId);
    const models = await this.app.listModels();
    const currentModel = resolveCurrentModel(models, settings?.model ?? null);
    const raw = args.join(' ').trim().toLowerCase();
    if (raw === 'default' || raw === 'reset') {
      this.store.setChatSettings(event.chatId, settings?.model ?? null, null);
      await this.bot.sendMessage(event.chatId, [
        t(locale, 'effort_reset'),
        t(locale, 'applies_next_turn'),
        t(locale, 'tip_use_models'),
      ].join('\n'));
      return;
    }

    const effort = normalizeRequestedEffort(raw);
    if (!effort) {
      await this.bot.sendMessage(event.chatId, t(locale, 'usage_effort'));
      return;
    }
    if (currentModel && currentModel.supportedReasoningEfforts.length > 0 && !currentModel.supportedReasoningEfforts.includes(effort)) {
      await this.bot.sendMessage(
        event.chatId,
        t(locale, 'model_does_not_support_effort', {
          model: currentModel.model,
          effort,
          supported: currentModel.supportedReasoningEfforts.join(', '),
        }),
      );
      return;
    }
    this.store.setChatSettings(event.chatId, settings?.model ?? null, effort);
    await this.bot.sendMessage(event.chatId, [
      t(locale, 'effort_configured', { effort }),
      t(locale, 'applies_next_turn'),
      t(locale, 'tip_use_models'),
    ].join('\n'));
  }

  private async handleThreadOpenCallback(event: TelegramCallbackEvent, threadId: string, locale: AppLocale): Promise<void> {
    let binding: ThreadBinding;
    try {
      binding = await this.bindCachedThread(event.chatId, threadId);
    } catch (error) {
      if (isThreadNotFoundError(error)) {
        await this.bot.answerCallback(event.callbackQueryId, t(locale, 'thread_no_longer_available'));
        return;
      }
      throw error;
    }

    const threads = this.store.listCachedThreads(event.chatId);
    if (threads.length > 0) {
      await this.bot.editHtmlMessage(
        event.chatId,
        event.messageId,
        formatThreadsMessage(locale, threads, binding.threadId),
        buildThreadsKeyboard(locale, threads),
      );
    }

    let callbackText = t(locale, 'thread_opened');
    if (this.config.codexAppSyncOnOpen) {
      const revealError = await this.tryRevealThread(event.chatId, binding.threadId, 'open');
      callbackText = revealError ? t(locale, 'opened_sync_failed_short') : t(locale, 'opened_in_codex_short');
    }
    await this.bot.answerCallback(event.callbackQueryId, callbackText);
  }

  private async handleTurnInterruptCallback(event: TelegramCallbackEvent, turnId: string, locale: AppLocale): Promise<void> {
    const active = this.activeTurns.get(turnId);
    if (!active || active.chatId !== event.chatId) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'turn_already_finished'));
      return;
    }
    if (active.interruptRequested) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'interrupt_already_requested'));
      return;
    }
    active.interruptRequested = true;
    try {
      await this.requestInterrupt(active);
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'interrupt_requested'));
    } catch (error) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'interrupt_failed', { error: formatUserError(error) }));
    }
  }

  private async handleNavigationCallback(
    event: TelegramCallbackEvent,
    target: 'models' | 'threads' | 'reveal',
    locale: AppLocale,
  ): Promise<void> {
    if (target === 'models') {
      await this.showModelSettingsPanel(event.chatId, event.messageId, locale);
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'opened_model_settings'));
      return;
    }
    if (target === 'threads') {
      await this.showThreadsPanel(event.chatId, event.messageId, undefined, locale);
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'opened_thread_list'));
      return;
    }

    const binding = this.store.getBinding(event.chatId);
    if (!binding) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'no_thread_bound_callback'));
      return;
    }
    const readyBinding = await this.ensureThreadReady(event.chatId, binding);
    const revealError = await this.tryRevealThread(event.chatId, readyBinding.threadId, 'reveal');
    await this.bot.answerCallback(event.callbackQueryId, revealError ? t(locale, 'reveal_failed', { error: revealError }) : t(locale, 'opened_in_codex_short'));
  }

  private async showWherePanel(chatId: string, messageId?: number, locale = this.localeForChat(chatId)): Promise<void> {
    const binding = this.store.getBinding(chatId);
    const settings = this.store.getChatSettings(chatId);
    if (!binding) {
      const text = [
        t(locale, 'where_no_thread_bound'),
        t(locale, 'where_configured_model', { value: settings?.model ?? t(locale, 'server_default') }),
        t(locale, 'where_configured_effort', { value: settings?.reasoningEffort ?? t(locale, 'server_default') }),
        t(locale, 'where_send_message_or_new'),
      ].join('\n');
      if (messageId !== undefined) {
        await this.bot.editMessage(chatId, messageId, text, whereKeyboard(locale, false));
        return;
      }
      await this.bot.sendMessage(chatId, text, whereKeyboard(locale, false));
      return;
    }

    const readyBinding = await this.ensureThreadReady(chatId, binding);
    const thread = await this.app.readThread(readyBinding.threadId, false);
    if (!thread) {
      const text = t(locale, 'where_thread_unavailable', { threadId: readyBinding.threadId });
      if (messageId !== undefined) {
        await this.bot.editMessage(chatId, messageId, text, whereKeyboard(locale, false));
        return;
      }
      await this.bot.sendMessage(chatId, text, whereKeyboard(locale, false));
      return;
    }

    const text = formatWhereMessage(locale, thread, this.store.getChatSettings(chatId), this.config.defaultCwd);
    if (messageId !== undefined) {
      await this.bot.editMessage(chatId, messageId, text, whereKeyboard(locale, true));
      return;
    }
    await this.bot.sendMessage(chatId, text, whereKeyboard(locale, true));
  }

  private async showThreadsPanel(chatId: string, messageId?: number, searchTerm?: string | null, locale = this.localeForChat(chatId)): Promise<void> {
    const binding = this.store.getBinding(chatId);
    const threads = await this.app.listThreads({
      limit: this.config.threadListLimit,
      searchTerm: searchTerm ?? null,
    });
    const cached = threads.map((thread) => ({
      threadId: thread.threadId,
      name: thread.name,
      preview: thread.preview,
      cwd: thread.cwd,
      modelProvider: thread.modelProvider,
      status: thread.status,
      updatedAt: thread.updatedAt,
    }));
    this.store.cacheThreadList(chatId, cached);
    const text = formatThreadsMessage(locale, cached, binding?.threadId ?? null, searchTerm ?? null);
    const keyboard = buildThreadsKeyboard(locale, cached);
    if (messageId !== undefined) {
      await this.bot.editHtmlMessage(chatId, messageId, text, keyboard);
      return;
    }
    await this.bot.sendHtmlMessage(chatId, text, keyboard);
  }

  private async showModelSettingsPanel(chatId: string, messageId?: number, locale = this.localeForChat(chatId)): Promise<void> {
    const models = await this.app.listModels();
    const settings = this.store.getChatSettings(chatId);
    const text = formatModelSettingsMessage(locale, models, settings);
    const keyboard = buildModelSettingsKeyboard(locale, models, settings);
    if (messageId !== undefined) {
      await this.bot.editHtmlMessage(chatId, messageId, text, keyboard);
      return;
    }
    await this.bot.sendHtmlMessage(chatId, text, keyboard);
  }

  private async handleSettingsCallback(
    event: TelegramCallbackEvent,
    kind: 'model' | 'effort',
    rawValue: string,
    locale: AppLocale,
  ): Promise<void> {
    if (this.findActiveTurn(event.chatId)) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'wait_current_turn'));
      return;
    }

    const models = await this.app.listModels();
    const settings = this.store.getChatSettings(event.chatId);
    const value = kind === 'model' ? decodeURIComponent(rawValue) : rawValue;

    if (kind === 'model') {
      if (value === 'default') {
        const defaultModel = resolveCurrentModel(models, null);
        const nextEffort = clampEffortToModel(defaultModel, settings?.reasoningEffort ?? null);
        this.store.setChatSettings(event.chatId, null, nextEffort.effort);
        await this.refreshModelSettingsPanel(event.chatId, event.messageId, locale, models);
        await this.bot.answerCallback(event.callbackQueryId, t(locale, 'using_server_default_model'));
        return;
      }
      const selected = resolveRequestedModel(models, value);
      if (!selected) {
        await this.bot.answerCallback(event.callbackQueryId, t(locale, 'model_no_longer_available'));
        return;
      }
      const nextEffort = clampEffortToModel(selected, settings?.reasoningEffort ?? null);
      this.store.setChatSettings(event.chatId, selected.model, nextEffort.effort);
      await this.refreshModelSettingsPanel(event.chatId, event.messageId, locale, models);
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'callback_model', { model: selected.model }));
      return;
    }

    if (value === 'default') {
      this.store.setChatSettings(event.chatId, settings?.model ?? null, null);
      await this.refreshModelSettingsPanel(event.chatId, event.messageId, locale, models);
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'using_default_effort'));
      return;
    }

    const effort = normalizeRequestedEffort(value);
    if (!effort) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'unknown_effort'));
      return;
    }
    const currentModel = resolveCurrentModel(models, settings?.model ?? null);
    if (currentModel && currentModel.supportedReasoningEfforts.length > 0 && !currentModel.supportedReasoningEfforts.includes(effort)) {
      await this.bot.answerCallback(event.callbackQueryId, t(locale, 'effort_not_supported_by_model'));
      return;
    }
    this.store.setChatSettings(event.chatId, settings?.model ?? null, effort);
    await this.refreshModelSettingsPanel(event.chatId, event.messageId, locale, models);
    await this.bot.answerCallback(event.callbackQueryId, t(locale, 'callback_effort', { effort }));
  }

  private async refreshModelSettingsPanel(chatId: string, messageId: number, locale: AppLocale, models?: ModelInfo[]): Promise<void> {
    const resolvedModels = models ?? await this.app.listModels();
    const settings = this.store.getChatSettings(chatId);
    await this.bot.editHtmlMessage(
      chatId,
      messageId,
      formatModelSettingsMessage(locale, resolvedModels, settings),
      buildModelSettingsKeyboard(locale, resolvedModels, settings),
    );
  }

  private async requestInterrupt(active: ActiveTurn): Promise<void> {
    active.interruptRequested = true;
    try {
      await this.app.interruptTurn(active.threadId, active.turnId);
      await this.bot.editMessage(
        active.chatId,
        active.previewMessageId,
        this.renderActivePreview(active),
        [],
      );
    } catch (error) {
      active.interruptRequested = false;
      throw error;
    }
  }

  private renderActivePreview(active: ActiveTurn): string {
    const locale = this.localeForChat(active.chatId);
    const content = active.buffer || active.finalText || t(locale, 'working');
    if (!active.interruptRequested) {
      return sanitizeTelegramPreview(content);
    }
    return sanitizeTelegramPreview(`${t(locale, 'interrupt_requested_preview')}\n\n${content}`);
  }
}

function approvalKeyboard(locale: AppLocale, localId: string): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: t(locale, 'button_allow'), callback_data: `approval:${localId}:accept` },
    { text: t(locale, 'button_allow_session'), callback_data: `approval:${localId}:session` },
    { text: t(locale, 'button_deny'), callback_data: `approval:${localId}:deny` },
  ]];
}

function activeTurnKeyboard(locale: AppLocale, turnId: string): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: t(locale, 'button_interrupt'), callback_data: `turn:interrupt:${turnId}` },
  ]];
}

function whereKeyboard(locale: AppLocale, hasBinding: boolean): Array<Array<{ text: string; callback_data: string }>> {
  const firstRow = [{ text: t(locale, 'button_models'), callback_data: 'nav:models' }];
  const secondRow = [{ text: t(locale, 'button_threads'), callback_data: 'nav:threads' }];
  if (!hasBinding) {
    return [firstRow, secondRow];
  }
  return [
    [{ text: t(locale, 'button_reveal'), callback_data: 'nav:reveal' }, ...firstRow],
    secondRow,
  ];
}

function renderApprovalMessage(locale: AppLocale, record: PendingApprovalRecord, decision?: ApprovalAction): string {
  const lines = [
    t(locale, 'approval_requested', {
      kind: record.kind === 'fileChange' ? t(locale, 'approval_kind_fileChange') : t(locale, 'approval_kind_command'),
    }),
    t(locale, 'line_thread', { value: record.threadId }),
    t(locale, 'line_turn', { value: record.turnId }),
  ];
  if (record.command) lines.push(t(locale, 'line_command', { value: record.command }));
  if (record.cwd) lines.push(t(locale, 'line_cwd', { value: record.cwd }));
  if (record.reason) lines.push(t(locale, 'line_reason', { value: record.reason }));
  if (decision) {
    const decisionKey = decision === 'accept'
      ? 'approval_decision_accept'
      : decision === 'session'
        ? 'approval_decision_session'
        : 'approval_decision_deny';
    lines.push(t(locale, 'line_decision', { value: t(locale, decisionKey) }));
  }
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
