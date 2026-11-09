import { useEffect } from "react";
import { App as AntdApp, ConfigProvider, theme } from "antd";
import enUS from "antd/es/locale/en_US";
import zhCN from "antd/es/locale/zh_CN";
import { useTranslation } from "react-i18next";
import App from "./App";
import { appLocale, documentLanguage } from "./i18n";

const APP_THEME = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: "#145e4b",
    colorPrimaryHover: "#1c7a62",
    colorLink: "#145e4b",
    colorLinkHover: "#1c7a62",
    borderRadius: 6,
    borderRadiusLG: 9,
    fontFamily: '"Hanken Grotesk", system-ui, sans-serif',
    colorText: "#1d2421",
    colorTextSecondary: "#515a54",
    colorTextTertiary: "#8c918a",
    colorTextDescription: "#8c918a",
    colorBgContainer: "#ffffff",
    colorBgLayout: "#f4f2ec",
    colorBgElevated: "#fbfaf6",
    colorBorder: "#c9c5b6",
    colorBorderSecondary: "#e0ddd2",
    controlHeight: 34,
    controlOutline: "rgba(20,94,75,.13)",
    controlOutlineWidth: 3,
    colorError: "#a51f2d",
    colorSuccess: "#14654f",
    colorWarning: "#b4530d",
  },
  components: {
    Select: {
      optionSelectedBg: "#e3efe9",
      optionSelectedColor: "#145e4b",
      controlItemBgActive: "#eef5f1",
    },
    Input: { activeBorderColor: "#145e4b", hoverBorderColor: "#1c7a62" },
    InputNumber: { activeBorderColor: "#145e4b", hoverBorderColor: "#1c7a62" },
    Modal: { contentBg: "#fbfaf6", headerBg: "#fbfaf6" },
  },
} as const;

const ANTD_LOCALES = {
  en: enUS,
  zh: zhCN,
} as const;

export default function AppProviders() {
  const { i18n } = useTranslation();
  const locale = appLocale(i18n.resolvedLanguage ?? i18n.language);

  useEffect(() => {
    document.documentElement.lang = documentLanguage(locale);
  }, [locale]);

  return (
    <ConfigProvider
      locale={ANTD_LOCALES[locale]}
      theme={APP_THEME}
    >
      <AntdApp>
        <App />
      </AntdApp>
    </ConfigProvider>
  );
}
