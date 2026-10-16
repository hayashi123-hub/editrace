import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { EssayLibrary } from '../src/library.ts';
import { newEssay, editText, finalText } from '../src/model.ts';

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'essay-library-'));
  return {
    file: path.join(directory, 'library.sqlite'),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test('saved essays survive restart, update by ID and allow identical titles', () => {
  const { file, cleanup } = fixture();
  let library = new EssayLibrary(file);
  try {
    const a = randomUUID(),
      b = randomUUID();
    library.save(a, newEssay('First', 'Same title'));
    library.save(b, newEssay('Second', 'Same title'));
    library.save(a, newEssay('Updated', 'Renamed'));
    assert.equal(library.list().length, 2);
    library.close();
    library = new EssayLibrary(file);
    assert.equal(library.get(a)!.original, 'Updated');
    assert.equal(library.get(b)!.original, 'Second');
    assert.equal(library.list()[0].id, a);
    assert.equal(library.list()[0].title, 'Renamed');
  } finally {
    library.close();
    cleanup();
  }
});

test('draft recovery keeps its ID and does not overwrite the saved version', () => {
  const { file, cleanup } = fixture();
  let library = new EssayLibrary(file);
  try {
    const id = randomUUID();
    library.save(id, newEssay('Original', 'Essay'));
    const corrected = editText(
      { ...newEssay('Original', 'Essay'), stage: 'review' },
      0,
      8,
      'Corrected',
    );
    library.autosave(id, corrected);
    library.close();
    library = new EssayLibrary(file);
    const recovery = library.recover()!;
    assert.equal(recovery.id, id);
    assert.equal(finalText(recovery.essay), 'Corrected');
    assert.equal(recovery.savedEssay!.original, 'Original');
    library.save(id, recovery.essay);
    assert.equal(library.list().length, 1);
    assert.deepEqual(library.get(id), corrected);
    const draftId = randomUUID();
    library.autosave(draftId, newEssay('Unsaved draft'));
    assert.equal(library.recover()!.savedEssay, null);
    assert.equal(library.list().length, 1);
  } finally {
    library.close();
    cleanup();
  }
});

test('save generates a readable title, keeps user titles and validates input', () => {
  const library = new EssayLibrary(':memory:');
  try {
    const id = randomUUID();
    const essay = editText({ ...newEssay(), stage: 'review' }, 0, 0, '\nこんにちは 🌍');
    assert.equal(library.save(id, essay).title, 'こんにちは 🌍');
    assert.equal(essay.title, '未命名作文');
    assert.equal(
      library.save(id, { ...essay, title: "My 'essay' <script>" }).title,
      "My 'essay' <script>",
    );
    assert.throws(() => library.save('../bad', essay));
    assert.throws(() => library.save(id, { ...essay, version: 99 }));
    assert.equal(library.list().length, 1);
    assert.equal(library.get(randomUUID()), null);
  } finally {
    library.close();
  }
});

test('a failed save rolls back both the essay and the recovery session', () => {
  const { file, cleanup } = fixture();
  const library = new EssayLibrary(file);
  try {
    const id = randomUUID();
    library.save(id, newEssay('Before', 'Essay'));
    const connection = new DatabaseSync(file);
    connection.exec(
      `CREATE TRIGGER fail_session BEFORE UPDATE ON session BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;`,
    );
    connection.close();
    assert.throws(() => library.save(id, newEssay('After', 'Essay')), /simulated disk failure/);
    assert.equal(library.get(id)!.original, 'Before');
    assert.equal(library.recover()!.essay.original, 'Before');
  } finally {
    library.close();
    cleanup();
  }
});

test('an invalid or future database fails without replacing the existing data', () => {
  const { file, cleanup } = fixture();
  try {
    writeFileSync(file, 'This is not SQLite');
    assert.throws(() => new EssayLibrary(file));
    assert.equal(readFileSync(file, 'utf8'), 'This is not SQLite');
    rmSync(file);
    const connection = new DatabaseSync(file);
    connection.exec('PRAGMA user_version = 999;');
    connection.close();
    assert.throws(() => new EssayLibrary(file), /LIBRARY_VERSION/);
  } finally {
    cleanup();
  }
});
