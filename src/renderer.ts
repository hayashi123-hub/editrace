import './api';
import {
  newEssay,
  editText,
  finalText,
  countText,
  detectEncoding,
  decodeText,
  MAX_TEXT,
} from './model';
import type { Essay, Encoding } from './model';
import { createEditor } from './editor';
import type { TextEdit, TextSelection } from './editor';
import { createMenus } from './menus';
import { defaultSettings } from './settings';
import type { AppSettings, Language } from './settings';
import { translate, translateError } from './i18n';
import type { MessageKey } from './i18n';
import type { EssaySummary } from './library';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const importDialog = $<HTMLDialogElement>('import-dialog');
const renameDialog = $<HTMLDialogElement>('rename-dialog');
const settingsDialog = $<HTMLDialogElement>('settings-dialog');
const actionButton = (action: string) =>
  document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
let essay = newEssay();
let essayId: string = crypto.randomUUID();
let libraryEntries: EssaySummary[] = [];
let renameTarget: string | null = null;
let storageReady = false;
let reviewActive = false;
let settings = { ...defaultSettings };
let pendingSettings: Promise<void> = Promise.resolve();
const t = (key: MessageKey, values?: Record<string, string | number>) =>
  translate(settings.language, key, values);
let savedSnapshot = JSON.stringify(essay);
type Snapshot = { essay: Essay; selection: TextSelection };
let undoStack: Snapshot[] = [],
  redoStack: Snapshot[] = [];
let lastTyping: { to: number; time: number } | null = null;
let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let importBytes = new Uint8Array(),
  importTitle = '';
let fileBusy = false;
const view = createEditor($('editor'), {
  getEssay: () => essay,
  isReview: () => reviewActive,
  edit: apply,
  undo,
  redo,
});
const menus = createMenus(
  run,
  () => view.selection(),
  () => view.focus(),
);

function message(text: string) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, 4500);
}
function errorMessage(error: unknown) {
  return translateError(
    settings.language,
    (error instanceof Error ? error.message : String(error)).replace(
      /^Error invoking remote method '[^']+': (Error: )?/,
      '',
    ),
  );
}
async function fileAction(action: () => Promise<void>) {
  if (!storageReady || fileBusy || view.composing) return;
  fileBusy = true;
  document.body.setAttribute('aria-busy', 'true');
  try {
    await pendingSettings;
    await action();
  } catch (error) {
    message(errorMessage(error));
  } finally {
    fileBusy = false;
    document.body.setAttribute('aria-busy', 'false');
  }
}
async function persist() {
  clearTimeout(autosaveTimer);
  await window.desktop.autosave(essayId, essay);
}

function renderLibrary() {
  const list = $('essay-list');
  list.replaceChildren();
  for (const item of libraryEntries) {
    const button = document.createElement('button');
    button.className = 'essay-item';
    button.dataset.essayId = item.id;
    if (item.id === essayId) button.setAttribute('aria-current', 'true');
    const title = document.createElement('span');
    title.className = 'essay-title';
    title.textContent = item.title === '未命名作文' ? t('untitled') : item.title;
    button.title = title.textContent;
    const date = document.createElement('time');
    date.dateTime = item.updatedAt;
    date.textContent = new Date(item.updatedAt).toLocaleDateString(settings.language, {
      month: 'short',
      day: 'numeric',
    });
    button.append(title, date);
    button.onclick = () => {
      if (item.id === essayId) return;
      void fileAction(async () => {
        if (!(await canReplace())) return;
        const next = await window.desktop.loadEssay(item.id);
        await load(next, true, item.id);
      });
    };
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      void libraryMenu(item);
    });
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        void libraryMenu(item);
      }
    });
    list.append(button);
  }
  $('library-empty').hidden = libraryEntries.length > 0;
}
function showRename(id: string, title: string) {
  renameTarget = id;
  $<HTMLInputElement>('title-input').value = title === '未命名作文' ? '' : title;
  renameDialog.showModal();
  $<HTMLInputElement>('title-input').select();
}

async function libraryMenu(item: EssaySummary) {
  if (document.querySelector('dialog[open]')) return;
  menus.close();
  await fileAction(async () => {
    const action = await window.desktop.essayMenu();
    if (!action) return;
    if (action === 'open') {
      if (item.id !== essayId && (await canReplace()))
        await load(await window.desktop.loadEssay(item.id), true, item.id);
    } else if (action === 'rename') {
      showRename(item.id, item.id === essayId ? essay.title : item.title);
    } else if (action === 'delete') {
      const title = item.id === essayId ? essay.title : item.title;
      if (!(await window.desktop.confirmDelete(title === '未命名作文' ? t('untitled') : title))) return;
      // Finish any pending recovery write before deletion so it cannot restore the entry.
      if (item.id === essayId) await persist();
      await window.desktop.deleteEssay(item.id);
      libraryEntries = await window.desktop.listEssays();
      if (item.id === essayId) await load(newEssay(), true);
      else renderLibrary();
    } else if (action.startsWith('export-')) {
      const target = item.id === essayId ? essay : await window.desktop.loadEssay(item.id);
      await window.desktop.export(target, action.slice(7) as 'original' | 'final' | 'html' | 'essay');
    }
  });
}

function updateMenus() {
  actionButton('undo').disabled = !undoStack.length;
  actionButton('redo').disabled = !redoStack.length;
  const review = $('review-toggle');
  review.setAttribute('aria-pressed', String(reviewActive));
  review.textContent = t(reviewActive ? 'stopReview' : 'startReview');
  review.title = t(reviewActive ? 'reviewOnHint' : 'reviewOffHint');
  const counts = countText(finalText(essay));
  $('word-count').textContent = t('count', {
    words: counts.words.toLocaleString(settings.language),
    characters: counts.characters.toLocaleString(settings.language),
  });
  $('word-count').title = t('countHint');
  const sidebarLabel = t($('sidebar').hidden ? 'showSidebar' : 'hideSidebar');
  $('sidebar-toggle').setAttribute('aria-label', sidebarLabel);
  $('sidebar-toggle').title = sidebarLabel;
  document.title = `${essay.title === '未命名作文' ? t('untitled') : essay.title}${JSON.stringify(essay) !== savedSnapshot ? ' ·' : ''} — editrace`;
}
function changed() {
  updateMenus();
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    persist().catch((error) => message(t('backupFailed', { error: errorMessage(error) })));
  }, 450);
}
function snapshot(): Snapshot {
  return { essay: structuredClone(essay), selection: view.selection() };
}
function pushUndo(value: Snapshot) {
  undoStack.push(value);
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
}

function apply(edit: TextEdit, internal = false) {
  if (!storageReady || (fileBusy && !internal)) return;
  if (edit.from === edit.to && !edit.text) return;
  try {
    const next = editText(
      reviewActive ? { ...essay, stage: 'review' } : essay,
      edit.from,
      edit.to,
      edit.text,
      reviewActive,
    );
    const grouped =
      edit.kind === 'typing' &&
      edit.from === edit.to &&
      lastTyping?.to === edit.from &&
      Date.now() - lastTyping.time < 900;
    if (!grouped)
      pushUndo({ essay: structuredClone(essay), selection: { from: edit.from, to: edit.to } });
    essay = next;
    const caret = edit.from + edit.text.length;
    lastTyping = edit.kind === 'typing' ? { to: caret, time: Date.now() } : null;
    view.render(essay, { from: caret, to: caret });
    changed();
  } catch (error) {
    view.render(essay, view.selection());
    message(errorMessage(error));
  }
}
function undo() {
  if (!storageReady || fileBusy || view.composing) return;
  const previous = undoStack.pop();
  if (!previous) return;
  redoStack.push(snapshot());
  essay = previous.essay;
  lastTyping = null;
  view.render(essay, previous.selection);
  changed();
}
function redo() {
  if (!storageReady || fileBusy || view.composing) return;
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(snapshot());
  essay = next.essay;
  lastTyping = null;
  view.render(essay, next.selection);
  changed();
}
function toggleReview() {
  if (!storageReady || view.composing || fileBusy) return;
  const selection = view.selection();
  reviewActive = !reviewActive;
  lastTyping = null;
  view.render(essay, selection);
  updateMenus();
}

async function save(): Promise<boolean> {
  const copy = structuredClone(essay);
  const saved = await window.desktop.save(essayId, copy);
  essay = saved;
  savedSnapshot = JSON.stringify(saved);
  clearTimeout(autosaveTimer);
  libraryEntries = await window.desktop.listEssays();
  renderLibrary();
  updateMenus();
  message(t('saved'));
  return true;
}
async function canReplace() {
  if (JSON.stringify(essay) === savedSnapshot || (!essay.original && !essay.revisions.length))
    return true;
  const decision = await window.desktop.confirmReplace();
  return decision === 'discard' || (decision === 'save' && (await save()));
}
async function load(next: Essay, saved: boolean, id: string = crypto.randomUUID()) {
  clearTimeout(autosaveTimer);
  await window.desktop.autosave(id, next);
  essayId = id;
  essay = next;
  reviewActive = false;
  undoStack = [];
  redoStack = [];
  lastTyping = null;
  savedSnapshot = saved ? JSON.stringify(essay) : '';
  view.render(essay, { from: 0, to: 0 });
  $('editor-scroll').scrollTop = 0;
  updateMenus();
  renderLibrary();
}

function previewImport() {
  const text = decodeText(importBytes, $<HTMLSelectElement>('encoding-select').value as Encoding);
  $('import-preview').textContent = text.slice(0, 12_000) + (text.length > 12_000 ? '\n…' : '');
  $('import-error').textContent =
    text.length > MAX_TEXT ? t('tooLong') : text.includes('\uFFFD') ? t('encodingWarning') : '';
  $<HTMLButtonElement>('import-confirm').disabled = text.length > MAX_TEXT;
  return text;
}
async function open() {
  if (!(await canReplace())) return;
  const result = await window.desktop.open();
  if (!result) return;
  if (result.kind === 'essay') {
    await load(result.essay, false);
    return;
  }
  importBytes = new Uint8Array(result.bytes);
  importTitle = result.name;
  $<HTMLSelectElement>('encoding-select').value = detectEncoding(importBytes);
  previewImport();
  importDialog.showModal();
}

function run(action: string) {
  if (!storageReady || fileBusy || view.composing) return;
  lastTyping = null;
  if (action === 'undo') {
    undo();
    return;
  }
  if (action === 'redo') {
    redo();
    return;
  }
  if (action === 'toggle-review') {
    toggleReview();
    return;
  }
  if (action === 'settings') {
    settingsDialog.showModal();
    return;
  }
  if (action === 'select-all') {
    view.focus({ from: 0, to: finalText(essay).length });
    return;
  }
  if (action === 'rename') {
    showRename(essayId, essay.title);
    return;
  }
  void fileAction(async () => {
    if (action === 'new') {
      if (!(await canReplace())) return;
      await load(newEssay(), true);
    } else if (action === 'open') await open();
    else if (action === 'save') await save();
    else if (action === 'cut' || action === 'copy' || action === 'paste') {
      const range = view.selection();
      if (action !== 'paste' && range.from === range.to) return;
      const text = await window.desktop.clipboard(
        action,
        finalText(essay).slice(range.from, range.to),
      );
      if (action !== 'copy')
        apply(
          {
            ...range,
            text: action === 'paste' ? text.replace(/\r\n?/g, '\n') : '',
            kind: action === 'paste' ? 'paste' : 'delete',
          },
          true,
        );
    } else if (action.startsWith('export-'))
      await window.desktop.export(
        essay,
        action.slice(7) as 'original' | 'final' | 'html' | 'essay',
      );
  });
}

function applySettings() {
  document.documentElement.lang = settings.language;
  document.body.dataset.addedBold = String(settings.addedBold);
  document.body.dataset.addedItalic = String(settings.addedItalic);
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n as MessageKey);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach((node) => {
    node.setAttribute('aria-label', t(node.dataset.i18nAria as MessageKey));
  });
  $<HTMLSelectElement>('language-select').value = settings.language;
  $<HTMLInputElement>('added-bold').checked = settings.addedBold;
  $<HTMLInputElement>('added-italic').checked = settings.addedItalic;
  updateMenus();
  renderLibrary();
}
function changeSettings() {
  const next: AppSettings = {
    language: $<HTMLSelectElement>('language-select').value as Language,
    addedBold: $<HTMLInputElement>('added-bold').checked,
    addedItalic: $<HTMLInputElement>('added-italic').checked,
  };
  settings = next;
  applySettings();
  pendingSettings = pendingSettings
    .then(async () => {
      await window.desktop.saveSettings(next);
    })
    .catch((error) => message(t('settingsFailed', { error: errorMessage(error) })));
}
for (const id of ['language-select', 'added-bold', 'added-italic'])
  $(id).addEventListener('change', changeSettings);
$('settings-close').onclick = () => {
  settingsDialog.close();
  view.focus();
};
$('review-toggle').addEventListener('mousedown', (event) => event.preventDefault());
$('review-toggle').onclick = () => {
  menus.close();
  toggleReview();
};
$('sidebar-toggle').addEventListener('mousedown', (event) => event.preventDefault());
$('sidebar-toggle').onclick = () => {
  const sidebar = $('sidebar');
  sidebar.hidden = !sidebar.hidden;
  $('sidebar-toggle').setAttribute('aria-expanded', String(!sidebar.hidden));
  $('sidebar-toggle').firstElementChild!.textContent = sidebar.hidden ? '›' : '‹';
  updateMenus();
};
$('encoding-select').onchange = previewImport;
$('import-cancel').onclick = () => {
  importDialog.close();
  view.focus();
};
$('import-confirm').onclick = () => {
  void fileAction(async () => {
    const text = previewImport();
    if (text.length > MAX_TEXT) return;
    importDialog.close();
    await load(newEssay(text, importTitle.slice(0, 200)), false);
  });
};
$('rename-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const id = renameTarget;
  const title = $<HTMLInputElement>('title-input').value.trim() || '未命名作文';
  if (!id) return;
  void fileAction(async () => {
    const saved = libraryEntries.some((item) => item.id === id);
    if (saved) {
      if (id === essayId) await persist();
      await window.desktop.renameEssay(id, title);
    }
    if (id === essayId) {
      essay = { ...essay, title };
      if (saved && savedSnapshot)
        savedSnapshot = JSON.stringify({ ...JSON.parse(savedSnapshot), title });
      for (const entry of [...undoStack, ...redoStack]) entry.essay.title = title;
      changed();
    }
    libraryEntries = await window.desktop.listEssays();
    renderLibrary();
    renameDialog.close();
    renameTarget = null;
    view.focus();
  });
});
$('rename-cancel').onclick = () => {
  renameDialog.close();
  view.focus();
};

document.addEventListener('keydown', (event) => {
  if (
    event.isComposing ||
    view.composing ||
    !(event.ctrlKey || event.metaKey) ||
    document.querySelector('dialog[open]')
  )
    return;
  const key = event.key.toLowerCase();
  const action =
    key === 's'
      ? event.shiftKey
        ? 'export-essay'
        : 'save'
      : key === 'n'
        ? 'new'
        : key === 'o'
          ? 'open'
          : key === 'z'
            ? event.shiftKey
              ? 'redo'
              : 'undo'
            : key === 'y'
              ? 'redo'
              : key === 'enter'
                ? 'toggle-review'
                : key === ','
                  ? 'settings'
                  : undefined;
  if (action) {
    event.preventDefault();
    menus.close();
    run(action);
  }
});
window.desktop.onClose(() => {
  if (!storageReady) {
    window.desktop.closeReady();
    return;
  }
  if (view.composing || document.querySelector('dialog[open]')) {
    message(t('finishAction'));
    return;
  }
  void fileAction(async () => {
    await persist();
    window.desktop.closeReady();
  });
});

async function initialize() {
  const [savedSettings, recovery] = await Promise.all([
    window.desktop.getSettings(),
    window.desktop.recover(),
  ]);
  settings = savedSettings;
  if (recovery.session) {
    essay = recovery.session.essay;
    essayId = recovery.session.id;
    savedSnapshot = recovery.session.savedEssay ? JSON.stringify(recovery.session.savedEssay) : '';
  }
  // Read the list after recovery, since an old recovery file may have been migrated.
  libraryEntries = await window.desktop.listEssays();
  storageReady = true;
  view.render(essay, { from: 0, to: 0 });
  applySettings();
  document.body.dataset.ready = 'true';
  if (recovery.warning) message(recovery.warning);
}
void initialize().catch((error) => {
  message(errorMessage(error));
});
