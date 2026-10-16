import { finalText, segments } from './model';
import type { Essay } from './model';

export interface TextSelection {
  from: number;
  to: number;
}
export interface TextEdit extends TextSelection {
  text: string;
  kind: 'typing' | 'delete' | 'paste' | 'composition';
}

export function createEditor(
  element: HTMLElement,
  options: {
    getEssay(): Essay;
    isReview(): boolean;
    edit(edit: TextEdit): void;
    undo(): void;
    redo(): void;
  },
) {
  let remembered: TextSelection = { from: 0, to: 0 };
  let composition: TextSelection | null = null;
  let finishingComposition = false;
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const text = () => finalText(options.getEssay());

  function offsetAt(node: Node, offset: number): number {
    const prefix = document.createRange();
    prefix.setStart(element, 0);
    prefix.setEnd(node, offset);
    const contents = prefix.cloneContents();
    contents
      .querySelectorAll('[data-kind="deleted"], [data-tail]')
      .forEach((node) => node.remove());
    return Math.min(text().length, contents.textContent!.length);
  }

  function selection(): TextSelection {
    const selected = window.getSelection();
    if (selected?.rangeCount) {
      const range = selected.getRangeAt(0);
      if (element.contains(range.startContainer) && element.contains(range.endContainer)) {
        remembered = {
          from: offsetAt(range.startContainer, range.startOffset),
          to: offsetAt(range.endContainer, range.endOffset),
        };
      }
    }
    return { ...remembered };
  }

  function focus(target: TextSelection = remembered, scroll = false): void {
    const length = text().length;
    remembered = { from: Math.min(target.from, length), to: Math.min(target.to, length) };
    const nodes = [
      ...element.querySelectorAll<HTMLElement>('[data-kind="original"], [data-kind="added"]'),
    ];
    function point(offset: number): [Node, number] {
      // Prefer the inside of green text at a boundary, so the caret stays beside
      // the new words instead of jumping across their red original.
      const node =
        nodes.find(
          (node) =>
            node.dataset.kind === 'added' &&
            Number(node.dataset.from) <= offset &&
            Number(node.dataset.to) >= offset,
        ) ??
        nodes.find(
          (node) => Number(node.dataset.from) <= offset && Number(node.dataset.to) >= offset,
        );
      if (node?.firstChild) return [node.firstChild, offset - Number(node.dataset.from)];
      return [element, Math.max(0, element.childNodes.length - 1)];
    }
    const range = document.createRange();
    range.setStart(...point(remembered.from));
    range.setEnd(...point(remembered.to));
    element.focus({ preventScroll: true });
    const selected = window.getSelection()!;
    selected.removeAllRanges();
    selected.addRange(range);
    if (scroll) {
      const rect = range.getBoundingClientRect();
      const viewport = element.parentElement!.getBoundingClientRect();
      if (rect.height && rect.bottom > viewport.bottom - 20)
        element.parentElement!.scrollTop += rect.bottom - viewport.bottom + 35;
      if (rect.height && rect.top < viewport.top + 10)
        element.parentElement!.scrollTop -= viewport.top + 20 - rect.top;
    }
  }

  function render(essay: Essay, caret?: TextSelection): void {
    const pieces =
      essay.stage === 'review' ? segments(essay) : [{ kind: 'original', text: essay.original }];
    let cursor = 0;
    const nodes: HTMLElement[] = [];
    for (const piece of pieces) {
      if (!piece.text) continue;
      const span = document.createElement('span');
      span.textContent = piece.text;
      span.dataset.kind = piece.kind;
      span.dataset.from = String(cursor);
      if (piece.kind === 'deleted') span.contentEditable = 'false';
      else cursor += piece.text.length;
      span.dataset.to = String(cursor);
      nodes.push(span);
    }
    if (!cursor || text().endsWith('\n')) {
      const tail = document.createElement('br');
      tail.dataset.tail = '';
      nodes.push(tail);
    }
    element.replaceChildren(...nodes);
    element.contentEditable = 'true';
    element.dataset.stage = options.isReview() ? 'review' : 'draft';
    if (caret) focus(caret, true);
  }

  function normalizeWordSelection(range: TextSelection): TextSelection {
    let { from, to } = range;
    const current = text();
    if (from < to && current.slice(from, to).trim()) {
      while (from < to && /[ \t\u00a0]/.test(current[from])) from++;
      while (to > from && /[ \t\u00a0]/.test(current[to - 1])) to--;
    }
    return { from, to };
  }

  function insert(value: string, kind: TextEdit['kind'], range = selection()): void {
    const target =
      kind === 'typing' && value.trim() && options.isReview()
        ? normalizeWordSelection(range)
        : range;
    options.edit({ ...target, text: value.replace(/\r\n?/g, '\n'), kind });
  }

  element.addEventListener('beforeinput', (event) => {
    const input = event as InputEvent;
    if (composition || input.isComposing) return;
    if (finishingComposition || input.inputType === 'insertFromComposition') {
      event.preventDefault();
      return;
    }
    if (!input.cancelable) return;
    event.preventDefault();
    const type = input.inputType;
    if (type === 'historyUndo') {
      options.undo();
      return;
    }
    if (type === 'historyRedo') {
      options.redo();
      return;
    }
    let range = selection();
    const target = input.getTargetRanges()[0];
    if (target && (type.startsWith('delete') || type === 'insertReplacementText')) {
      range = {
        from: offsetAt(target.startContainer, target.startOffset),
        to: offsetAt(target.endContainer, target.endOffset),
      };
    }
    if (type === 'insertText' || type === 'insertReplacementText')
      insert(input.data ?? '', 'typing', range);
    else if (type === 'insertParagraph' || type === 'insertLineBreak')
      insert('\n', 'typing', range);
    else if (type.startsWith('delete')) {
      if (range.from === range.to) {
        const boundaries = [...graphemes.segment(text())].map((part) => part.index);
        boundaries.push(text().length);
        if (type.includes('Backward'))
          range.from = boundaries.filter((index) => index < range.from).at(-1) ?? 0;
        else range.to = boundaries.find((index) => index > range.to) ?? text().length;
      }
      options.edit({ ...range, text: '', kind: 'delete' });
    }
  });

  element.addEventListener('compositionstart', () => {
    composition = options.isReview() ? normalizeWordSelection(selection()) : selection();
    element.classList.add('composing');
  });
  element.addEventListener('compositionend', (event) => {
    const range = composition;
    composition = null;
    finishingComposition = true;
    queueMicrotask(() => {
      finishingComposition = false;
      element.classList.remove('composing');
      if (range && event.data) insert(event.data, 'composition', range);
      else render(options.getEssay(), range ?? remembered);
    });
  });
  element.addEventListener('input', () => {
    // A non-cancelable browser edit (e.g. spellcheck) is reconciled into one
    // transaction; IME preview is left alone until its composition commits.
    if (composition || finishingComposition) return;
    const copy = element.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[data-kind="deleted"], [data-tail]').forEach((node) => node.remove());
    const current = text(),
      actual = copy.textContent!.replace(/\r\n?/g, '\n');
    if (actual === current) return;
    let from = 0,
      end = current.length,
      newEnd = actual.length;
    while (from < end && from < newEnd && current[from] === actual[from]) from++;
    while (end > from && newEnd > from && current[end - 1] === actual[newEnd - 1]) {
      end--;
      newEnd--;
    }
    if (from > 0 && /[\uDC00-\uDFFF]/.test(current[from] ?? '')) from--;
    if (end < current.length && /[\uDC00-\uDFFF]/.test(current[end])) {
      end++;
      newEnd++;
    }
    options.edit({ from, to: end, text: actual.slice(from, newEnd), kind: 'typing' });
  });

  element.addEventListener('paste', (event) => {
    event.preventDefault();
    if (!composition) insert(event.clipboardData?.getData('text/plain') ?? '', 'paste');
  });
  for (const command of ['copy', 'cut'] as const)
    element.addEventListener(command, (event) => {
      if (composition) return;
      const range = selection();
      if (range.from === range.to) return;
      event.preventDefault();
      event.clipboardData?.setData('text/plain', text().slice(range.from, range.to));
      if (command === 'cut') options.edit({ ...range, text: '', kind: 'delete' });
    });
  element.addEventListener('dragstart', (event) => event.preventDefault());
  element.addEventListener('drop', (event) => {
    event.preventDefault();
  });
  document.addEventListener('selectionchange', () => {
    if (!composition && !finishingComposition) selection();
  });

  return {
    render,
    selection,
    focus,
    get composing() {
      return !!composition || finishingComposition;
    },
  };
}
