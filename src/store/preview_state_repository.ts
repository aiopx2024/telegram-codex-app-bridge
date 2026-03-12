import type { SqliteDatabase } from './sqlite.js';
import type { ActiveTurnPreviewRecord, ThreadHistoryPreviewRecord } from './records.js';
import type { SqliteRow } from './shared.js';

export class PreviewStateRepository {
  constructor(private readonly db: SqliteDatabase) {}

  saveActiveTurnPreview(record: Pick<ActiveTurnPreviewRecord, 'turnId' | 'scopeId' | 'threadId' | 'messageId'>): void {
    const now = Date.now();
    this.db.prepare('DELETE FROM active_turn_previews WHERE turn_id = ? OR scope_id = ?').run(record.turnId, record.scopeId);
    this.db.prepare(`
      INSERT INTO active_turn_previews (turn_id, scope_id, thread_id, message_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(record.turnId, record.scopeId, record.threadId, record.messageId, now, now);
  }

  listActiveTurnPreviews(): ActiveTurnPreviewRecord[] {
    const rows = this.db.prepare(`
      SELECT turn_id, scope_id, thread_id, message_id, created_at, updated_at
      FROM active_turn_previews
      ORDER BY created_at ASC
    `).all() as SqliteRow[];
    return rows.map((row) => ({
      turnId: String(row.turn_id),
      scopeId: String(row.scope_id),
      threadId: String(row.thread_id),
      messageId: Number(row.message_id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }));
  }

  removeActiveTurnPreview(turnId: string): void {
    this.db.prepare('DELETE FROM active_turn_previews WHERE turn_id = ?').run(turnId);
  }

  removeActiveTurnPreviewByMessage(scopeId: string, messageId: number): void {
    this.db.prepare('DELETE FROM active_turn_previews WHERE scope_id = ? AND message_id = ?').run(scopeId, messageId);
  }

  saveThreadHistoryPreview(record: Pick<ThreadHistoryPreviewRecord, 'scopeId' | 'threadId' | 'messageId'>): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO thread_history_previews (scope_id, thread_id, message_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope_id) DO UPDATE SET
        thread_id = excluded.thread_id,
        message_id = excluded.message_id,
        updated_at = excluded.updated_at
    `).run(record.scopeId, record.threadId, record.messageId, now, now);
  }

  getThreadHistoryPreview(scopeId: string): ThreadHistoryPreviewRecord | null {
    const row = this.db.prepare(`
      SELECT scope_id, thread_id, message_id, created_at, updated_at
      FROM thread_history_previews
      WHERE scope_id = ?
    `).get(scopeId) as SqliteRow | undefined;
    if (!row) {
      return null;
    }
    return {
      scopeId: String(row.scope_id),
      threadId: String(row.thread_id),
      messageId: Number(row.message_id),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }

  removeThreadHistoryPreview(scopeId: string): void {
    this.db.prepare('DELETE FROM thread_history_previews WHERE scope_id = ?').run(scopeId);
  }
}
