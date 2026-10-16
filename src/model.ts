export interface Revision {
  id: string;
  type: 'replace' | 'insert';
  start: number;
  end: number;
  original: string;
  text: string;
}

export interface Essay {
  format: 'essay-editor';
  version: 1;
  title: string;
  original: string;
  stage: 'draft' | 'review';
  revisions: Revision[];
}

export interface Segment {
  kind: 'original' | 'deleted' | 'added';
  text: string;
  start: number;
  end: number;
  revisionId?: string;
}

export const MAX_TEXT = 500_000;

export function newEssay(original = '', title = '未命名作文'): Essay {
  return { format: 'essay-editor', version: 1, title, original, stage: 'draft', revisions: [] };
}

function boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const previous = text.charCodeAt(offset - 1),
    current = text.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff);
}

export function validateRevision(essay: Essay, revision: Revision, excludedId?: string): void {
  const { start, end, type, text } = revision;
  if (
    !revision.id ||
    !['replace', 'insert'].includes(type) ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > essay.original.length ||
    !boundary(essay.original, start) ||
    !boundary(essay.original, end)
  ) {
    throw new Error('修改位置无效。');
  }
  if (typeof text !== 'string' || text.length > MAX_TEXT || (type === 'insert' && !text.length))
    throw new Error('修改内容无效（最多 50 万字符）。');
  if ((type === 'insert' && start !== end) || (type === 'replace' && start === end))
    throw new Error('修改类型与选区不匹配。');
  if (revision.original !== essay.original.slice(start, end))
    throw new Error('修改记录与原文不匹配。');
  for (const other of essay.revisions) {
    if (other.id === excludedId) continue;
    if (other.id === revision.id) throw new Error('修改记录编号重复。');
    const overlap =
      type === 'replace' && other.type === 'replace' && start < other.end && end > other.start;
    const containsInsert =
      type === 'replace' && other.type === 'insert' && other.start > start && other.start < end;
    const insideReplace =
      type === 'insert' && other.type === 'replace' && start > other.start && start < other.end;
    if (overlap || containsInsert || insideReplace)
      throw new Error('选区包含已有修改，请先编辑或撤销那条修改。');
    if (type === 'insert' && other.type === 'insert' && start === other.start)
      throw new Error('此位置已有添加内容，请点击绿色文字编辑。');
  }
}

export function putRevision(essay: Essay, revision: Revision): Essay {
  validateRevision(essay, revision, revision.id);
  return {
    ...essay,
    revisions: [...essay.revisions.filter((item) => item.id !== revision.id), revision],
  };
}

export function parseEssay(input: unknown): Essay {
  if (!input || typeof input !== 'object') throw new Error('不是有效的练习文件。');
  const value = input as Essay;
  if (value.format !== 'essay-editor' || value.version !== 1)
    throw new Error('不支持此练习文件格式或版本。');
  if (
    typeof value.title !== 'string' ||
    value.title.length > 200 ||
    typeof value.original !== 'string' ||
    value.original.length > MAX_TEXT ||
    !['draft', 'review'].includes(value.stage) ||
    !Array.isArray(value.revisions) ||
    value.revisions.length > 10_000
  ) {
    throw new Error('练习文件内容无效或超出大小限制。');
  }
  if (value.stage === 'draft' && value.revisions.length) throw new Error('草稿不能包含批改记录。');
  const result = { ...newEssay(value.original, value.title), stage: value.stage };
  for (const item of value.revisions) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length > 100)
      throw new Error('修改记录无效。');
    validateRevision(result, item);
    result.revisions.push({
      id: item.id,
      type: item.type,
      start: item.start,
      end: item.end,
      original: item.original,
      text: item.text,
    });
  }
  return result;
}

export function segments(essay: Essay): Segment[] {
  const result: Segment[] = [];
  const sorted = [...essay.revisions].sort(
    (a, b) => a.start - b.start || (a.type === 'insert' ? -1 : 1),
  );
  let cursor = 0;
  for (const item of sorted) {
    if (item.start > cursor)
      result.push({
        kind: 'original',
        text: essay.original.slice(cursor, item.start),
        start: cursor,
        end: item.start,
      });
    if (item.type === 'replace')
      result.push({
        kind: 'deleted',
        text: item.original,
        start: item.start,
        end: item.end,
        revisionId: item.id,
      });
    result.push({
      kind: 'added',
      text: item.text,
      start: item.start,
      end: item.end,
      revisionId: item.id,
    });
    cursor = item.end;
  }
  if (cursor < essay.original.length || result.length === 0)
    result.push({
      kind: 'original',
      text: essay.original.slice(cursor),
      start: cursor,
      end: essay.original.length,
    });
  return result;
}

export function finalText(essay: Essay): string {
  return segments(essay)
    .filter((item) => item.kind !== 'deleted')
    .map((item) => item.text)
    .join('');
}

/** Edit offsets refer to the current, clean text; original offsets never change. */
export function editText(
  essay: Essay,
  from: number,
  to: number,
  text: string,
  trackChanges = essay.stage === 'review',
): Essay {
  const current = essay.stage === 'draft' ? essay.original : finalText(essay);
  if (
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 0 ||
    to < from ||
    to > current.length ||
    !boundary(current, from) ||
    !boundary(current, to)
  )
    throw new Error('编辑位置无效。');
  if (current.length - (to - from) + text.length > MAX_TEXT)
    throw new Error('作文最多支持 50 万字符。');
  if (essay.stage === 'draft')
    return { ...essay, original: current.slice(0, from) + text + current.slice(to) };

  // Keep original characters (including deleted ones) in source order. Only added
  // text is removed outright. This also handles a selection spanning old revisions.
  const pieces: { kind: Segment['kind']; text: string }[] = [];
  const append = (kind: Segment['kind'], value: string) => {
    if (!value) return;
    const previous = pieces.at(-1);
    if (previous?.kind === kind) previous.text += value;
    else pieces.push({ kind, text: value });
  };
  let cursor = 0,
    inserted = false;
  for (const piece of segments(essay)) {
    if (piece.kind === 'deleted') {
      append('deleted', piece.text);
      continue;
    }
    const length = piece.text.length;
    const a = Math.max(0, Math.min(length, from - cursor));
    const b = Math.max(0, Math.min(length, to - cursor));
    append(piece.kind, piece.text.slice(0, a));
    if (piece.kind === 'original' && trackChanges) append('deleted', piece.text.slice(a, b));
    if (!inserted && to < cursor + length) {
      append(trackChanges ? 'added' : 'original', text);
      inserted = true;
    }
    append(piece.kind, piece.text.slice(b));
    cursor += length;
  }
  if (!inserted) append(trackChanges ? 'added' : 'original', text);

  // Ordinary edits update the source, while keeping earlier red/green fragments.
  // Rebuilding offsets also preserves corrections after an insertion before them.
  const original = trackChanges
    ? essay.original
    : pieces
        .filter((piece) => piece.kind !== 'added')
        .map((piece) => piece.text)
        .join('');
  if (original.length > MAX_TEXT) throw new Error('作文最多支持 50 万字符。');

  const revisions: Revision[] = [];
  let source = 0,
    start = 0,
    added = '',
    pending = false;
  const oldIds = new Map(essay.revisions.map((item) => [`${item.start}:${item.end}`, item.id]));
  function flush() {
    if (!pending) return;
    revisions.push({
      id: oldIds.get(`${start}:${source}`) ?? crypto.randomUUID(),
      type: source === start ? 'insert' : 'replace',
      start,
      end: source,
      original: original.slice(start, source),
      text: added,
    });
    pending = false;
    added = '';
  }
  for (const piece of pieces) {
    if (piece.kind === 'original') {
      flush();
      source += piece.text.length;
    } else {
      if (!pending) {
        start = source;
        pending = true;
      }
      if (piece.kind === 'deleted') source += piece.text.length;
      else added += piece.text;
    }
  }
  flush();
  if (revisions.length > 10_000) throw new Error('修改记录过多，请保存并开始一篇新练习。');
  return { ...essay, original, revisions };
}

const wordSegmenter = new Intl.Segmenter('und', { granularity: 'word' });
const characterSegmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
export function countText(text: string): { words: number; characters: number } {
  let words = 0,
    characters = 0;
  for (const part of wordSegmenter.segment(text)) if (part.isWordLike) words++;
  for (const part of characterSegmenter.segment(text)) if (/\S/u.test(part.segment)) characters++;
  return { words, characters };
}

export function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
}

export function exportHtml(
  essay: Essay,
  appearance = { addedBold: true, addedItalic: false },
): string {
  const content = segments(essay)
    .map((item) =>
      item.kind === 'deleted'
        ? `<del>${escapeHtml(item.text)}</del>`
        : item.kind === 'added'
          ? `<ins>${escapeHtml(item.text)}</ins>`
          : escapeHtml(item.text),
    )
    .join('');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(essay.title)}</title><style>
body{margin:0;padding:32px 40px;color:#242424;background:#fff;font:18px/1.85 Georgia,"Microsoft YaHei",serif}
article{white-space:pre-wrap;overflow-wrap:anywhere}
del{color:#be3434;text-decoration-thickness:1.5px}ins{color:#218247;text-decoration:none;font-weight:${appearance.addedBold ? 600 : 400};font-style:${appearance.addedItalic ? 'italic' : 'normal'}}del+ins{margin-left:.12em}
@media print{body{padding:0}}
</style></head><body><article>${content}</article></body></html>`;
}

export type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030' | 'windows-1252';

export function detectEncoding(bytes: Uint8Array): Encoding {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return 'utf-8';
  } catch {
    return 'gb18030';
  }
}

export function decodeText(bytes: Uint8Array, encoding: Encoding): string {
  return new TextDecoder(encoding).decode(bytes).replace(/\r\n?/g, '\n');
}
