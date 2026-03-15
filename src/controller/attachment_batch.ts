import crypto from 'node:crypto';
import type { TurnInput } from '../engine/types.js';
import { t } from '../i18n.js';
import type { Logger } from '../logger.js';
import type { BridgeStore } from '../store/database.js';
import type { TelegramCallbackEvent, TelegramTextEvent } from '../telegram/gateway.js';
import { summarizeTelegramInput, type StagedTelegramAttachment, type TelegramInboundAttachment } from '../telegram/media.js';
import type {
  AppLocale,
  PendingAttachmentBatchRecord,
  PendingAttachmentBatchStatus,
  ThreadBinding,
} from '../types.js';
import type { TurnRegistry } from './bridge_runtime.js';
import type { TelegramMessageService, InlineKeyboard } from './telegram_message_service.js';
import { isTelegramMessageGone } from './telegram_message_service.js';
import { formatUserError } from './utils.js';

interface AttachmentBatchHost {
  store: BridgeStore;
  logger: Logger;
  turns: TurnRegistry;
  messages: TelegramMessageService;
  localeForChat: (scopeId: string) => AppLocale;
  stageInboundAttachments: (
    binding: Pick<ThreadBinding, 'threadId' | 'cwd'>,
    attachments: readonly TelegramInboundAttachment[],
    locale: AppLocale,
  ) => Promise<StagedTelegramAttachment[]>;
  buildTurnInputFromStagedAttachments: (text: string, stagedAttachments: readonly StagedTelegramAttachment[]) => TurnInput[];
  ensureBinding: (scopeId: string) => Promise<ThreadBinding>;
  enqueuePreparedTurnInput: (
    params: {
      scopeId: string;
      chatId: string;
      threadId: string;
      input: TurnInput[];
      sourceSummary: string;
    },
    locale: AppLocale,
  ) => Promise<unknown>;
  startIncomingTurn: (
    scopeId: string,
    chatId: string,
    chatType: string,
    topicId: number | null,
    binding: ThreadBinding,
    input: TurnInput[],
  ) => Promise<void>;
  answerCallback: (callbackQueryId: string, text: string) => Promise<void>;
  updateStatus: () => void;
}

type AttachmentBatchAction = 'next' | 'analyze' | 'clear';

const STANDALONE_BATCH_MERGE_WINDOW_MS = 2 * 60 * 1000;
const MAX_RENDERED_ATTACHMENTS = 8;

export class AttachmentBatchCoordinator {
  constructor(private readonly host: AttachmentBatchHost) {}

  async handleInboundAttachmentMessage(
    event: TelegramTextEvent,
    binding: ThreadBinding,
    text: string,
    locale: AppLocale,
  ): Promise<void> {
    const mergeTarget = this.findMergeTarget(event.scopeId, event.mediaGroupId);
    if (!mergeTarget) {
      await this.supersedeLatestPendingBatch(event.scopeId, locale);
    }

    const targetBinding = binding;
    const stagedAttachments = await this.host.stageInboundAttachments(targetBinding, event.attachments, locale);
    const noteText = mergeNoteText(mergeTarget?.noteText ?? '', text);
    const record: PendingAttachmentBatchRecord = mergeTarget
      ? {
          ...mergeTarget,
          chatId: event.chatId,
          threadId: targetBinding.threadId,
          noteText,
          attachments: mergeAttachments(mergeTarget.attachments, stagedAttachments),
          updatedAt: Date.now(),
        }
      : {
          batchId: crypto.randomBytes(8).toString('hex'),
          scopeId: event.scopeId,
          chatId: event.chatId,
          threadId: targetBinding.threadId,
          mediaGroupId: event.mediaGroupId,
          noteText,
          attachments: [...stagedAttachments],
          receiptMessageId: null,
          status: 'pending',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          resolvedAt: null,
        };

    this.host.store.savePendingAttachmentBatch(record);
    await this.presentBatchCard(record, locale);
    this.host.updateStatus();
  }

  async handleTextWithPendingBatch(event: TelegramTextEvent, text: string, locale: AppLocale): Promise<boolean> {
    const batch = this.host.store.getLatestPendingAttachmentBatch(event.scopeId);
    if (!batch) {
      return false;
    }

    const promptText = buildBatchPromptText(batch, text, locale);
    const input = this.host.buildTurnInputFromStagedAttachments(promptText, batch.attachments as StagedTelegramAttachment[]);
    const sourceSummary = summarizeTelegramInput(text || batch.noteText, batch.attachments as TelegramInboundAttachment[])
      || t(locale, 'queue_item_summary_fallback');
    const activeTurn = this.host.turns.findByScope(event.scopeId);
    if (activeTurn) {
      const settings = this.host.store.getChatSettings(event.scopeId);
      if (!(settings?.autoQueueMessages ?? true)) {
        await this.host.messages.sendMessage(event.scopeId, t(locale, 'another_turn_running'));
        return true;
      }
      await this.host.messages.sendTyping(event.scopeId);
      await this.host.enqueuePreparedTurnInput({
        scopeId: event.scopeId,
        chatId: event.chatId,
        threadId: activeTurn.threadId,
        input,
        sourceSummary,
      }, locale);
      await this.resolveBatch(batch.batchId, 'consumed', locale, 'attachment_batch_resolved_queued');
      return true;
    }

    const binding = await this.host.ensureBinding(event.scopeId);
    await this.host.messages.sendTyping(event.scopeId);
    await this.host.startIncomingTurn(event.scopeId, event.chatId, event.chatType, event.topicId, binding, input);
    await this.resolveBatch(batch.batchId, 'consumed', locale, 'attachment_batch_resolved_started');
    return true;
  }

  async handleAttachmentBatchCallback(
    event: TelegramCallbackEvent,
    batchId: string,
    action: AttachmentBatchAction,
    locale: AppLocale,
  ): Promise<void> {
    const batch = this.host.store.getPendingAttachmentBatch(batchId);
    if (!batch || batch.scopeId !== event.scopeId || batch.status !== 'pending' || batch.resolvedAt !== null) {
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'attachment_batch_expired_short'));
      return;
    }

    if (action === 'next') {
      await this.presentBatchCard(batch, locale);
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'attachment_batch_next_short'));
      return;
    }

    if (action === 'clear') {
      await this.resolveBatch(batch.batchId, 'cleared', locale, 'attachment_batch_resolved_cleared');
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'attachment_batch_cleared_short'));
      return;
    }

    const promptText = buildBatchPromptText(batch, '', locale);
    const input = this.host.buildTurnInputFromStagedAttachments(promptText, batch.attachments as StagedTelegramAttachment[]);
    const sourceSummary = summarizeTelegramInput(batch.noteText, batch.attachments as TelegramInboundAttachment[])
      || t(locale, 'attachment_batch_queue_summary_fallback');
    const activeTurn = this.host.turns.findByScope(event.scopeId);
    if (activeTurn) {
      const settings = this.host.store.getChatSettings(event.scopeId);
      if (!(settings?.autoQueueMessages ?? true)) {
        await this.host.answerCallback(event.callbackQueryId, t(locale, 'another_turn_running'));
        return;
      }
      await this.host.enqueuePreparedTurnInput({
        scopeId: event.scopeId,
        chatId: event.chatId,
        threadId: activeTurn.threadId,
        input,
        sourceSummary,
      }, locale);
      await this.resolveBatch(batch.batchId, 'consumed', locale, 'attachment_batch_resolved_queued');
      await this.host.answerCallback(event.callbackQueryId, t(locale, 'attachment_batch_analyze_queued_short'));
      return;
    }

    const binding = await this.host.ensureBinding(event.scopeId);
    await this.host.startIncomingTurn(event.scopeId, event.chatId, inferChatType(event.chatId), event.topicId, binding, input);
    await this.resolveBatch(batch.batchId, 'consumed', locale, 'attachment_batch_resolved_started');
    await this.host.answerCallback(event.callbackQueryId, t(locale, 'attachment_batch_analyze_started_short'));
  }

  private findMergeTarget(scopeId: string, mediaGroupId: string | null): PendingAttachmentBatchRecord | null {
    if (mediaGroupId) {
      return this.host.store.getPendingAttachmentBatchByMediaGroup(scopeId, mediaGroupId);
    }
    const latest = this.host.store.getLatestPendingAttachmentBatch(scopeId);
    if (!latest || latest.mediaGroupId !== null) {
      return null;
    }
    if (Date.now() - latest.updatedAt > STANDALONE_BATCH_MERGE_WINDOW_MS) {
      return null;
    }
    return latest;
  }

  private async supersedeLatestPendingBatch(scopeId: string, locale: AppLocale): Promise<void> {
    const latest = this.host.store.getLatestPendingAttachmentBatch(scopeId);
    if (!latest) {
      return;
    }
    await this.resolveBatch(latest.batchId, 'superseded', locale, 'attachment_batch_resolved_superseded');
  }

  private async presentBatchCard(record: PendingAttachmentBatchRecord, locale: AppLocale): Promise<void> {
    const rendered = renderPendingAttachmentBatchMessage(locale, record);
    if (record.receiptMessageId !== null) {
      try {
        await this.host.messages.editMessage(record.scopeId, record.receiptMessageId, rendered.text, rendered.keyboard);
        return;
      } catch (error) {
        if (!isTelegramMessageGone(error)) {
          throw error;
        }
      }
    }
    const messageId = await this.host.messages.sendMessage(record.scopeId, rendered.text, rendered.keyboard);
    this.host.store.updatePendingAttachmentBatchReceipt(record.batchId, messageId);
  }

  private async resolveBatch(
    batchId: string,
    status: Exclude<PendingAttachmentBatchStatus, 'pending'>,
    locale: AppLocale,
    messageKey: 'attachment_batch_resolved_started'
      | 'attachment_batch_resolved_queued'
      | 'attachment_batch_resolved_cleared'
      | 'attachment_batch_resolved_superseded',
  ): Promise<void> {
    const current = this.host.store.getPendingAttachmentBatch(batchId);
    if (!current || current.status !== 'pending') {
      return;
    }
    this.host.store.resolvePendingAttachmentBatch(batchId, status);
    const updated = this.host.store.getPendingAttachmentBatch(batchId);
    if (!updated || updated.receiptMessageId === null) {
      this.host.updateStatus();
      return;
    }
    try {
      await this.host.messages.editMessage(
        updated.scopeId,
        updated.receiptMessageId,
        renderResolvedAttachmentBatchMessage(locale, updated, messageKey),
        [],
      );
    } catch (error) {
      if (!isTelegramMessageGone(error)) {
        this.host.logger.warn('attachment_batch.resolve_edit_failed', {
          batchId,
          status,
          error: formatUserError(error),
        });
      }
    }
    this.host.updateStatus();
  }
}

function renderPendingAttachmentBatchMessage(
  locale: AppLocale,
  record: PendingAttachmentBatchRecord,
): { text: string; keyboard: InlineKeyboard } {
  const lines = [
    t(locale, 'attachment_batch_title'),
    t(locale, 'attachment_batch_pending_hint'),
    summarizeAttachmentKinds(locale, record.attachments),
  ];
  if (record.noteText) {
    lines.push(t(locale, 'attachment_batch_note', { value: record.noteText }));
  }
  lines.push(...renderAttachmentDetails(locale, record.attachments));
  return {
    text: lines.join('\n'),
    keyboard: [
      [
        { text: t(locale, 'attachment_batch_action_next_recommended'), callback_data: `attach:${record.batchId}:next` },
        { text: t(locale, 'attachment_batch_action_analyze'), callback_data: `attach:${record.batchId}:analyze` },
      ],
      [
        { text: t(locale, 'attachment_batch_action_clear'), callback_data: `attach:${record.batchId}:clear` },
      ],
    ],
  };
}

function renderResolvedAttachmentBatchMessage(
  locale: AppLocale,
  record: PendingAttachmentBatchRecord,
  messageKey: 'attachment_batch_resolved_started'
    | 'attachment_batch_resolved_queued'
    | 'attachment_batch_resolved_cleared'
    | 'attachment_batch_resolved_superseded',
): string {
  const lines = [
    t(locale, 'attachment_batch_title'),
    t(locale, messageKey),
    summarizeAttachmentKinds(locale, record.attachments),
  ];
  if (record.noteText) {
    lines.push(t(locale, 'attachment_batch_note', { value: record.noteText }));
  }
  return lines.join('\n');
}

function summarizeAttachmentKinds(locale: AppLocale, attachments: PendingAttachmentBatchRecord['attachments']): string {
  const imageCount = attachments.filter((attachment) => attachment.nativeImage).length;
  const fileCount = attachments.length - imageCount;
  const parts: string[] = [];
  if (imageCount > 0) {
    parts.push(t(locale, 'attachment_batch_image_count', { value: imageCount }));
  }
  if (fileCount > 0) {
    parts.push(t(locale, 'attachment_batch_file_count', { value: fileCount }));
  }
  return parts.length > 0
    ? t(locale, 'attachment_batch_count_summary', { value: parts.join(', ') })
    : t(locale, 'attachment_batch_count_summary', { value: '0' });
}

function renderAttachmentDetails(locale: AppLocale, attachments: PendingAttachmentBatchRecord['attachments']): string[] {
  const lines = [t(locale, 'attachment_batch_detail_title')];
  attachments.slice(0, MAX_RENDERED_ATTACHMENTS).forEach((attachment, index) => {
    lines.push(`${index + 1}. ${describeAttachment(locale, attachment)}`);
    lines.push(`   ${t(locale, 'attachment_batch_detail_name', { value: attachment.fileName })}`);
    lines.push(`   ${t(locale, 'attachment_batch_detail_path', { value: attachment.localPath })}`);
    if (attachment.mimeType) {
      lines.push(`   ${t(locale, 'attachment_batch_detail_mime', { value: attachment.mimeType })}`);
    }
    if (attachment.fileSize !== null) {
      lines.push(`   ${t(locale, 'attachment_batch_detail_size', { value: attachment.fileSize })}`);
    }
    if (attachment.width !== null && attachment.height !== null) {
      lines.push(`   ${t(locale, 'attachment_batch_detail_dimensions', { value: `${attachment.width}x${attachment.height}` })}`);
    }
    if (attachment.durationSeconds !== null) {
      lines.push(`   ${t(locale, 'attachment_batch_detail_duration', { value: attachment.durationSeconds })}`);
    }
  });
  if (attachments.length > MAX_RENDERED_ATTACHMENTS) {
    lines.push(t(locale, 'attachment_batch_detail_more', { value: attachments.length - MAX_RENDERED_ATTACHMENTS }));
  }
  return lines;
}

function describeAttachment(locale: AppLocale, attachment: PendingAttachmentBatchRecord['attachments'][number]): string {
  switch (attachment.kind) {
    case 'photo':
      return t(locale, 'attachment_kind_photo');
    case 'document':
      return t(locale, 'attachment_kind_document');
    case 'audio':
      return t(locale, 'attachment_kind_audio');
    case 'voice':
      return t(locale, 'attachment_kind_voice');
    case 'video':
      return t(locale, 'attachment_kind_video');
    case 'animation':
      return t(locale, 'attachment_kind_animation');
    case 'sticker':
      return attachment.isAnimated || attachment.isVideo
        ? t(locale, 'attachment_kind_animated_sticker')
        : t(locale, 'attachment_kind_sticker');
    case 'videoNote':
      return t(locale, 'attachment_kind_video_note');
    default:
      return attachment.kind;
  }
}

function mergeAttachments(
  current: PendingAttachmentBatchRecord['attachments'],
  incoming: readonly StagedTelegramAttachment[],
): PendingAttachmentBatchRecord['attachments'] {
  const seen = new Set(current.map((attachment) => attachment.fileUniqueId));
  const next = [...current];
  for (const attachment of incoming) {
    if (seen.has(attachment.fileUniqueId)) {
      continue;
    }
    seen.add(attachment.fileUniqueId);
    next.push(attachment);
  }
  return next;
}

function mergeNoteText(current: string, incoming: string): string {
  const normalizedCurrent = current.trim();
  const normalizedIncoming = incoming.trim();
  if (!normalizedIncoming) {
    return normalizedCurrent;
  }
  if (!normalizedCurrent) {
    return normalizedIncoming;
  }
  if (normalizedCurrent === normalizedIncoming) {
    return normalizedCurrent;
  }
  return `${normalizedCurrent}\n${normalizedIncoming}`;
}

function buildBatchPromptText(batch: PendingAttachmentBatchRecord, userText: string, locale: AppLocale): string {
  const normalizedUserText = userText.trim();
  const normalizedNote = batch.noteText.trim();
  if (normalizedNote && normalizedUserText) {
    return [
      t(locale, 'attachment_batch_prompt_upload_note'),
      normalizedNote,
      '',
      t(locale, 'attachment_batch_prompt_current_request'),
      normalizedUserText,
    ].join('\n');
  }
  if (normalizedUserText) {
    return normalizedUserText;
  }
  if (normalizedNote) {
    return normalizedNote;
  }
  return t(locale, 'attachment_batch_prompt_fallback');
}

function inferChatType(chatId: string): string {
  return chatId.startsWith('-') ? 'group' : 'private';
}
