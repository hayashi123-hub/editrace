# editrace

A lightweight Windows editor for reviewing your foreign-language writing. Works offline, with no account required.

- Track corrections: deleted text stays red and crossed out; new text appears green.
- Save essays to a local library and recover unfinished work after restarting.
- Import TXT and `.essay` files. Export original or revised text, HTML with corrections, or `.essay` files for continued editing.

## How to use

1. Open `editrace.exe`. Keep it with the other files in the folder.
2. Type or paste your essay, or choose **File → Import file**.
3. Click **Start review**. Type to add text, or select text and type to replace it. Click **Stop review** to return to normal editing.
4. Press **Ctrl+S** to save to your local library. Select a saved essay in the sidebar to open it.
5. Use **File** to rename or export an essay, and **Settings** to change the language or correction style.

## Download

Download the Windows app from [GitHub Releases](https://github.com/hayashi123-hub/editrace/releases). Extract the archive and open `editrace.exe`, keeping all files in the same folder.

## Build from source

On Windows, install Node.js 24 or later and Git, then run:

```powershell
git clone https://github.com/hayashi123-hub/editrace.git
cd editrace
npm ci
npm run package
```

The app is generated in `release/<version>/editrace-win32-x64/`. Open `editrace.exe` inside that folder. Keep the entire folder when moving or sharing the app.

Your essays would be stored under:

```
%APPDATA%\essay-editor\library.sqlite
```

