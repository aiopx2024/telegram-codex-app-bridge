import { createRequire } from 'node:module';
import process from 'node:process';

export interface SqliteRunResult {
  changes?: number;
  lastInsertRowid?: number | bigint | null;
}

export interface SqliteStatement {
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteDatabaseConstructor {
  new (filename: string, options?: Record<string, unknown>): SqliteDatabase;
}

interface SqliteModule {
  DatabaseSync: SqliteDatabaseConstructor;
}

let sqliteModule: SqliteModule | null = null;

export function openSqliteDatabase(filename: string, options?: Record<string, unknown>): SqliteDatabase {
  const { DatabaseSync } = loadSqliteModule();
  return options ? new DatabaseSync(filename, options) : new DatabaseSync(filename);
}

function loadSqliteModule(): SqliteModule {
  if (sqliteModule) {
    return sqliteModule;
  }

  const require = createRequire(import.meta.url);
  const mutableProcess = process as typeof process & {
    emitWarning: (warning: string | Error, ...args: unknown[]) => void;
  };
  const originalEmitWarning = mutableProcess.emitWarning.bind(process);

  mutableProcess.emitWarning = (warning: string | Error, ...args: unknown[]) => {
    const type = typeof warning === 'string'
      ? (typeof args[0] === 'string' ? args[0] : '')
      : warning.name;
    const message = typeof warning === 'string' ? warning : warning.message;
    if (type === 'ExperimentalWarning' && message.includes('SQLite is an experimental feature')) {
      return;
    }
    originalEmitWarning(warning, ...args);
  };

  try {
    sqliteModule = require('node:sqlite') as SqliteModule;
    return sqliteModule;
  } finally {
    mutableProcess.emitWarning = originalEmitWarning;
  }
}
