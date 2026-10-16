import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu } from 'electron';
import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EssayLibrary } from './library';
import { exportHtml, finalText, parseEssay } from './model';
import { defaultSettings, parseSettings } from './settings';
import { translate } from './i18n';
import type { MessageKey } from './i18n';

let window: BrowserWindow;
let library: EssayLibrary;
let closeAllowed = false;
let settingsQueue: Promise<void> = Promise.resolve();
let settings = { ...defaultSettings };
const t = (key: MessageKey, values?: Record<string, string | number>) =>
  translate(settings.language, key, values);
const MAX_FILE_BYTES = 12 * 1024 * 1024;
// Keep existing libraries and settings when the product name changes.
// Tests use a separate profile and never touch the user's practice files.
app.setPath('userData', process.env.ESSAY_EDITOR_TEST_DATA || path.join(app.getPath('appData'), 'essay-editor'));
const hasInstanceLock = app.requestSingleInstanceLock();
if (!hasInstanceLock) app.quit();
app.on('second-instance', () => {
  if (window) {
    if (window.isMinimized()) window.restore();
    window.focus();
  }
});

async function atomicWrite(target: string, content: string): Promise<void> {
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, target);
}

function safeName(title: string): string {
  return (
    title
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/[. ]+$/g, '')
      .slice(0, 80) || '作文'
  );
}

function registerHandlers(): void {
  // Only the application's own top frame can call these narrow file operations.
  function handle(channel: string, callback: (...args: any[]) => unknown) {
    ipcMain.handle(channel, (event, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
        throw new Error('不允许的请求。');
      return callback(...args);
    });
  }

  handle('essay:open', async () => {
    const result = await dialog.showOpenDialog(window, {
      title: t('openTitle'),
      properties: ['openFile'],
      filters: [{ name: t('practiceFilter'), extensions: ['txt', 'essay'] }],
    });
    if (result.canceled) return null;
    const file = result.filePaths[0];
    if ((await stat(file)).size > MAX_FILE_BYTES) throw new Error(t('tooLarge'));
    const bytes = await readFile(file);
    if (path.extname(file).toLowerCase() === '.essay') {
      const essay = parseEssay(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')));
      return { kind: 'essay', essay, name: path.basename(file) };
    }
    if (path.extname(file).toLowerCase() !== '.txt') throw new Error(t('unsupported'));
    return { kind: 'txt', bytes: Array.from(bytes), name: path.basename(file, path.extname(file)) };
  });

  handle('essay:save', (id: string, input: unknown) => library.save(id, input));
  handle('library:list', () => library.list());
  handle('library:rename', (id: string, title: string) => library.rename(id, title));
  handle('library:delete', (id: string) => library.delete(id));
  handle('library:confirm-delete', async (title: string) => {
    const result = await dialog.showMessageBox(window, {
      type: 'warning',
      message: t('deleteConfirm', { title }),
      buttons: [t('cancel'), t('delete')],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return result.response === 1;
  });
  handle('library:menu', () => new Promise<string | null>((resolve) => {
    const item = (action: string, label: MessageKey) => ({
      label: t(label), click: () => resolve(action),
    });
    Menu.buildFromTemplate([
      item('open', 'openTitle'),
      item('rename', 'rename'),
      { type: 'separator' },
      { label: t('export'), submenu: [
        item('export-essay', 'practiceFile'),
        item('export-original', 'original'),
        item('export-final', 'final'),
        item('export-html', 'html'),
      ] },
      { type: 'separator' },
      item('delete', 'deleteEssay'),
    ]).popup({ window, callback: () => resolve(null) });
  }));
  handle('library:load', (id: string) => {
    const essay = library.get(id);
    if (!essay) throw new Error(t('essayMissing'));
    return essay;
  });

  handle('essay:export', async (input: unknown, kind: string) => {
    const essay = parseEssay(input);
    if (!['original', 'final', 'html', 'essay'].includes(kind)) throw new Error('导出类型无效。');
    const extension = kind === 'essay' ? 'essay' : kind === 'html' ? 'html' : 'txt';
    const suffix = t(kind === 'essay' ? 'practiceFile' : (kind as 'original' | 'final' | 'html'));
    const result = await dialog.showSaveDialog(window, {
      title: `${t('export')} — ${suffix}`,
      defaultPath: `${safeName(essay.title === '未命名作文' ? t('untitled') : essay.title)}-${suffix}.${extension}`,
      filters: [
        {
          name:
            extension === 'essay'
              ? t('essayFilter')
              : extension === 'html'
                ? t('htmlFilter')
                : t('textFilter'),
          extensions: [extension],
        },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    if (path.extname(result.filePath).toLowerCase() !== `.${extension}`)
      throw new Error(t('extension', { extension }));
    const content =
      kind === 'essay'
        ? JSON.stringify(essay, null, 2)
        : kind === 'html'
          ? exportHtml(essay, settings)
          : kind === 'final'
            ? finalText(essay)
            : essay.original;
    await atomicWrite(result.filePath, content);
    return path.basename(result.filePath);
  });

  handle('settings:get', () => settings);
  handle('settings:save', (input: unknown) => {
    const next = parseSettings(input);
    settingsQueue = settingsQueue
      .catch(() => {})
      .then(async () => {
        await mkdir(app.getPath('userData'), { recursive: true });
        await atomicWrite(
          path.join(app.getPath('userData'), 'settings.json'),
          JSON.stringify(next, null, 2),
        );
        settings = next;
      });
    return settingsQueue.then(() => next);
  });
  handle('essay:clipboard', async (command: string, text: unknown) => {
    if (command === 'paste') return clipboard.readText();
    if ((command === 'cut' || command === 'copy') && typeof text === 'string')
      await clipboard.writeText(text);
    return '';
  });
  handle('essay:recover', async () => {
    // Import the old recovery file once; keep the original file untouched as a backup.
    const session = library.recover();
    if (session) return { session };
    try {
      const text = await readFile(path.join(app.getPath('userData'), 'recovery.essay'), 'utf8');
      const oldEssay = parseEssay(JSON.parse(text));
      if (oldEssay.original || oldEssay.revisions.length) library.save(randomUUID(), oldEssay);
      return { session: library.recover() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { session: null };
      return { session: null, warning: t('recoveryFailed') };
    }
  });
  handle('essay:autosave', (id: string, input: unknown) => library.autosave(id, input));
  handle('essay:confirm-replace', async () => {
    const result = await dialog.showMessageBox(window, {
      type: 'question',
      title: t('unsavedTitle'),
      message: t('unsaved'),
      detail: t('unsavedDetail'),
      buttons: [t('save'), t('discard'), t('cancel')],
      defaultId: 0,
      cancelId: 2,
    });
    return ['save', 'discard', 'cancel'][result.response];
  });
  ipcMain.on('essay:close-ready', (event) => {
    if (event.sender === window.webContents) {
      closeAllowed = true;
      window.close();
    }
  });
}

if (hasInstanceLock)
  app.whenReady().then(async () => {
    try {
      settings = parseSettings(
        JSON.parse(await readFile(path.join(app.getPath('userData'), 'settings.json'), 'utf8')),
      );
    } catch {
      settings = { ...defaultSettings };
    }
    try {
      await mkdir(app.getPath('userData'), { recursive: true });
      library = new EssayLibrary(path.join(app.getPath('userData'), 'library.sqlite'));
    } catch (error) {
      dialog.showErrorBox(t('libraryUnavailable'), String(error));
      app.quit();
      return;
    }
    Menu.setApplicationMenu(null);
    window = new BrowserWindow({
      width: 1180,
      height: 850,
      minWidth: 500,
      minHeight: 360,
      title: 'editrace',
      icon: path.join(__dirname, '../assets/icon.png'),
      backgroundColor: '#ffffff',
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    window.webContents.on('render-process-gone', () => {
      closeAllowed = true;
    });
    registerHandlers();
    window.on('close', (event) => {
      if (!closeAllowed && !window.webContents.isDestroyed()) {
        event.preventDefault();
        window.webContents.send('essay:close-request');
      }
    });
    window.once('ready-to-show', () => window.show());
    await window.loadFile(path.join(__dirname, 'index.html'));
  });
app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => library?.close());
