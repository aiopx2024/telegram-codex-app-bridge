import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('sqlite adapter suppresses ExperimentalWarning when loading node:sqlite', () => {
  const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dbPath = path.join(os.tmpdir(), `telegram-codex-sqlite-${process.pid}-${Date.now()}.sqlite`);
  const sqliteModuleUrl = pathToFileURL(path.join(rootDir, 'src/store/sqlite.ts')).href;
  const script = `
    const { openSqliteDatabase } = await import(${JSON.stringify(sqliteModuleUrl)});
    const db = openSqliteDatabase(${JSON.stringify(dbPath)});
    db.exec("CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY);");
    db.close();
  `;

  const result = spawnSync(process.execPath, ['--import', 'tsx', '--eval', script], {
    cwd: rootDir,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.doesNotMatch(result.stderr, /ExperimentalWarning/);
});
