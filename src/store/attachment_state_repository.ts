import type {
  PendingAttachmentBatchRecord,
  PendingAttachmentBatchStatus,
} from '../types.js';
import type { SqliteDatabase } from './sqlite.js';
import { parseJsonValue, type SqliteRow } from './shared.js';

export class AttachmentStateRepository {
  constructor(private readonly db: SqliteDatabase) {}

  savePendingAttachmentBatch(record: PendingAttachmentBatchRecord): void {
    this.db.prepare(`
      INSERT INTO pending_attachment_batches (
        batch_id, scope_id, chat_id, thread_id, media_group_id, note_text, attachments_json,
        receipt_message_id, status, created_at, updated_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO UPDATE SET
        scope_id = excluded.scope_id,
        chat_id = excluded.chat_id,
        thread_id = excluded.thread_id,
        media_group_id = excluded.media_group_id,
        note_text = excluded.note_text,
        attachments_json = excluded.attachments_json,
        receipt_message_id = excluded.receipt_message_id,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        resolved_at = excluded.resolved_at
    `).run(
      record.batchId,
      record.scopeId,
      record.chatId,
      record.threadId,
      record.mediaGroupId,
      record.noteText,
      JSON.stringify(record.attachments),
      record.receiptMessageId,
      record.status,
      record.createdAt,
      record.updatedAt,
      record.resolvedAt,
    );
  }

  getPendingAttachmentBatch(batchId: string): PendingAttachmentBatchRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM pending_attachment_batches
      WHERE batch_id = ?
    `).get(batchId) as SqliteRow | undefined;
    return row ? this.mapPendingAttachmentBatch(row) : null;
  }

  getLatestPendingAttachmentBatch(scopeId: string): PendingAttachmentBatchRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM pending_attachment_batches
      WHERE scope_id = ? AND status = 'pending' AND resolved_at IS NULL
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `).get(scopeId) as SqliteRow | undefined;
    return row ? this.mapPendingAttachmentBatch(row) : null;
  }

  getPendingAttachmentBatchByMediaGroup(scopeId: string, mediaGroupId: string): PendingAttachmentBatchRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM pending_attachment_batches
      WHERE scope_id = ? AND media_group_id = ? AND status = 'pending' AND resolved_at IS NULL
      ORDER BY updated_at DESC, created_at DESC
      LIMIT 1
    `).get(scopeId, mediaGroupId) as SqliteRow | undefined;
    return row ? this.mapPendingAttachmentBatch(row) : null;
  }

  listPendingAttachmentBatches(scopeId?: string): PendingAttachmentBatchRecord[] {
    const sql = scopeId
      ? `
        SELECT *
        FROM pending_attachment_batches
        WHERE scope_id = ?
        ORDER BY created_at ASC
      `
      : `
        SELECT *
        FROM pending_attachment_batches
        ORDER BY created_at ASC
      `;
    const rows = (scopeId
      ? this.db.prepare(sql).all(scopeId)
      : this.db.prepare(sql).all()) as SqliteRow[];
    return rows.map((row) => this.mapPendingAttachmentBatch(row));
  }

  updatePendingAttachmentBatchReceipt(batchId: string, receiptMessageId: number): void {
    this.db.prepare(`
      UPDATE pending_attachment_batches
      SET receipt_message_id = ?, updated_at = ?
      WHERE batch_id = ?
    `).run(receiptMessageId, Date.now(), batchId);
  }

  resolvePendingAttachmentBatch(batchId: string, status: Exclude<PendingAttachmentBatchStatus, 'pending'>): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE pending_attachment_batches
      SET status = ?, updated_at = ?, resolved_at = ?
      WHERE batch_id = ?
    `).run(status, now, now, batchId);
  }

  countPendingAttachmentBatches(scopeId?: string): number {
    const row = (scopeId
      ? this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM pending_attachment_batches
        WHERE scope_id = ? AND status = 'pending' AND resolved_at IS NULL
      `).get(scopeId)
      : this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM pending_attachment_batches
        WHERE status = 'pending' AND resolved_at IS NULL
      `).get()) as { count: number };
    return Number(row.count);
  }

  deleteResolvedPendingAttachmentBatchesBefore(cutoff: number): number {
    return Number(this.db.prepare(`
      DELETE FROM pending_attachment_batches
      WHERE resolved_at IS NOT NULL AND resolved_at < ?
    `).run(cutoff).changes ?? 0);
  }

  private mapPendingAttachmentBatch(row: SqliteRow): PendingAttachmentBatchRecord {
    return {
      batchId: String(row.batch_id),
      scopeId: String(row.scope_id),
      chatId: String(row.chat_id),
      threadId: String(row.thread_id),
      mediaGroupId: row.media_group_id === null ? null : String(row.media_group_id),
      noteText: row.note_text === null ? '' : String(row.note_text),
      attachments: parseJsonValue<PendingAttachmentBatchRecord['attachments']>(row.attachments_json, []),
      receiptMessageId: row.receipt_message_id === null ? null : Number(row.receipt_message_id),
      status: String(row.status) as PendingAttachmentBatchStatus,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    };
  }
}
