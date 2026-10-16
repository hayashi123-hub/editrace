import type { Essay } from './model';
import type { AppSettings } from './settings';
import type { EssaySummary, Recovery } from './library';

export type OpenResult =
  | { kind: 'essay'; essay: Essay; name: string }
  | { kind: 'txt'; bytes: number[]; name: string }
  | null;

export interface DesktopApi {
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<AppSettings>;
  open(): Promise<OpenResult>;
  save(id: string, essay: Essay): Promise<Essay>;
  listEssays(): Promise<EssaySummary[]>;
  loadEssay(id: string): Promise<Essay>;
  export(essay: Essay, kind: 'original' | 'final' | 'html' | 'essay'): Promise<string | null>;
  recover(): Promise<{ session: Recovery | null; warning?: string }>;
  autosave(id: string, essay: Essay): Promise<void>;
  confirmReplace(): Promise<'save' | 'discard' | 'cancel'>;
  clipboard(command: 'cut' | 'copy' | 'paste', text?: string): Promise<string>;
  onClose(callback: () => void): void;
  closeReady(): void;
}

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}
