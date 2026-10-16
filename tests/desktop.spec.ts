import { test, expect, _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function launch(profile: string): Promise<{ app: ElectronApplication; page: Page }> {
  await mkdir(profile, { recursive: true });
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    ESSAY_EDITOR_TEST_DATA: profile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.ESSAY_EDITOR_EXECUTABLE;
  const app = await electron.launch({ args: executablePath ? [] : ['.'], executablePath, env });
  const page = await app.firstWindow();
  await page.waitForSelector('body[data-ready="true"]');
  return { app, page };
}

async function select(page: Page, from: number, to = from) {
  await page.locator('#editor').focus();
  await page.evaluate(
    ({ from, to }) => {
      const root = document.getElementById('editor')!;
      const spans = [
        ...root.querySelectorAll<HTMLElement>('[data-kind="original"], [data-kind="added"]'),
      ];
      function point(offset: number): [Node, number] {
        const span =
          spans.find(
            (span) =>
              span.dataset.kind === 'added' &&
              Number(span.dataset.from) <= offset &&
              Number(span.dataset.to) >= offset,
          ) ??
          spans.find(
            (span) => Number(span.dataset.from) <= offset && Number(span.dataset.to) >= offset,
          );
        return span?.firstChild
          ? [span.firstChild, offset - Number(span.dataset.from)]
          : [root, Math.max(0, root.childNodes.length - 1)];
      }
      const range = document.createRange();
      range.setStart(...point(from));
      range.setEnd(...point(to));
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    },
    { from, to },
  );
}
async function clean(page: Page) {
  return page
    .locator('#editor')
    .evaluate((root) =>
      [...root.querySelectorAll('[data-kind="original"], [data-kind="added"]')]
        .map((node) => node.textContent)
        .join(''),
    );
}
async function expectText(page: Page, value: string) {
  await expect.poll(() => clean(page)).toBe(value);
}
async function menu(page: Page, label: string, action: string) {
  await page.getByRole('menuitem', { name: label, exact: true }).hover();
  await page.locator(`[data-action="${action}"]`).click();
}
async function draft(page: Page, text: string) {
  await page.locator('#editor').focus();
  await page.keyboard.insertText(text);
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('#editor')).toHaveAttribute('data-stage', 'review');
}
async function saveDialog(app: ElectronApplication, filePath: string) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath,
    })) as typeof dialog.showSaveDialog;
  }, filePath);
}

test('review toggle restores normal editing and bottom bar tracks the revised text', async ({}, info) => {
  const { app, page } = await launch(info.outputPath('profile'));
  try {
    await expect(page.locator('#review-toggle')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#editor').focus();
    await page.keyboard.type('I go home.');
    await expect(page.locator('[data-kind="added"]')).toHaveCount(0);
    await page.locator('#review-toggle').click();
    await select(page, 2, 4);
    await page.keyboard.type('went');
    await expect(page.locator('[data-kind="deleted"]')).toHaveText('go');
    await expect(page.locator('#word-count')).toHaveText('3 words');
    await page.locator('#review-toggle').click();
    await expect(page.locator('#review-toggle')).toHaveAttribute('aria-pressed', 'false');
    await select(page, 0);
    await page.keyboard.type('Yesterday ');
    await expectText(page, 'Yesterday I went home.');
    await expect(page.locator('[data-kind="added"]')).toHaveText('went');
    await expect(page.locator('[data-kind="deleted"]')).toHaveText('go');
    await select(page, 17, 21);
    await page.keyboard.type('away');
    await expectText(page, 'Yesterday I went away.');
    await expect(page.locator('[data-kind="deleted"]')).toHaveText('go');
    await expect(page.locator('#word-count')).toHaveText('4 words');
    await page.keyboard.press('Control+z');
    await expectText(page, 'Yesterday I went home.');
    await page.locator('#review-toggle').click();
    await select(page, 22);
    await page.keyboard.type(' Again.');
    await expectText(page, 'Yesterday I went home. Again.');
    await expect(page.locator('[data-kind="added"]').last()).toHaveText(' Again.');
    await expect(page.locator('#sidebar')).toBeVisible();
    await expect(page.locator('.essay-item')).toHaveCount(0);
    await expect(page.locator('#sidebar-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expectText(page, 'Yesterday I went home. Again.');
    await page.screenshot({ path: info.outputPath('editor-sidebar.png') });
    await page.locator('#sidebar-toggle').click();
    await expect(page.locator('#sidebar')).toBeHidden();
    await expect(page.locator('.menu-trigger')).toHaveText(['File', 'Edit', 'Settings']);
    await expect(page.locator('.menubar > .menu')).toHaveCount(3);
  } finally {
    await app.close();
  }
});

test('six languages and text styles apply immediately, persist and reach HTML export', async ({}, info) => {
  const profile = info.outputPath('profile');
  let { app, page } = await launch(profile);
  try {
    await draft(page, 'I go home.');
    await select(page, 2, 4);
    await page.keyboard.type('went');
    await expect(page.locator('[data-kind="added"]')).toHaveCSS('font-weight', '600');
    await menu(page, 'Settings', 'settings');
    const languages = ['zh-CN', 'en', 'de', 'fr', 'es', 'ja'];
    const files = ['文件', 'File', 'Datei', 'Fichier', 'Archivo', 'ファイル'];
    for (let i = 0; i < languages.length; i++) {
      await page.locator('#language-select').selectOption(languages[i]);
      await expect(page.locator('html')).toHaveAttribute('lang', languages[i]);
      await expect(page.locator('[data-i18n="file"]')).toHaveText(files[i]);
    }
    await page.locator('#language-select').selectOption('en');
    await page.locator('#added-bold').uncheck();
    await page.locator('#added-italic').check();
    await expect(page.locator('#style-preview')).toHaveCSS('font-weight', '400');
    await expect(page.locator('#style-preview')).toHaveCSS('font-style', 'italic');
    await page.screenshot({ path: info.outputPath('settings.png') });
    await page.locator('#settings-close').click();
    await expect(page.locator('[data-kind="added"]')).toHaveCSS('font-weight', '400');
    await expect(page.locator('[data-kind="added"]')).toHaveCSS('font-style', 'italic');
    await expect(page.locator('#word-count')).toHaveText('3 words');
    const exported = info.outputPath('styled.html');
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (async (_window: unknown, options: { title: string }) => {
        if (options.title !== 'Export — Text with revisions')
          throw new Error('Native dialog was not translated');
        return { canceled: false, filePath };
      }) as typeof dialog.showSaveDialog;
    }, exported);
    await menu(page, 'File', 'export-html');
    await expect
      .poll(async () => {
        try {
          return await readFile(exported, 'utf8');
        } catch {
          return '';
        }
      })
      .toContain('font-weight:400');
    expect(await readFile(exported, 'utf8')).toContain('font-style:italic');
    await app.close();
    ({ app, page } = await launch(profile));
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('#review-toggle')).toHaveText('Start review');
    await expect(page.locator('[data-kind="added"]')).toHaveCSS('font-style', 'italic');
    await page.keyboard.press('Control+,');
    await expect(page.locator('#settings-dialog')).toBeVisible();
    await expect(page.locator('#added-bold')).not.toBeChecked();
    await expect(page.locator('#added-italic')).toBeChecked();
    await page.locator('#language-select').selectOption('de');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(560, 440));
    await expect(page.locator('#settings-close')).toBeInViewport();
    await page.locator('#settings-close').click();
    await expect(page.locator('#review-toggle')).toBeInViewport();
    await expect(page.locator('#word-count')).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await app.close();
  }
});

test('direct replacement, green editing, additions, deletion and grouped undo', async ({}, info) => {
  const { app, page } = await launch(info.outputPath('profile'));
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await draft(page, 'I go to school yesterday.');
    await select(page, 2, 4);
    await page.keyboard.type('went');
    await expectText(page, 'I went to school yesterday.');
    await expect(page.locator('[data-kind="deleted"]')).toHaveText('go');
    await expect(page.locator('[data-kind="added"]')).toHaveText('went');
    await page.keyboard.press('Control+z');
    await expectText(page, 'I go to school yesterday.');
    await expect(page.locator('[data-kind="deleted"]')).toHaveCount(0);
    await page.keyboard.press('Control+Shift+z');
    await expectText(page, 'I went to school yesterday.');

    await select(page, 2, 6);
    await page.keyboard.type('walked');
    await expectText(page, 'I walked to school yesterday.');
    await expect(page.locator('[data-kind="deleted"]')).toHaveText('go');
    await select(page, 29);
    await page.keyboard.press('Enter');
    await page.keyboard.type('I will try again.');
    await expectText(page, 'I walked to school yesterday.\nI will try again.');
    await page.keyboard.press('Backspace');
    await expectText(page, 'I walked to school yesterday.\nI will try again');
    await select(page, 12, 18);
    await page.keyboard.press('Backspace');
    await expectText(page, 'I walked to  yesterday.\nI will try again');
    await expect(page.locator('[data-kind="deleted"]').last()).toHaveText('school');
    await page.keyboard.press('Control+z');
    await expectText(page, 'I walked to school yesterday.\nI will try again');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('mouse word selection preserves spaces and hover menus keep the selection', async ({}, info) => {
  const { app, page } = await launch(info.outputPath('profile'));
  try {
    await draft(page, 'I go home.\n\nPractice makes progress.');
    const word = await page.evaluate(() => {
      const node = document.querySelector('#editor [data-kind="original"]')!.firstChild!;
      const range = document.createRange();
      range.setStart(node, 2);
      range.setEnd(node, 4);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    });
    await page.mouse.dblclick(word.x, word.y);
    await page.keyboard.type('went');
    await expectText(page, 'I went home.\n\nPractice makes progress.');
    await select(page, 14);
    await page.keyboard.type('Daily ');
    await expectText(page, 'I went home.\n\nDaily Practice makes progress.');
    await menu(page, 'Edit', 'undo');
    await expectText(page, 'I went home.\n\nPractice makes progress.');
    await menu(page, 'Edit', 'redo');
    await expectText(page, 'I went home.\n\nDaily Practice makes progress.');
    await menu(page, 'File', 'rename');
    await page.locator('#title-input').fill('Daily practice');
    await page.locator('#title-input').press('Enter');
    await expect(page).toHaveTitle(/Daily practice/);
    await page.mouse.move(440, 100);
    await page.screenshot({ path: info.outputPath('minimal-editor.png') });
    await expect(page.locator('body')).not.toContainText('原文已保留');
    await expect(page.locator('.paper, .brand, #insert-button, #replace-button')).toHaveCount(0);
    expect(await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      'rgba(0, 0, 0, 0)',
    );
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(560, 440));
    await expect(page.getByRole('menuitem', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.locator('.status-bar')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  } finally {
    await app.close();
  }
});

test('plain paste, multiline replacement and edits spanning earlier changes', async ({}, info) => {
  const { app, page } = await launch(info.outputPath('profile'));
  try {
    await draft(page, 'First line.\nSecond line.');
    await select(page, 0, 5);
    await page.keyboard.type('Opening');
    await select(page, 0, 20);
    await page.keyboard.insertText('New\nsecond');
    await expectText(page, 'New\nsecond line.');
    await select(page, 16);
    await page.locator('#editor').evaluate((el) => {
      const clipboard = new DataTransfer();
      clipboard.setData('text/plain', '\n<b>plain</b>');
      clipboard.setData('text/html', '<b>rich</b>');
      el.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }),
      );
    });
    await expectText(page, 'New\nsecond line.\n<b>plain</b>');
    await expect(page.locator('#editor b')).toHaveCount(0);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await expectText(page, '');
    await page.keyboard.type('Start again.');
    await expectText(page, 'Start again.');
    await expect(page.locator('[data-kind="added"]')).toHaveText('Start again.');
  } finally {
    await app.close();
  }
});

test('IME composition commits once for replacement and insertion', async ({}, info) => {
  const { app, page } = await launch(info.outputPath('profile'));
  try {
    await draft(page, 'Hello world.');
    await select(page, 6, 11);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'shi', selectionStart: 3, selectionEnd: 3 });
    await cdp.send('Input.imeSetComposition', { text: '世界', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '世界' });
    await expectText(page, 'Hello 世界.');
    await expect(page.locator('[data-kind="deleted"]')).toHaveText('world');
    await expect(page.locator('[data-kind="added"]')).toHaveText('世界');
    await select(page, 9);
    await cdp.send('Input.imeSetComposition', { text: '你好', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '你好' });
    await expectText(page, 'Hello 世界.你好');
    await page.keyboard.press('Control+z');
    await expectText(page, 'Hello 世界.');
    await select(page, 6, 8);
    await cdp.send('Input.imeSetComposition', { text: '朋友', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '朋友' });
    await expectText(page, 'Hello 朋友.');
    await expect(page.locator('[data-kind="deleted"]')).toHaveText('world');
    await select(page, 9);
    await cdp.send('Input.imeSetComposition', {
      text: 'cancel',
      selectionStart: 6,
      selectionEnd: 6,
    });
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await expectText(page, 'Hello 朋友.');
    await cdp.detach();
  } finally {
    await app.close();
  }
});

test('backspace preserves Unicode characters and trailing newlines remain editable', async ({}, info) => {
  const { app, page } = await launch(info.outputPath('profile'));
  try {
    await draft(page, 'A 🌍\nB');
    await select(page, 4);
    await page.keyboard.press('Backspace');
    await expectText(page, 'A \nB');
    await expect(page.locator('[data-kind="deleted"]')).toHaveText('🌍');
    await page.keyboard.press('Control+z');
    await expectText(page, 'A 🌍\nB');
    await select(page, 6);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('tail');
    await expectText(page, 'A 🌍\nB\n\ntail');
    await page.keyboard.press('Control+Backspace');
    await expectText(page, 'A 🌍\nB\n\n');
    await page.keyboard.type('again');
    await expectText(page, 'A 🌍\nB\n\nagain');
  } finally {
    await app.close();
  }
});

test('save, export, restart recovery and compatibility with existing essay files', async ({}, info) => {
  const root = info.outputPath('files');
  await mkdir(root, { recursive: true });
  const profile = path.join(root, 'profile');
  let { app, page } = await launch(profile);
  try {
    await draft(page, 'I go home.');
    await select(page, 2, 4);
    await page.keyboard.type('went');
    await select(page, 12);
    await page.keyboard.type('\nTomorrow too.');
    await app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (async () => {
        throw new Error('Ctrl+S must not open a path picker');
      }) as typeof dialog.showSaveDialog;
    });
    await menu(page, 'File', 'save');
    await expect(page.locator('.essay-item')).toHaveCount(1);
    const saved = path.join(root, 'practice.essay');
    await saveDialog(app, saved);
    await menu(page, 'File', 'export-essay');
    await expect
      .poll(async () => JSON.parse(await readFile(saved, 'utf8')).revisions.length)
      .toBe(2);
    for (const kind of ['original', 'final', 'html'] as const) {
      const file = path.join(root, `${kind}.${kind === 'html' ? 'html' : 'txt'}`);
      await saveDialog(app, file);
      await menu(page, 'File', `export-${kind}`);
      await expect
        .poll(async () => {
          try {
            return await readFile(file, 'utf8');
          } catch {
            return '';
          }
        })
        .not.toBe('');
      const content = await readFile(file, 'utf8');
      if (kind === 'original') expect(content).toBe('I go home.');
      if (kind === 'final') expect(content).toBe('I went home.\nTomorrow too.');
      if (kind === 'html') {
        expect(content).toContain('<del>go</del><ins>went</ins>');
        expect(content).not.toContain('红色删除线：');
      }
    }
    await app.close();
    ({ app, page } = await launch(profile));
    await expectText(page, 'I went home.\nTomorrow too.');
    await expect(page.locator('#review-toggle')).toHaveAttribute('aria-pressed', 'false');
    await app.evaluate(({ dialog }, saved) => {
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [saved],
      })) as typeof dialog.showOpenDialog;
    }, saved);
    await menu(page, 'File', 'open');
    await expectText(page, 'I went home.\nTomorrow too.');
    await expect(page.locator('#review-toggle')).toHaveAttribute('aria-pressed', 'false');
    await page.locator('#review-toggle').click();
    await select(page, 2, 6);
    await page.keyboard.type('walked');
    await expectText(page, 'I walked home.\nTomorrow too.');
    await page.keyboard.press('Control+s');
    await expect(page.locator('.essay-item')).toHaveCount(2);
    // Importing creates a library copy; the source file remains untouched.
    expect(JSON.parse(await readFile(saved, 'utf8')).revisions[0].text).toBe('went');
  } finally {
    await app.close();
  }
});

test('local library saves without dialogs, switches safely and updates the same essay after restart', async ({}, info) => {
  const profile = info.outputPath('profile');
  let { app, page } = await launch(profile);
  const noSaveDialog = async () =>
    app.evaluate(({ dialog }) => {
      dialog.showSaveDialog = (async () => {
        throw new Error('Unexpected path picker');
      }) as typeof dialog.showSaveDialog;
    });
  const decide = async (response: number) =>
    app.evaluate(({ dialog }, response) => {
      dialog.showMessageBox = (async () => ({
        response,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
    }, response);
  const item = (title: string) =>
    page.locator('.essay-item').filter({ has: page.locator('.essay-title', { hasText: title }) });
  try {
    await noSaveDialog();
    await page.locator('#editor').focus();
    await page.keyboard.insertText('Alpha essay.');
    await page.keyboard.press('Control+s');
    await expect(page.locator('.essay-title')).toHaveText(['Alpha essay.']);
    await page.keyboard.press('Control+s');
    await expect(page.locator('.essay-item')).toHaveCount(1);
    await menu(page, 'File', 'rename');
    await page.locator('#title-input').fill('My essay');
    await page.locator('#title-input').press('Enter');
    await expect(page.locator('.essay-title')).toHaveText(['My essay']);
    await page.keyboard.press('Control+n');
    await expectText(page, '');
    await page.keyboard.insertText('Beta essay.');
    await page.keyboard.press('Control+s');
    await expect(page.locator('.essay-title')).toHaveText(['Beta essay.', 'My essay']);
    await select(page, 11);
    await page.keyboard.insertText(' Unsaved');
    await decide(2);
    await item('My essay').click();
    await expectText(page, 'Beta essay. Unsaved');
    await decide(1);
    await item('My essay').click();
    await expectText(page, 'Alpha essay.');
    await item('Beta essay.').click();
    await expectText(page, 'Beta essay.');
    await select(page, 11);
    await page.keyboard.insertText(' Saved');
    await decide(0);
    await item('My essay').click();
    await expectText(page, 'Alpha essay.');
    await item('Beta essay.').click();
    await expectText(page, 'Beta essay. Saved');
    await item('My essay').click();
    await select(page, 12);
    await page.keyboard.insertText(' Recovery');
    await app.close();
    ({ app, page } = await launch(profile));
    await noSaveDialog();
    await expectText(page, 'Alpha essay. Recovery');
    await expect(page.locator('.essay-item')).toHaveCount(2);
    await expect(item('My essay')).toHaveAttribute('aria-current', 'true');
    const savedBody = await page.evaluate(async () => {
      const entries = await window.desktop.listEssays();
      return (
        await window.desktop.loadEssay(entries.find((entry) => entry.title === 'My essay')!.id)
      ).original;
    });
    expect(savedBody).toBe('Alpha essay.');
    await page.keyboard.press('Control+s');
    await expect(page).not.toHaveTitle(/ ·/);
    await expect(page.locator('.essay-item')).toHaveCount(2);
    await item('Beta essay.').click();
    await expectText(page, 'Beta essay. Saved');
    await item('My essay').click();
    await expectText(page, 'Alpha essay. Recovery');
    await expect(page.locator('#review-toggle')).toHaveAttribute('aria-pressed', 'false');
    await page.screenshot({ path: info.outputPath('local-library.png') });
    const header = await readFile(path.join(profile, 'library.sqlite'));
    expect(header.subarray(0, 16).toString()).toBe('SQLite format 3\0');
  } finally {
    await app.close();
  }
});

test('legacy recovery migrates once while retaining the original file', async ({}, info) => {
  const profile = info.outputPath('profile');
  await mkdir(profile, { recursive: true });
  const legacy = JSON.stringify({
    format: 'essay-editor',
    version: 1,
    title: 'Old practice',
    original: 'I go home.',
    stage: 'review',
    revisions: [
      { id: 'old-change', type: 'replace', start: 2, end: 4, original: 'go', text: 'went' },
    ],
  });
  await writeFile(path.join(profile, 'recovery.essay'), legacy);
  let { app, page } = await launch(profile);
  try {
    await expectText(page, 'I went home.');
    await expect(page.locator('.essay-title')).toHaveText(['Old practice']);
    await expect(page.locator('[data-kind="deleted"]')).toHaveText('go');
    await page.keyboard.press('Control+s');
    await expect(page).not.toHaveTitle(/ ·/);
    await app.close();
    ({ app, page } = await launch(profile));
    await expect(page.locator('.essay-item')).toHaveCount(1);
    await expectText(page, 'I went home.');
    expect(await readFile(path.join(profile, 'recovery.essay'), 'utf8')).toBe(legacy);
  } finally {
    await app.close();
  }
});

test('clipboard menu commands still edit the document', async ({}, info) => {
  const { app, page } = await launch(info.outputPath('profile'));
  try {
    // Use an isolated clipboard: Windows clipboard access is unavailable in some
    // automated sessions, and tests must not replace the user's clipboard.
    await app.evaluate(({ clipboard }) => {
      let text = '';
      clipboard.writeText = async (value: string) => {
        text = value;
      };
      clipboard.readText = async () => text;
    });
    await page.locator('#editor').focus();
    await page.keyboard.insertText('Hello world');
    await select(page, 6, 11);
    await menu(page, 'Edit', 'cut');
    await expectText(page, 'Hello ');
    expect(
      await app.evaluate(async ({ clipboard }) => (await clipboard.readText()) === 'world'),
    ).toBe(true);
    await menu(page, 'Edit', 'paste');
    await expectText(page, 'Hello world');
    await page.keyboard.press('Control+s');
    await expect(page.locator('.essay-title')).toHaveText(['Hello world']);
  } finally {
    await app.close();
  }
});

test('TXT encoding preview and button-based review start', async ({}, info) => {
  const root = info.outputPath('files');
  await mkdir(root, { recursive: true });
  const file = path.join(root, 'legacy.txt');
  await writeFile(file, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a, 0x48, 0x69]));
  const { app, page } = await launch(path.join(root, 'profile'));
  try {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [file],
      })) as typeof dialog.showOpenDialog;
    }, file);
    await menu(page, 'File', 'open');
    await page.locator('#encoding-select').selectOption('windows-1252');
    await expect(page.locator('#import-preview')).toHaveText('café\nHi');
    await page.locator('#import-confirm').click();
    await expectText(page, 'café\nHi');
    await page.locator('#review-toggle').click();
    await select(page, 5, 7);
    await page.keyboard.insertText('你好');
    await expectText(page, 'café\n你好');
    expect(await readFile(file)).toEqual(
      Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0d, 0x0a, 0x48, 0x69]),
    );
  } finally {
    await app.close();
  }
});

async function chooseLibraryAction(app: ElectronApplication, labels: string[]) {
  // Native Electron menus live outside the DOM; choose their real MenuItem callback.
  await app.evaluate(({ Menu }, labels) => {
    const original = Menu.prototype.popup;
    Menu.prototype.popup = function (options) {
      Menu.prototype.popup = original;
      let current: Electron.Menu = this;
      for (const [index, label] of labels.entries()) {
        const item = current.items.find((item) => item.label === label);
        if (!item) throw new Error(`Missing native menu item: ${label}`);
        if (index === labels.length - 1) item.click(item, undefined, {} as Electron.KeyboardEvent);
        else current = item.submenu!;
      }
      options?.callback?.();
    };
  }, labels);
}

test('rename refreshes the sidebar immediately and persists without saving unsaved body edits', async ({}, info) => {
  const profile = info.outputPath('profile');
  let { app, page } = await launch(profile);
  try {
    await page.locator('#editor').focus();
    await page.keyboard.insertText('Saved text');
    await page.keyboard.press('Control+s');
    await expect(page.locator('.essay-title')).toHaveText(['Saved text']);
    await page.keyboard.insertText(' unsaved');
    await menu(page, 'File', 'rename');
    await page.locator('#title-input').fill('New title');
    await page.locator('#title-input').press('Enter');
    await expect(page.locator('.essay-title')).toHaveText(['New title']);
    await expect(page).toHaveTitle('New title · — editrace');
    await expectText(page, 'Saved text unsaved');
    await page.keyboard.press('Control+z');
    await expectText(page, 'Saved text');
    await expect(page).toHaveTitle('New title — editrace');
    await page.keyboard.press('Control+Shift+z');
    await expectText(page, 'Saved text unsaved');
    await app.close();
    ({ app, page } = await launch(profile));
    await expect(page.locator('.essay-title')).toHaveText(['New title']);
    await expectText(page, 'Saved text unsaved');
    await expect(page).toHaveTitle('New title · — editrace');
    const saved = await page.evaluate(async () => {
      const [entry] = await window.desktop.listEssays();
      return window.desktop.loadEssay(entry.id);
    });
    expect(saved.title).toBe('New title');
    expect(saved.original).toBe('Saved text');
  } finally { await app.close(); }
});

test('sidebar context menu targets the clicked essay for rename, export, open and confirmed deletion', async ({}, info) => {
  const profile = info.outputPath('profile');
  let { app, page } = await launch(profile);
  const item = (title: string) => page.locator('.essay-item').filter({ has: page.getByText(title, { exact: true }) });
  try {
    await page.locator('#editor').focus();
    await page.keyboard.insertText('Alpha');
    await page.keyboard.press('Control+s');
    await expect(page.locator('.essay-title')).toHaveText(['Alpha']);
    await page.keyboard.press('Control+n');
    await expectText(page, '');
    await page.keyboard.insertText('Beta');
    await page.keyboard.press('Control+s');
    await expect(page.locator('.essay-title')).toHaveText(['Beta', 'Alpha']);
    await page.keyboard.insertText(' draft');
    await chooseLibraryAction(app, ['Rename…']);
    await item('Alpha').click({ button: 'right' });
    await page.locator('#title-input').fill('Renamed Alpha');
    await page.locator('#title-input').press('Enter');
    await expect(item('Renamed Alpha')).toHaveCount(1);
    await expectText(page, 'Beta draft');
    await expect(page).toHaveTitle('Beta · — editrace');
    const exported = info.outputPath('alpha.essay');
    await saveDialog(app, exported);
    await chooseLibraryAction(app, ['Export', 'Practice file']);
    await item('Renamed Alpha').click({ button: 'right' });
    await expect.poll(async () => {
      try { return JSON.parse(await readFile(exported, 'utf8')).title; } catch { return ''; }
    }).toBe('Renamed Alpha');
    expect(JSON.parse(await readFile(exported, 'utf8')).original).toBe('Alpha');
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 2, checkboxChecked: false });
    });
    await chooseLibraryAction(app, ['Open essay']);
    await item('Renamed Alpha').click({ button: 'right' });
    await expectText(page, 'Beta draft');
    await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false');
    await page.keyboard.press('Control+s');
    await expect(page).toHaveTitle('Beta — editrace');
    await chooseLibraryAction(app, ['Open essay']);
    await item('Renamed Alpha').click({ button: 'right' });
    await expectText(page, 'Alpha');
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await chooseLibraryAction(app, ['Delete essay…']);
    await item('Beta').click({ button: 'right' });
    await expect(item('Beta')).toHaveCount(1);
    await expect(page.locator('body')).toHaveAttribute('aria-busy', 'false');
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await chooseLibraryAction(app, ['Delete essay…']);
    await item('Beta').click({ button: 'right' });
    await expect(item('Beta')).toHaveCount(0);
    await expectText(page, 'Alpha');
    await chooseLibraryAction(app, ['Delete essay…']);
    await item('Renamed Alpha').click({ button: 'right' });
    await expect(page.locator('.essay-item')).toHaveCount(0);
    await expectText(page, '');
    await app.close();
    ({ app, page } = await launch(profile));
    await expect(page.locator('.essay-item')).toHaveCount(0);
    await expectText(page, '');
  } finally { await app.close(); }
});
