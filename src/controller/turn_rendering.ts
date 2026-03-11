import crypto from 'node:crypto';
import type { Logger } from '../logger.js';
import type { AppLocale, PendingApprovalRecord } from '../types.js';
import { t } from '../i18n.js';
import { chunkTelegramStreamMessage, clipTelegramDraftMessage } from '../telegram/text.js';
import { renderActiveTurnStatus } from './status.js';
import type { RawExecCommandEvent, TurnOutputKind } from './activity.js';

type InlineKeyboard = Array<Array<{ text: string; callback_data: string }>>;

export interface RenderedTelegramMessage {
  messageId: number;
  text: string;
}

export interface TurnSegmentState {
  itemId: string;
  phase: string | null;
  outputKind: TurnOutputKind;
  text: string;
  completed: boolean;
  messages: RenderedTelegramMessage[];
}

export interface ToolBatchCounts {
  files: number;
  searches: number;
  edits: number;
  commands: number;
}

export interface ToolBatchState {
  openCallIds: Set<string>;
  actionKeys: Set<string>;
  actionLines: string[];
  counts: ToolBatchCounts;
  finalizeTimer: NodeJS.Timeout | null;
}

export interface ArchivedStatusContent {
  text: string;
  html: string | null;
}

export interface TurnRenderingState {
  scopeId: string;
  threadId: string;
  turnId: string;
  renderRoute: { currentRenderer: string };
  previewMessageId: number;
  previewActive: boolean;
  draftId: number | null;
  draftText: string | null;
  interruptRequested: boolean;
  statusMessageText: string | null;
  statusNeedsRebase: boolean;
  segments: TurnSegmentState[];
  reasoningActiveCount: number;
  pendingApprovalKinds: Set<PendingApprovalRecord['kind']>;
  pendingUserInputId: string | null;
  toolBatch: ToolBatchState | null;
  pendingArchivedStatus: ArchivedStatusContent | null;
  renderRetryTimer: NodeJS.Timeout | null;
  lastStreamFlushAt: number;
  renderRequested: boolean;
  forceStatusFlush: boolean;
  forceStreamFlush: boolean;
  renderTask: Promise<void> | null;
}

interface ToolDescriptor {
  kind: keyof ToolBatchCounts;
  key: string;
  line: string;
}

interface TurnRenderingHost {
  logger: Logger;
  config: {
    telegramPreviewThrottleMs: number;
  };
  localeForChat: (scopeId: string) => AppLocale;
  countQueuedTurns: (scopeId: string) => number;
  sendMessage: (scopeId: string, text: string, inlineKeyboard?: InlineKeyboard) => Promise<number>;
  editMessage: (scopeId: string, messageId: number, text: string, inlineKeyboard?: InlineKeyboard) => Promise<void>;
  deleteMessage: (scopeId: string, messageId: number) => Promise<void>;
  sendDraft: (scopeId: string, draftId: number, text: string) => Promise<void>;
  syncTurnStatus: (active: TurnRenderingState, force: boolean) => Promise<void>;
  scheduleRenderRetry: (active: TurnRenderingState, delayMs?: number) => void;
  isTurnActive: (turnId: string) => boolean;
}

export class TurnRenderingCoordinator {
  constructor(private readonly host: TurnRenderingHost) {}

  async queueRender(
    active: TurnRenderingState,
    options: { forceStatus?: boolean; forceStream?: boolean } = {},
  ): Promise<void> {
    this.clearRenderRetry(active);
    active.renderRequested = true;
    active.forceStatusFlush = active.forceStatusFlush || Boolean(options.forceStatus);
    active.forceStreamFlush = active.forceStreamFlush || Boolean(options.forceStream);
    if (active.renderTask) {
      await active.renderTask;
      return;
    }
    active.renderTask = (async () => {
      while (active.renderRequested) {
        const forceStatus = active.forceStatusFlush;
        const forceStream = active.forceStreamFlush;
        active.renderRequested = false;
        active.forceStatusFlush = false;
        active.forceStreamFlush = false;
        await this.syncTurnStream(active, forceStream);
        await this.host.syncTurnStatus(active, forceStatus);
      }
    })().finally(() => {
      active.renderTask = null;
    });
    await active.renderTask;
  }

  noteToolCommandStart(active: TurnRenderingState, event: RawExecCommandEvent): void {
    if (!active.toolBatch) {
      active.toolBatch = createToolBatchState();
    }
    this.clearToolBatchTimer(active.toolBatch);
    active.toolBatch.openCallIds.add(event.callId);
    const descriptors = describeExecCommand(event);
    for (const descriptor of descriptors) {
      if (active.toolBatch.actionKeys.has(descriptor.key)) {
        continue;
      }
      active.toolBatch.actionKeys.add(descriptor.key);
      active.toolBatch.actionLines.push(descriptor.line);
      incrementToolBatchCount(active.toolBatch.counts, descriptor.kind);
    }
  }

  noteToolCommandEnd(active: TurnRenderingState, event: RawExecCommandEvent): void {
    if (!active.toolBatch) {
      active.toolBatch = createToolBatchState();
    }
    const descriptors = describeExecCommand(event);
    for (const descriptor of descriptors) {
      if (active.toolBatch.actionKeys.has(descriptor.key)) {
        continue;
      }
      active.toolBatch.actionKeys.add(descriptor.key);
      active.toolBatch.actionLines.push(descriptor.line);
      incrementToolBatchCount(active.toolBatch.counts, descriptor.kind);
    }
    active.toolBatch.openCallIds.delete(event.callId);
    this.scheduleToolBatchArchive(active);
  }

  promoteReadyToolBatch(active: TurnRenderingState): void {
    const batch = active.toolBatch;
    if (!batch || batch.openCallIds.size > 0) {
      return;
    }
    this.clearToolBatchTimer(batch);
    active.pendingArchivedStatus = renderArchivedToolBatchStatus(this.host.localeForChat(active.scopeId), batch.counts, batch.actionLines);
    active.toolBatch = null;
  }

  clearToolBatchTimer(batch: ToolBatchState | null): void {
    if (!batch?.finalizeTimer) {
      return;
    }
    clearTimeout(batch.finalizeTimer);
    batch.finalizeTimer = null;
  }

  scheduleRenderRetry(active: TurnRenderingState, delayMs = 1500): void {
    if (active.renderRetryTimer) {
      return;
    }
    active.renderRetryTimer = setTimeout(() => {
      active.renderRetryTimer = null;
      if (!this.host.isTurnActive(active.turnId)) {
        return;
      }
      void this.queueRender(active, { forceStatus: true, forceStream: true });
    }, delayMs);
  }

  clearRenderRetry(active: TurnRenderingState): void {
    if (!active.renderRetryTimer) {
      return;
    }
    clearTimeout(active.renderRetryTimer);
    active.renderRetryTimer = null;
  }

  findStreamingSegment(active: TurnRenderingState): TurnSegmentState | null {
    return [...active.segments].reverse().find(segment => !segment.completed && segment.text.trim()) ?? null;
  }

  renderActiveStatus(active: TurnRenderingState): string {
    const locale = this.host.localeForChat(active.scopeId);
    const baseStatus = renderActiveTurnStatus(locale, {
      interruptRequested: active.interruptRequested,
      pendingApprovalKinds: active.pendingApprovalKinds,
      awaitingUserInput: active.pendingUserInputId !== null,
      toolStatusText: active.toolBatch
        ? formatToolBatchStatus(locale, active.toolBatch.counts, active.toolBatch.actionLines, true)
        : null,
      reasoningActive: active.reasoningActiveCount > 0,
      hasStreamingReply: this.findStreamingSegment(active) !== null,
    });
    const queuedTurns = this.host.countQueuedTurns(active.scopeId);
    return queuedTurns > 0
      ? `${baseStatus}\n${t(locale, 'queue_status_inline', { value: queuedTurns })}`
      : baseStatus;
  }

  private scheduleToolBatchArchive(active: TurnRenderingState): void {
    const batch = active.toolBatch;
    if (!batch || batch.openCallIds.size > 0) {
      return;
    }
    this.clearToolBatchTimer(batch);
    batch.finalizeTimer = setTimeout(() => {
      if (!this.host.isTurnActive(active.turnId) || active.toolBatch !== batch || batch.openCallIds.size > 0) {
        return;
      }
      batch.finalizeTimer = null;
      active.pendingArchivedStatus = renderArchivedToolBatchStatus(this.host.localeForChat(active.scopeId), batch.counts, batch.actionLines);
      active.toolBatch = null;
      void this.queueRender(active, { forceStatus: true });
    }, 600);
  }

  private async syncTurnStream(active: TurnRenderingState, force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && now - active.lastStreamFlushAt < this.host.config.telegramPreviewThrottleMs) {
      return;
    }

    active.lastStreamFlushAt = now;
    if (active.renderRoute.currentRenderer === 'draft_stream') {
      await this.syncDraftTurnStream(active, force);
      return;
    }

    for (const segment of active.segments) {
      await this.syncSegmentTimeline(active, segment);
    }
  }

  private async syncDraftTurnStream(active: TurnRenderingState, force: boolean): Promise<void> {
    for (const segment of active.segments) {
      if (!segment.completed) {
        continue;
      }
      await this.syncSegmentTimeline(active, segment);
    }

    const draftText = this.renderDraftStreamText(active);
    if (draftText === null) {
      active.draftText = null;
      return;
    }
    if (!force && draftText === active.draftText) {
      return;
    }
    if (!active.draftId) {
      active.draftId = crypto.randomInt(1, 2_147_483_647);
    }
    try {
      await this.host.sendDraft(active.scopeId, active.draftId, draftText);
      active.draftText = draftText;
    } catch (error) {
      this.host.logger.warn('telegram.draft_send_failed', {
        error: String(error),
        turnId: active.turnId,
        draftId: active.draftId,
      });
      this.host.scheduleRenderRetry(active);
    }
  }

  private renderDraftStreamText(active: TurnRenderingState): string | null {
    const locale = this.host.localeForChat(active.scopeId);
    const streamingSegment = this.findStreamingSegment(active);
    if (streamingSegment) {
      return clipTelegramDraftMessage(streamingSegment.text, t(locale, 'working'));
    }
    return null;
  }

  private async syncSegmentTimeline(active: TurnRenderingState, segment: TurnSegmentState): Promise<void> {
    const chunks = chunkTelegramStreamMessage(segment.text);
    let index = 0;
    while (index < chunks.length) {
      const chunk = chunks[index]!;
      const existing = segment.messages[index];
      if (!existing) {
        try {
          const messageId = await this.host.sendMessage(active.scopeId, chunk);
          segment.messages.push({ messageId, text: chunk });
          active.statusNeedsRebase = true;
        } catch (error) {
          this.host.logger.warn('telegram.stream_send_failed', {
            error: String(error),
            turnId: active.turnId,
            itemId: segment.itemId,
            chunkIndex: index,
          });
          this.host.scheduleRenderRetry(active);
          return;
        }
        index += 1;
        continue;
      }
      if (existing.text === chunk) {
        index += 1;
        continue;
      }
      try {
        await this.host.editMessage(active.scopeId, existing.messageId, chunk);
        existing.text = chunk;
        index += 1;
      } catch (error) {
        if (isTelegramMessageGone(error)) {
          segment.messages.splice(index);
          continue;
        }
        this.host.logger.warn('telegram.stream_edit_failed', {
          error: String(error),
          turnId: active.turnId,
          itemId: segment.itemId,
          messageId: existing.messageId,
          chunkIndex: index,
        });
        this.host.scheduleRenderRetry(active);
        return;
      }
    }

    while (segment.messages.length > chunks.length) {
      const stale = segment.messages.pop();
      if (!stale) {
        break;
      }
      try {
        await this.host.deleteMessage(active.scopeId, stale.messageId);
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          this.host.logger.warn('telegram.stream_delete_failed', {
            error: String(error),
            turnId: active.turnId,
            itemId: segment.itemId,
            messageId: stale.messageId,
          });
        }
      }
    }
  }
}

export function ensureTurnSegment(
  active: { segments: TurnSegmentState[] },
  itemId: string,
  phase?: string | null,
  outputKind?: TurnOutputKind,
): TurnSegmentState {
  let segment = active.segments.find((entry) => entry.itemId === itemId);
  if (segment) {
    if (phase !== undefined) {
      segment.phase = phase;
    }
    if (outputKind !== undefined) {
      segment.outputKind = outputKind;
    }
    return segment;
  }
  segment = {
    itemId,
    phase: phase ?? null,
    outputKind: outputKind ?? 'commentary',
    text: '',
    completed: false,
    messages: [],
  };
  active.segments.push(segment);
  return segment;
}

function createToolBatchState(): ToolBatchState {
  return {
    openCallIds: new Set<string>(),
    actionKeys: new Set<string>(),
    actionLines: [],
    counts: { files: 0, searches: 0, edits: 0, commands: 0 },
    finalizeTimer: null,
  };
}

function incrementToolBatchCount(counts: ToolBatchCounts, kind: keyof ToolBatchCounts): void {
  counts[kind] += 1;
}

function formatToolBatchStatus(
  locale: AppLocale,
  counts: ToolBatchCounts,
  actionLines: string[],
  inProgress: boolean,
): string {
  const heading = formatToolBatchHeading(locale, counts, inProgress);
  const detailLines = actionLines.slice(0, 6);
  if (detailLines.length === 0) {
    return heading;
  }
  return [heading, ...detailLines].join('\n');
}

function renderArchivedToolBatchStatus(
  locale: AppLocale,
  counts: ToolBatchCounts,
  actionLines: string[],
): ArchivedStatusContent {
  const text = formatToolBatchStatus(locale, counts, actionLines, false);
  if (actionLines.length === 0) {
    return { text, html: null };
  }
  const heading = formatToolBatchHeading(locale, counts, false);
  const detailLines = actionLines.slice(0, 12).map(line => escapeTelegramHtml(line));
  const html = [
    `<b>${escapeTelegramHtml(heading)}</b>`,
    `<blockquote expandable>${detailLines.join('\n')}</blockquote>`,
  ].join('\n');
  return { text, html };
}

function formatToolBatchHeading(locale: AppLocale, counts: ToolBatchCounts, inProgress: boolean): string {
  const parts = formatToolBatchCountParts(locale, counts);
  const hasBrowse = counts.files > 0 || counts.searches > 0;
  const hasEdit = counts.edits > 0;
  const hasCommand = counts.commands > 0;
  let verb: string;
  if (hasEdit && !hasBrowse && !hasCommand) {
    verb = locale === 'zh' ? (inProgress ? '正在编辑' : '已编辑') : (inProgress ? 'Editing' : 'Edited');
  } else if (hasBrowse && !hasEdit && !hasCommand) {
    verb = locale === 'zh' ? (inProgress ? '正在浏览' : '已浏览') : (inProgress ? 'Browsing' : 'Browsed');
  } else if (hasCommand && !hasBrowse && !hasEdit) {
    verb = locale === 'zh' ? (inProgress ? '正在运行' : '已运行') : (inProgress ? 'Running' : 'Ran');
  } else {
    verb = locale === 'zh' ? (inProgress ? '正在处理' : '已处理') : (inProgress ? 'Processing' : 'Processed');
  }
  if (parts.length === 0) {
    return locale === 'zh'
      ? `${verb}操作...`
      : `${verb} operations...`;
  }
  return locale === 'zh'
    ? `${verb} ${parts.join('，')}`
    : `${verb} ${parts.join(', ')}`;
}

function formatToolBatchCountParts(locale: AppLocale, counts: ToolBatchCounts): string[] {
  const parts: string[] = [];
  if (counts.files > 0) {
    parts.push(locale === 'zh' ? `${counts.files} 个文件` : pluralize(counts.files, 'file'));
  }
  if (counts.searches > 0) {
    parts.push(locale === 'zh' ? `${counts.searches} 个搜索` : pluralize(counts.searches, 'search'));
  }
  if (counts.edits > 0) {
    parts.push(locale === 'zh' ? `${counts.edits} 个编辑` : pluralize(counts.edits, 'edit'));
  }
  if (counts.commands > 0) {
    parts.push(locale === 'zh' ? `${counts.commands} 个命令` : pluralize(counts.commands, 'command'));
  }
  return parts;
}

function pluralize(count: number, noun: string): string {
  if (count === 1) {
    return `1 ${noun}`;
  }
  const plural = noun === 'search'
    ? 'searches'
    : noun === 'file'
      ? 'files'
      : `${noun}s`;
  return `${count} ${plural}`;
}

function describeExecCommand(event: RawExecCommandEvent): ToolDescriptor[] {
  const descriptors = (event.parsedCmd ?? [])
    .map((entry) => describeParsedCommand(entry))
    .filter((entry): entry is ToolDescriptor => entry !== null);
  if (descriptors.length > 0) {
    return descriptors;
  }
  const commandText = renderShellCommand(event.command);
  return [{
    kind: 'commands',
    key: `command:${commandText}`,
    line: `$ ${commandText}`,
  }];
}

function describeParsedCommand(entry: any): ToolDescriptor | null {
  const type = typeof entry?.type === 'string' ? entry.type : '';
  const path = compactPath(entry?.path ?? entry?.name ?? null);
  const query = typeof entry?.query === 'string' ? entry.query : null;
  switch (type) {
    case 'search':
      return {
        kind: 'searches',
        key: `search:${path ?? '.'}:${query ?? ''}`,
        line: path ? `Searched for ${truncateInline(query || '', 80)} in ${path}` : `Searched for ${truncateInline(query || '', 80)}`,
      };
    case 'read':
      return {
        kind: 'files',
        key: `read:${path ?? 'unknown'}`,
        line: `Read ${path ?? 'file'}`,
      };
    case 'list_files':
      return {
        kind: 'files',
        key: `list:${path ?? 'workspace'}`,
        line: path ? `Listed ${path}` : 'Listed files',
      };
    case 'write':
    case 'edit':
    case 'apply_patch':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Edited ${path ?? 'files'}`,
      };
    case 'move':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Moved ${path ?? 'files'}`,
      };
    case 'copy':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Copied ${path ?? 'files'}`,
      };
    case 'delete':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Deleted ${path ?? 'files'}`,
      };
    case 'mkdir':
      return {
        kind: 'edits',
        key: `${type}:${path ?? 'workspace'}`,
        line: `Created ${path ?? 'files'}`,
      };
    default:
      return null;
  }
}

function compactPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  return value.replace(/^\.\//, '');
}

function renderShellCommand(command: string[]): string {
  if (command.length >= 3 && (command[0] === '/bin/zsh' || command[0] === 'zsh') && command[1] === '-lc') {
    return command[2] ?? command.join(' ');
  }
  return command.join(' ');
}

function truncateInline(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

function escapeTelegramHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function formatUserError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isTelegramMessageGone(error: unknown): boolean {
  const message = formatUserError(error).toLowerCase();
  return message.includes('message to delete not found')
    || message.includes('message to edit not found')
    || message.includes('message not found');
}
