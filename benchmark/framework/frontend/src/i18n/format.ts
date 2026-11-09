import type { AppLocale } from "./index";

const DATE_TIME_LOCALES: Record<AppLocale, string> = {
  zh: "zh-CN",
  en: "en-US",
};

const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
};

export function formatDateTime(value: Date, locale: AppLocale): string {
  return new Intl.DateTimeFormat(DATE_TIME_LOCALES[locale], DATE_TIME_OPTIONS).format(value);
}
