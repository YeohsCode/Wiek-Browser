'use strict';

(function initialize(root) {
  const messages = typeof module === 'object' && module.exports
    ? require('./i18n-zh.js')
    : root.WiekChineseMessages;
  function resolveLocale(preference, systemLocale) {
    if (preference === 'zh-CN' || preference === 'en') return preference;
    return /^zh(?:[-_]|$)/i.test(systemLocale || '') ? 'zh-CN' : 'en';
  }
  function translate(locale, message, ...values) {
    const template = locale === 'zh-CN' && Object.hasOwn(messages, message) ? messages[message] : message;
    return values.length ? template.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match) : template;
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { resolveLocale, translate };
    return;
  }

  let locale = 'en';
  const originals = new WeakMap();
  let composingElement;
  let deferredRenders = new Set();
  document.addEventListener('compositionstart', event => {
    composingElement = event.target;
  }, true);
  document.addEventListener('compositionend', () => {
    composingElement = null;
    const callbacks = deferredRenders;
    deferredRenders = new Set();
    // Finish the input event that commits the IME candidate before drawing again.
    if (callbacks.size) setTimeout(() => { for (const render of callbacks) render(); }, 0);
  }, true);
  function deferWhileComposing(container, render) {
    if (!composingElement?.isConnected || !container?.contains(composingElement)) return false;
    deferredRenders.add(render);
    return true;
  }
  const t = (message, ...values) => translate(locale, message, ...values);
  function setLocale(next) {
    const selected = resolveLocale(next);
    if (locale === selected) return false;
    locale = selected;
    document.documentElement.lang = locale;
    for (const element of document.querySelectorAll('[data-i18n], [data-i18n-attrs]')) {
      let original = originals.get(element);
      if (!original) {
        const attributes = (element.dataset.i18nAttrs || '').split(' ').filter(Boolean);
        original = {
          text: element.hasAttribute('data-i18n') ? element.textContent : null,
          attributes: attributes.map(name => [name, element.getAttribute(name)])
        };
        originals.set(element, original);
      }
      if (original.text !== null) element.textContent = t(original.text);
      for (const [name, value] of original.attributes) element.setAttribute(name, t(value));
    }
    return true;
  }
  function error(message) {
    if (locale !== 'zh-CN' || typeof message !== 'string') return message;
    const detail = message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
    return t(detail);
  }
  root.WiekI18n = { t, setLocale, error, deferWhileComposing, locale: () => locale };
})(globalThis);
