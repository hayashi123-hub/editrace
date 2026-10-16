export const languages = ['zh-CN', 'en', 'de', 'fr', 'es', 'ja'] as const;
export type Language = (typeof languages)[number];
export interface AppSettings {
  language: Language;
  addedBold: boolean;
  addedItalic: boolean;
}
export const defaultSettings: AppSettings = {
  language: 'en',
  addedBold: true,
  addedItalic: false,
};

export function parseSettings(input: unknown): AppSettings {
  const value = input && typeof input === 'object' ? (input as Partial<AppSettings>) : {};
  return {
    language: languages.includes(value.language as Language)
      ? value.language!
      : defaultSettings.language,
    addedBold: typeof value.addedBold === 'boolean' ? value.addedBold : defaultSettings.addedBold,
    addedItalic:
      typeof value.addedItalic === 'boolean' ? value.addedItalic : defaultSettings.addedItalic,
  };
}
