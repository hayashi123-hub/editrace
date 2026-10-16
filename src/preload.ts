import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from './api';

const api: DesktopApi = {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  open: () => ipcRenderer.invoke('essay:open'),
  save: (id, essay) => ipcRenderer.invoke('essay:save', id, essay),
  listEssays: () => ipcRenderer.invoke('library:list'),
  loadEssay: (id) => ipcRenderer.invoke('library:load', id),
  renameEssay: (id, title) => ipcRenderer.invoke('library:rename', id, title),
  deleteEssay: (id) => ipcRenderer.invoke('library:delete', id),
  confirmDelete: (title) => ipcRenderer.invoke('library:confirm-delete', title),
  essayMenu: () => ipcRenderer.invoke('library:menu'),
  export: (essay, kind) => ipcRenderer.invoke('essay:export', essay, kind),
  recover: () => ipcRenderer.invoke('essay:recover'),
  autosave: (id, essay) => ipcRenderer.invoke('essay:autosave', id, essay),
  confirmReplace: () => ipcRenderer.invoke('essay:confirm-replace'),
  clipboard: (command, text) => ipcRenderer.invoke('essay:clipboard', command, text),
  onClose: (callback) => {
    ipcRenderer.on('essay:close-request', () => callback());
  },
  closeReady: () => ipcRenderer.send('essay:close-ready'),
};
contextBridge.exposeInMainWorld('desktop', api);
