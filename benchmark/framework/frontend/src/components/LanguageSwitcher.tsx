import { useTranslation } from "react-i18next";
import { appLocale, changeAppLocale, type AppLocale } from "../i18n";

interface Props {
  collapsed: boolean;
}

const LOCALES: AppLocale[] = ["zh", "en"];

export default function LanguageSwitcher({ collapsed }: Props) {
  const { t, i18n } = useTranslation();
  const current = appLocale(i18n.resolvedLanguage ?? i18n.language);

  const switchTo = (locale: AppLocale) => {
    if (locale !== current) void changeAppLocale(locale);
  };

  if (collapsed) {
    const target: AppLocale = current === "zh" ? "en" : "zh";
    const title = t("common.language.switchTo", {
      language: t(`common.language.names.${target}`),
    });
    return (
      <button
        type="button"
        className="language-toggle"
        title={title}
        aria-label={title}
        onClick={() => switchTo(target)}
      >
        {t(`common.language.compact.${target}`)}
      </button>
    );
  }

  return (
    <div className="language-switcher" role="group" aria-label={t("common.language.label")}>
      {LOCALES.map((locale) => (
        <button
          key={locale}
          type="button"
          className={locale === current ? "on" : ""}
          aria-pressed={locale === current}
          onClick={() => switchTo(locale)}
        >
          {t(`common.language.options.${locale}`)}
        </button>
      ))}
    </div>
  );
}
