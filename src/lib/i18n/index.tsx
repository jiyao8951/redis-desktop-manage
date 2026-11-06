import { createContext, useContext, useMemo, type ReactNode } from "react";

import { en, type MessageKey, type Messages } from "./en";
import { zhCN } from "./zh-CN";

export type Language = "en" | "zh-CN";
export type { MessageKey };

export const LANGUAGES: Language[] = ["en", "zh-CN"];

const DICTIONARIES: Record<Language, Messages> = { en, "zh-CN": zhCN };

export type TranslateParams = Record<string, string | number>;
export type TFunction = (key: MessageKey, params?: TranslateParams) => string;

/**
 * Picks the UI language from the OS locale. Unknown languages fall back to
 * English, as required for this build.
 */
export function detectLanguage(): Language {
  const tags =
    typeof navigator === "undefined" ? [] : (navigator.languages ?? [navigator.language]);
  for (const tag of tags) {
    const lower = String(tag).toLowerCase();
    if (lower.startsWith("zh")) return "zh-CN";
    if (lower.startsWith("en")) return "en";
  }
  return "en";
}

/** Resolves the persisted `settings.language`; "" means "not chosen yet". */
export function resolveLanguage(stored: string): Language {
  if (stored === "en" || stored === "zh-CN") return stored;
  return detectLanguage();
}

export function translate(language: Language, key: MessageKey, params?: TranslateParams): string {
  const template = DICTIONARIES[language][key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

interface I18nContextValue {
  language: Language;
  t: TFunction;
}

const I18nContext = createContext<I18nContextValue>({
  language: "en",
  t: (key, params) => translate("en", key, params),
});

export function I18nProvider({ language, children }: { language: Language; children: ReactNode }) {
  const value = useMemo<I18nContextValue>(
    () => ({ language, t: (key, params) => translate(language, key, params) }),
    [language],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useLanguage(): Language {
  return useContext(I18nContext).language;
}

export function useT(): TFunction {
  return useContext(I18nContext).t;
}

/** Backend value-table column identifiers mapped to translated headers. */
const COLUMN_KEYS: Record<string, MessageKey> = {
  rowNumber: "value.column.number",
  key: "value.column.key",
  member: "value.column.member",
  id: "value.column.id",
  value: "value.column.value",
  score: "value.column.score",
};

/** Localizes known column identifiers; unknown ones are shown as-is. */
export function localizedColumn(t: TFunction, name: string): string {
  const key = COLUMN_KEYS[name];
  return key ? t(key) : name;
}

/** Language names shown in the settings dialog. */
export const LANGUAGE_LABELS: Record<Language, string> = {
  en: "English",
  "zh-CN": "简体中文",
};
