import type {
  PendingApprovalRecord,
  PendingUserInputMessageKind,
  PendingUserInputMessageRecord,
  PendingUserInputQuestion,
  PendingUserInputRecord,
} from '../types.js';
import type { SqliteDatabase } from './sqlite.js';
import { deleteRowsByIds, parseJsonValue, type SqliteRow } from './shared.js';

export class WorkflowStateRepository {
  constructor(private readonly db: SqliteDatabase) {}

  savePendingApproval(record: PendingApprovalRecord): void {
    this.db.prepare(`
      INSERT INTO pending_approvals (
        local_id, server_request_id, kind, chat_id, thread_id, turn_id, item_id, approval_id,
        reason, command, cwd, summary, risk_level, details_json, message_id, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.localId,
      record.serverRequestId,
      record.kind,
      record.chatId,
      record.threadId,
      record.turnId,
      record.itemId,
      record.approvalId,
      record.reason,
      record.command,
      record.cwd,
      record.summary,
      record.riskLevel,
      record.details === null ? null : JSON.stringify(record.details),
      record.messageId,
      record.createdAt,
      record.resolvedAt,
    );
  }

  updatePendingApprovalMessage(localId: string, messageId: number): void {
    this.db.prepare('UPDATE pending_approvals SET message_id = ? WHERE local_id = ?').run(messageId, localId);
  }

  getPendingApproval(localId: string): PendingApprovalRecord | null {
    const row = this.db.prepare('SELECT * FROM pending_approvals WHERE local_id = ?').get(localId) as SqliteRow | undefined;
    return row ? this.mapApproval(row) : null;
  }

  listPendingApprovals(chatId?: string): PendingApprovalRecord[] {
    const sql = chatId
      ? 'SELECT * FROM pending_approvals WHERE chat_id = ? AND resolved_at IS NULL ORDER BY created_at ASC'
      : 'SELECT * FROM pending_approvals WHERE resolved_at IS NULL ORDER BY created_at ASC';
    const rows = (chatId
      ? this.db.prepare(sql).all(chatId)
      : this.db.prepare(sql).all()) as SqliteRow[];
    return rows.map((row) => this.mapApproval(row));
  }

  markApprovalResolved(localId: string): void {
    this.db.prepare('UPDATE pending_approvals SET resolved_at = ? WHERE local_id = ?').run(Date.now(), localId);
  }

  countPendingApprovals(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM pending_approvals WHERE resolved_at IS NULL').get() as { count: number };
    return Number(row.count);
  }

  deleteResolvedApprovalsBefore(cutoff: number): number {
    return Number(this.db.prepare(`
      DELETE FROM pending_approvals
      WHERE resolved_at IS NOT NULL AND resolved_at < ?
    `).run(cutoff).changes ?? 0);
  }

  savePendingUserInput(record: PendingUserInputRecord): void {
    this.db.prepare(`
      INSERT INTO pending_user_inputs (
        local_id, server_request_id, chat_id, thread_id, turn_id, item_id, message_id,
        questions_json, answers_json, current_question_index, awaiting_free_text, created_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.localId,
      record.serverRequestId,
      record.chatId,
      record.threadId,
      record.turnId,
      record.itemId,
      record.messageId,
      JSON.stringify(record.questions),
      JSON.stringify(record.answers),
      record.currentQuestionIndex,
      record.awaitingFreeText ? 1 : 0,
      record.createdAt,
      record.resolvedAt,
    );
  }

  updatePendingUserInputMessage(localId: string, messageId: number): void {
    this.db.prepare('UPDATE pending_user_inputs SET message_id = ? WHERE local_id = ?').run(messageId, localId);
  }

  updatePendingUserInputState(
    localId: string,
    answers: Record<string, string[]>,
    currentQuestionIndex: number,
    awaitingFreeText: boolean,
  ): void {
    this.db.prepare(`
      UPDATE pending_user_inputs
      SET answers_json = ?, current_question_index = ?, awaiting_free_text = ?
      WHERE local_id = ?
    `).run(
      JSON.stringify(answers),
      currentQuestionIndex,
      awaitingFreeText ? 1 : 0,
      localId,
    );
  }

  getPendingUserInput(localId: string): PendingUserInputRecord | null {
    const row = this.db.prepare('SELECT * FROM pending_user_inputs WHERE local_id = ?').get(localId) as SqliteRow | undefined;
    return row ? this.mapPendingUserInput(row) : null;
  }

  getPendingUserInputForChat(chatId: string): PendingUserInputRecord | null {
    const row = this.db.prepare(`
      SELECT *
      FROM pending_user_inputs
      WHERE chat_id = ? AND resolved_at IS NULL
      ORDER BY created_at ASC
      LIMIT 1
    `).get(chatId) as SqliteRow | undefined;
    return row ? this.mapPendingUserInput(row) : null;
  }

  listPendingUserInputs(chatId?: string): PendingUserInputRecord[] {
    const sql = chatId
      ? 'SELECT * FROM pending_user_inputs WHERE chat_id = ? AND resolved_at IS NULL ORDER BY created_at ASC'
      : 'SELECT * FROM pending_user_inputs WHERE resolved_at IS NULL ORDER BY created_at ASC';
    const rows = (chatId
      ? this.db.prepare(sql).all(chatId)
      : this.db.prepare(sql).all()) as SqliteRow[];
    return rows.map((row) => this.mapPendingUserInput(row));
  }

  markPendingUserInputResolved(localId: string): void {
    this.db.prepare('UPDATE pending_user_inputs SET resolved_at = ? WHERE local_id = ?').run(Date.now(), localId);
  }

  countPendingUserInputs(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM pending_user_inputs WHERE resolved_at IS NULL').get() as { count: number };
    return Number(row.count);
  }

  savePendingUserInputMessage(record: PendingUserInputMessageRecord): void {
    this.db.prepare(`
      INSERT INTO pending_user_input_messages (input_local_id, question_index, message_id, message_kind, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(input_local_id, question_index, message_kind) DO UPDATE SET
        message_id = excluded.message_id,
        created_at = excluded.created_at
    `).run(
      record.inputLocalId,
      record.questionIndex,
      record.messageId,
      record.messageKind,
      record.createdAt,
    );
  }

  listPendingUserInputMessages(inputLocalId: string): PendingUserInputMessageRecord[] {
    const rows = this.db.prepare(`
      SELECT input_local_id, question_index, message_id, message_kind, created_at
      FROM pending_user_input_messages
      WHERE input_local_id = ?
      ORDER BY question_index ASC, created_at ASC
    `).all(inputLocalId) as SqliteRow[];
    return rows.map((row) => ({
      inputLocalId: String(row.input_local_id),
      questionIndex: Number(row.question_index),
      messageId: Number(row.message_id),
      messageKind: String(row.message_kind) as PendingUserInputMessageKind,
      createdAt: Number(row.created_at),
    }));
  }

  collectPendingUserInputIdsForCleanup(cutoff: number): string[] {
    const rows = this.db.prepare(`
      SELECT local_id
      FROM pending_user_inputs
      WHERE resolved_at IS NOT NULL AND resolved_at < ?
    `).all(cutoff) as Array<{ local_id: string }>;
    return rows.map((row) => String(row.local_id));
  }

  deletePendingUserInputMessagesByInputIds(inputIds: string[]): number {
    return deleteRowsByIds(this.db, 'pending_user_input_messages', 'input_local_id', inputIds);
  }

  deleteOrphanedPendingUserInputMessages(): number {
    return Number(this.db.prepare(`
      DELETE FROM pending_user_input_messages
      WHERE input_local_id NOT IN (SELECT local_id FROM pending_user_inputs)
    `).run().changes ?? 0);
  }

  deletePendingUserInputsByIds(inputIds: string[]): number {
    return deleteRowsByIds(this.db, 'pending_user_inputs', 'local_id', inputIds);
  }

  private mapApproval(row: SqliteRow): PendingApprovalRecord {
    return {
      localId: String(row.local_id),
      serverRequestId: String(row.server_request_id),
      kind: row.kind === 'fileChange' ? 'fileChange' : 'command',
      chatId: String(row.chat_id),
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      itemId: String(row.item_id),
      approvalId: row.approval_id === null ? null : String(row.approval_id),
      reason: row.reason === null ? null : String(row.reason),
      command: row.command === null ? null : String(row.command),
      cwd: row.cwd === null ? null : String(row.cwd),
      summary: row.summary === null ? null : String(row.summary),
      riskLevel: row.risk_level === null ? null : String(row.risk_level) as PendingApprovalRecord['riskLevel'],
      details: parseJsonValue<Record<string, unknown> | null>(row.details_json, null),
      messageId: row.message_id === null ? null : Number(row.message_id),
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    };
  }

  private mapPendingUserInput(row: SqliteRow): PendingUserInputRecord {
    return {
      localId: String(row.local_id),
      serverRequestId: String(row.server_request_id),
      chatId: String(row.chat_id),
      threadId: String(row.thread_id),
      turnId: String(row.turn_id),
      itemId: String(row.item_id),
      messageId: row.message_id === null ? null : Number(row.message_id),
      questions: parseJsonValue<PendingUserInputQuestion[]>(row.questions_json, []),
      answers: parseJsonValue<Record<string, string[]>>(row.answers_json, {}),
      currentQuestionIndex: Number(row.current_question_index),
      awaitingFreeText: Number(row.awaiting_free_text) === 1,
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at),
    };
  }
}
