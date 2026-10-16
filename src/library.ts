import { DatabaseSync } from 'node:sqlite';
import { parseEssay, finalText } from './model.ts';
import type { Essay } from './model';

export interface EssaySummary {
  id: string;
  title: string;
  updatedAt: string;
}
export interface Recovery {
  id: string;
  essay: Essay;
  savedEssay: Essay | null;
}

function validateId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id))
    throw new Error('INVALID_ESSAY_ID');
}

// A single connection lives in the main process. The UI only sees narrow IPC methods.
export class EssayLibrary {
  private db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    try {
      this.db.exec('PRAGMA busy_timeout = 3000; PRAGMA synchronous = FULL;');
      const version = this.db.prepare('PRAGMA user_version').get()!.user_version as number;
      if (version > 1) throw new Error('LIBRARY_VERSION');
      this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS essays (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          document TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS essays_updated ON essays(updated_at DESC);
        CREATE TABLE IF NOT EXISTS session (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          essay_id TEXT NOT NULL,
          document TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = 1;
        COMMIT;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  list(): EssaySummary[] {
    return this.db
      .prepare(
        'SELECT id, title, updated_at AS updatedAt FROM essays ORDER BY updated_at DESC, rowid DESC',
      )
      .all() as unknown as EssaySummary[];
  }

  get(id: string): Essay | null {
    validateId(id);
    const row = this.db.prepare('SELECT document FROM essays WHERE id = ?').get(id);
    return row ? parseEssay(JSON.parse(row.document as string)) : null;
  }

  save(id: string, input: unknown): Essay {
    validateId(id);
    const essay = parseEssay(input);
    if (essay.title === '未命名作文' || !essay.title.trim()) {
      const firstLine = finalText(essay)
        .split('\n')
        .find((line) => line.trim());
      essay.title = Array.from(firstLine?.trim() || '未命名作文')
        .slice(0, 40)
        .join('');
    }
    const document = JSON.stringify(essay);
    const now = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          `INSERT INTO essays(id, title, document, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, document = excluded.document, updated_at = excluded.updated_at`,
        )
        .run(id, essay.title, document, now, now);
      this.writeSession(id, document);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return essay;
  }

  // Recovery is separate from explicit saves, so unsaved edits never replace a saved essay.
  autosave(id: string, input: unknown): void {
    validateId(id);
    this.writeSession(id, JSON.stringify(parseEssay(input)));
  }

  private writeSession(id: string, document: string): void {
    this.db
      .prepare(
        `INSERT INTO session(singleton, essay_id, document) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET essay_id = excluded.essay_id, document = excluded.document`,
      )
      .run(id, document);
  }

  recover(): Recovery | null {
    const row = this.db.prepare('SELECT essay_id, document FROM session WHERE singleton = 1').get();
    if (!row) return null;
    const id = row.essay_id as string;
    return { id, essay: parseEssay(JSON.parse(row.document as string)), savedEssay: this.get(id) };
  }

  close(): void {
    this.db.close();
  }
}
