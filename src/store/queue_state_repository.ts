import type { QueuedTurnInputRecord, QueuedTurnInputStatus } from '../types.js';
import type { SqliteDatabase } from './sqlite.js';
import { parseJsonValue, type SqliteRow } from './shared.js';

export class QueueStateRepository {
  constructor(private readonly db: SqliteDatabase) {}

  saveQueuedTurnInput(record: QueuedTurnInputRecord): void {
    this.db.prepare(`
      INSERT INTO queued_turn_inputs (
        queue_id, scope_id, chat_id, thread_id, input_json, source_summary, telegram_message_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(queue_id) DO UPDATE SET
        scope_id = excluded.scope_id,
        chat_id = excluded.chat_id,
        thread_id = excluded.thread_id,
        input_json = excluded.input_json,
        source_summary = excluded.source_summary,
        telegram_message_id = excluded.telegram_message_id,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      record.queueId,
      record.scopeId,
      record.chatId,
      record.threadId,
      JSON.stringify(record.input),
      record.sourceSummary,
      record.telegramMessageId,
      record.status,
      record.createdAt,
      record.updatedAt,
    );
  }

  getQueuedTurnInput(queueId: string): QueuedTurnInputRecord | null {
    const row = this.db.prepare('SELECT * FROM queued_turn_inputs WHERE queue_id = ?').get(queueId) as SqliteRow | undefined;
    return row ? this.mapQueuedTurnInput(row) : null;
  }

  listQueuedTurnInputs(scopeId?: string): QueuedTurnInputRecord[] {
    const sql = scopeId
      ? 'SELECT * FROM queued_turn_inputs WHERE scope_id = ? ORDER BY created_at ASC'
      : 'SELECT * FROM queued_turn_inputs ORDER BY created_at ASC';
    const rows = (scopeId
      ? this.db.prepare(sql).all(scopeId)
      : this.db.prepare(sql).all()) as SqliteRow[];
    return rows.map((row) => this.mapQueuedTurnInput(row));
  }

  peekQueuedTurnInput(scopeId: string): QueuedTurnInputRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM queued_turn_inputs
      WHERE scope_id = ? AND status = 'queued'
      ORDER BY created_at ASC
      LIMIT 1
    `).get(scopeId) as SqliteRow | undefined;
    return row ? this.mapQueuedTurnInput(row) : null;
  }

  updateQueuedTurnInputStatus(queueId: string, status: QueuedTurnInputStatus): void {
    this.db.prepare(`
      UPDATE queued_turn_inputs
      SET status = ?, updated_at = ?
      WHERE queue_id = ?
    `).run(status, Date.now(), queueId);
  }

  countQueuedTurnInputs(scopeId?: string): number {
    const row = (scopeId
      ? this.db.prepare('SELECT COUNT(*) AS count FROM queued_turn_inputs WHERE scope_id = ? AND status = \'queued\'').get(scopeId)
      : this.db.prepare('SELECT COUNT(*) AS count FROM queued_turn_inputs WHERE status = \'queued\'').get()) as { count: number };
    return Number(row.count);
  }

  removeQueuedTurnInput(queueId: string): void {
    this.db.prepare('DELETE FROM queued_turn_inputs WHERE queue_id = ?').run(queueId);
  }

  requeueInterruptedQueuedTurnInputs(): number {
    const result = this.db.prepare(`
      UPDATE queued_turn_inputs
      SET status = 'queued', updated_at = ?
      WHERE status = 'processing'
    `).run(Date.now());
    return Number(result.changes ?? 0);
  }

  deleteHistoricalQueuedTurnInputs(cutoff: number): number {
    return Number(this.db.prepare(`
      DELETE FROM queued_turn_inputs
      WHERE status IN ('completed', 'cancelled', 'failed') AND updated_at < ?
    `).run(cutoff).changes ?? 0);
  }

  private mapQueuedTurnInput(row: SqliteRow): QueuedTurnInputRecord {
    return {
      queueId: String(row.queue_id),
      scopeId: String(row.scope_id),
      chatId: String(row.chat_id),
      threadId: String(row.thread_id),
      input: parseJsonValue<unknown[]>(row.input_json, []),
      sourceSummary: String(row.source_summary),
      telegramMessageId: row.telegram_message_id === null ? null : Number(row.telegram_message_id),
      status: String(row.status) as QueuedTurnInputStatus,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
