import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newEssay,
  putRevision,
  parseEssay,
  finalText,
  exportHtml,
  detectEncoding,
  decodeText,
  editText,
  segments,
  countText,
} from '../src/model.ts';
import { parseSettings, defaultSettings, languages } from '../src/settings.ts';
import { translate, translateError } from '../src/i18n.ts';
import type { Essay, Revision } from '../src/model.ts';

const sample = () => ({
  ...newEssay('I go to school yesterday.', 'My day'),
  stage: 'review' as const,
});
const replacement: Revision = {
  id: 'r1',
  type: 'replace',
  start: 2,
  end: 4,
  original: 'go',
  text: 'went',
};
function insertion(id: string, offset: number, text: string): Revision {
  return { id, type: 'insert', start: offset, end: offset, original: '', text };
}

test('replace preserves the original and produces a clean final text', () => {
  const essay = putRevision(sample(), replacement);
  assert.equal(essay.original, 'I go to school yesterday.');
  assert.equal(finalText(essay), 'I went to school yesterday.');
  assert.equal(sample().revisions.length, 0);
});

test('insert at document start, end, and both replacement boundaries', () => {
  let essay: Essay = putRevision(sample(), replacement);
  for (const item of [
    insertion('a', 0, 'Well, '),
    insertion('b', 2, 'really '),
    insertion('c', 4, ' happily'),
    insertion('d', essay.original.length, '\nIt was fun.'),
  ])
    essay = putRevision(essay, item);
  assert.equal(finalText(essay), 'Well, I really went happily to school yesterday.\nIt was fun.');
});

test('multiple out-of-order corrections use stable original offsets', () => {
  let essay: Essay = sample();
  essay = putRevision(essay, {
    id: 'r2',
    type: 'replace',
    start: 8,
    end: 14,
    original: 'school',
    text: 'university',
  });
  essay = putRevision(essay, replacement);
  assert.equal(finalText(essay), 'I went to university yesterday.');
});

test('editing and removing a correction remain reversible', () => {
  const first = putRevision(sample(), replacement);
  const edited = putRevision(first, { ...replacement, text: 'walked' });
  assert.equal(edited.revisions.length, 1);
  assert.equal(finalText(edited), 'I walked to school yesterday.');
  assert.equal(finalText({ ...edited, revisions: [] }), sample().original);
});

test('reject overlap, nested insertion, duplicate insertion, and empty insertion', () => {
  const essay = putRevision(sample(), replacement);
  assert.throws(() => putRevision(essay, { ...replacement, id: 'r2' }), /已有修改/);
  assert.throws(() => putRevision(essay, insertion('x', 3, 'no')), /已有修改/);
  const inserted = putRevision(sample(), insertion('x', 3, 'no'));
  assert.throws(() => putRevision(inserted, replacement), /已有修改/);
  assert.throws(() => putRevision(inserted, insertion('y', 3, 'no')), /已有添加/);
  assert.throws(() => putRevision(sample(), insertion('empty', 0, '')), /内容无效/);
});

test('direct typing merges consecutive input and lets green text be edited', () => {
  let essay = editText(sample(), 2, 4, 'w');
  for (const [index, char] of [...'ent'].entries())
    essay = editText(essay, 3 + index, 3 + index, char);
  assert.equal(finalText(essay), 'I went to school yesterday.');
  assert.equal(essay.revisions.length, 1);
  essay = editText(essay, 2, 6, 'walked');
  assert.equal(finalText(essay), 'I walked to school yesterday.');
  assert.equal(essay.revisions[0].original, 'go');
  assert.equal(essay.revisions[0].text, 'walked');
});

test('deletion keeps original text, removes added text, and supports blank lines', () => {
  let essay = editText(sample(), 2, 4, '');
  assert.equal(finalText(essay), 'I  to school yesterday.');
  assert.equal(essay.revisions[0].text, '');
  assert.deepEqual(parseEssay(JSON.parse(JSON.stringify(essay))), essay);
  essay = editText(essay, 2, 2, 'went');
  essay = editText(essay, 2, 6, '');
  assert.equal(essay.revisions[0].original, 'go');
  const insertionOnly = editText({ ...newEssay('a'), stage: 'review' }, 1, 1, '\n\n ');
  assert.equal(finalText(insertionOnly), 'a\n\n ');
  assert.equal(editText(insertionOnly, 1, 4, '').revisions.length, 0);
});

test('selections spanning existing revisions retain source order and valid file format', () => {
  let essay = editText(sample(), 2, 4, 'went');
  essay = editText(essay, 10, 16, 'college');
  essay = editText(essay, 2, 17, 'studied at home');
  assert.equal(finalText(essay), 'I studied at home yesterday.');
  assert.equal(essay.original, sample().original);
  assert.deepEqual(parseEssay(JSON.parse(JSON.stringify(essay))), essay);
  assert.equal(
    segments(essay)
      .filter((piece) => piece.kind !== 'added')
      .map((piece) => piece.text)
      .join(''),
    essay.original,
  );
});

test('random direct edits match plain text editing without losing the original', () => {
  let seed = 7301;
  const random = (size: number) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed % size;
  };
  let essay = { ...newEssay('A café 🌍.\n你好，world!'), stage: 'review' as const };
  let expected = essay.original;
  const inserts = ['', 'x', ' ', '\n', '你好', '🌱', 'café'];
  for (let index = 0; index < 200; index++) {
    const boundaries = [0];
    for (const char of expected) boundaries.push(boundaries.at(-1)! + char.length);
    const a = random(boundaries.length),
      b = random(boundaries.length);
    const from = boundaries[Math.min(a, b)],
      to = boundaries[Math.max(a, b)];
    const text = inserts[random(inserts.length)];
    essay = editText(essay, from, to, text) as typeof essay;
    expected = expected.slice(0, from) + text + expected.slice(to);
    assert.equal(finalText(essay), expected, `edit ${index}`);
    assert.deepEqual(parseEssay(JSON.parse(JSON.stringify(essay))), essay);
    assert.equal(
      segments(essay)
        .filter((piece) => piece.kind !== 'added')
        .map((piece) => piece.text)
        .join(''),
      essay.original,
    );
  }
});

test('adjacent replacements are valid', () => {
  let essay: Essay = { ...newEssay('abcd'), stage: 'review' };
  essay = putRevision(essay, {
    id: 'a',
    type: 'replace',
    start: 0,
    end: 2,
    original: 'ab',
    text: 'A',
  });
  essay = putRevision(essay, {
    id: 'b',
    type: 'replace',
    start: 2,
    end: 4,
    original: 'cd',
    text: 'B',
  });
  assert.equal(finalText(essay), 'AB');
});

test('UTF-16 offsets cannot split emoji; multilingual multiline content round trips', () => {
  const essay = { ...newEssay('Hi 🌍!\n你好，café.'), stage: 'review' as const };
  assert.throws(() => putRevision(essay, insertion('bad', 4, '!')), /位置无效/);
  const changed = putRevision(essay, {
    id: 'good',
    type: 'replace',
    start: 3,
    end: 5,
    original: '🌍',
    text: '世界',
  });
  assert.deepEqual(parseEssay(JSON.parse(JSON.stringify(changed))), changed);
  assert.equal(finalText(changed), 'Hi 世界!\n你好，café.');
});

test('reject malformed or unsupported files without silently dropping records', () => {
  assert.throws(() => parseEssay({ ...sample(), version: 2 }), /版本/);
  assert.throws(() => parseEssay({ ...sample(), revisions: [replacement, replacement] }), /重复/);
  assert.throws(
    () => parseEssay({ ...sample(), revisions: [{ ...replacement, original: 'bad' }] }),
    /原文不匹配/,
  );
  assert.throws(
    () => parseEssay({ ...sample(), revisions: [{ ...replacement, start: -1 }] }),
    /位置无效/,
  );
  assert.throws(
    () => parseEssay({ ...sample(), stage: 'draft', revisions: [replacement] }),
    /草稿/,
  );
  assert.deepEqual(parseEssay(newEssay()), newEssay());
});

test('HTML export escapes title, source, and correction text, with embedded styles', () => {
  const essay = {
    ...newEssay('<script>alert(1)</script>', '<img src=x>'),
    stage: 'review' as const,
  };
  const html = exportHtml(putRevision(essay, insertion('x', 0, '<b>safe</b>')));
  assert.ok(html.includes('<style>'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<ins>&lt;b&gt;safe&lt;/b&gt;</ins>'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
});

test('text decoding supports BOMs, CRLF, UTF-8, GBK and western legacy encodings', () => {
  const utf8 = new TextEncoder().encode('café\r\n你好');
  assert.equal(detectEncoding(utf8), 'utf-8');
  assert.equal(decodeText(utf8, 'utf-8'), 'café\n你好');
  const utf16 = new Uint8Array([0xff, 0xfe, 0x41, 0]);
  assert.equal(detectEncoding(utf16), 'utf-16le');
  assert.equal(decodeText(utf16, 'utf-16le'), 'A');
  assert.equal(decodeText(new Uint8Array([0xfe, 0xff, 0, 0x41]), 'utf-16be'), 'A');
  assert.equal(decodeText(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]), 'gb18030'), '你好');
  assert.equal(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), 'windows-1252'), 'café');
});

test('normal edits preserve earlier marks and rebase original offsets', () => {
  let essay = editText(sample(), 2, 4, 'went');
  essay = editText(essay, 0, 0, 'Well, ', false);
  assert.equal(finalText(essay), 'Well, I went to school yesterday.');
  assert.equal(essay.original, 'Well, I go to school yesterday.');
  assert.equal(essay.revisions[0].start, 8);
  assert.equal(essay.revisions[0].original, 'go');
  assert.deepEqual(parseEssay(JSON.parse(JSON.stringify(essay))), essay);
  essay = editText(essay, 0, 6, '', false);
  assert.equal(finalText(essay), 'I went to school yesterday.');
  assert.equal(essay.revisions[0].start, 2);
});

test('normal typing inside green text is ordinary text; review can resume afterwards', () => {
  let essay = editText({ ...newEssay('abc'), stage: 'review' }, 1, 2, 'XYZ');
  essay = editText(essay, 3, 3, '-', false);
  assert.equal(finalText(essay), 'aXY-Zc');
  assert.equal(essay.original, 'ab-c');
  assert.ok(segments(essay).some((piece) => piece.kind === 'original' && piece.text === '-'));
  essay = editText(essay, 5, 6, 'd', true);
  assert.equal(finalText(essay), 'aXY-Zd');
  assert.deepEqual(parseEssay(JSON.parse(JSON.stringify(essay))), essay);
});

test('mixed tracked and ordinary edits keep valid revisions', () => {
  let essay = { ...newEssay('Hello 🌍.\n你好'), stage: 'review' as const };
  let expected = essay.original;
  for (let index = 0; index < 80; index++) {
    const boundaries = [0];
    for (const char of expected) boundaries.push(boundaries.at(-1)! + char.length);
    const from = boundaries[index % boundaries.length];
    const to =
      boundaries[Math.min(boundaries.length - 1, (index % boundaries.length) + (index % 3))];
    const text = ['', 'A', '🌱', ' '][index % 4];
    essay = editText(essay, from, to, text, index % 2 === 0) as typeof essay;
    expected = expected.slice(0, from) + text + expected.slice(to);
    assert.equal(finalText(essay), expected);
    assert.deepEqual(parseEssay(JSON.parse(JSON.stringify(essay))), essay);
  }
});

test('statistics count revised text and Unicode characters without whitespace', () => {
  assert.deepEqual(countText('Hello world.\n🌍'), { words: 2, characters: 12 });
  assert.deepEqual(countText(''), { words: 0, characters: 0 });
  const essay = editText(sample(), 2, 4, 'went');
  assert.deepEqual(countText(finalText(essay)), countText('I went to school yesterday.'));
});

test('settings validate values, translate every language and control HTML styling', () => {
  assert.deepEqual(parseSettings(null), defaultSettings);
  assert.deepEqual(parseSettings({ language: 'bad', addedBold: 'yes', addedItalic: true }), {
    ...defaultSettings,
    addedItalic: true,
  });
  for (const language of languages) {
    assert.ok(translate(language, 'file').length > 0);
    assert.ok(translate(language, 'count', { words: 1 }).includes('1'));
    assert.ok(!translate(language, 'count', { words: 1 }).includes('{'));
  }
  assert.equal(translateError('en', '修改位置无效。'), 'The edit position or revision is invalid.');
  const html = exportHtml(putRevision(sample(), replacement), {
    addedBold: false,
    addedItalic: true,
  });
  assert.ok(html.includes('font-weight:400;font-style:italic'));
});
