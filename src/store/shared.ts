import type { SqliteDatabase } from './sqlite.js';

export type SqliteRow = Record<string, unknown>;

export function parseJsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function ensureColumn(db: SqliteDatabase, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((entry) => entry.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function deleteRowsByIds(db: SqliteDatabase, table: string, column: string, ids: string[]): number {
  if (ids.length === 0) {
    return 0;
  }
  const placeholders = ids.map(() => '?').join(', ');
  const result = db.prepare(`
    DELETE FROM ${table}
    WHERE ${column} IN (${placeholders})
  `).run(...ids);
  return Number(result.changes ?? 0);
}
