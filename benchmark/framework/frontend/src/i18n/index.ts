import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { en } from "./messages/en";
import { zh } from "./messages/zh";

export const APP_LOCALES = ["zh", "en"] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

export const DEFAULT_APP_LOCALE: AppLocale = "en";

export const DEFAULT_NAMESPACE = "translation";
export const LOCALE_STORAGE_KEY = "wiek.locale:v1";

export const resources = {
  en: { [DEFAULT_NAMESPACE]: en },
  zh: { [DEFAULT_NAMESPACE]: zh },
} as const;

function storedLocale(): AppLocale | null {
  try {
    const value = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return value === "zh" || value === "en" ? value : null;
  } catch {
    return null;
  }
}

function browserLocale(): AppLocale {
  const languages = navigator.languages?.length ? navigator.languages : [navigator.language];
  return languages.some((language) => language.toLowerCase() === "zh" || language.toLowerCase().startsWith("zh-"))
    ? "zh"
    : DEFAULT_APP_LOCALE;
}

export function resolveInitialLocale(): AppLocale {
  return storedLocale() ?? browserLocale();
}

export function appLocale(language: string | undefined): AppLocale {
  return language?.toLowerCase() === "zh" || language?.toLowerCase().startsWith("zh-") ? "zh" : "en";
}

export function documentLanguage(locale: AppLocale): "zh-CN" | "en" {
  return locale === "zh" ? "zh-CN" : "en";
}

function persistLocale(locale: AppLocale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // The in-memory i18n state remains authoritative for this page session.
  }
}

export async function changeAppLocale(locale: AppLocale): Promise<void> {
  persistLocale(locale);
  await i18n.changeLanguage(locale);
}

const initialLocale = resolveInitialLocale();
document.documentElement.lang = documentLanguage(initialLocale);

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLocale,
  fallbackLng: "en",
  supportedLngs: APP_LOCALES,
  defaultNS: DEFAULT_NAMESPACE,
  returnNull: false,
  interpolation: {
    escapeValue: false,
  },
  react: {
    useSuspense: false,
  },
  initAsync: false,
});

export default i18n;
