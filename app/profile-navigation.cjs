'use strict';

const MAX_NAVIGATION_ENTRIES = 64;

function navigationUrl(value) {
  if (value === 'about:blank') return value;
  if (typeof value !== 'string' || Buffer.byteLength(value) > 16384 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function captureNavigation(contents, currentUrl) {
  const history = contents.navigationHistory;
  if (!history) return null;
  const entries = history.getAllEntries();
  const activeIndex = history.getActiveIndex();
  if (entries.length < 2 || entries[activeIndex]?.url !== currentUrl) return null;
  const start = Math.max(0, Math.min(activeIndex - Math.floor(MAX_NAVIGATION_ENTRIES / 2), entries.length - MAX_NAVIGATION_ENTRIES));
  const result = [];
  let index;
  for (const [offset, entry] of entries.slice(start, start + MAX_NAVIGATION_ENTRIES).entries()) {
    const url = navigationUrl(entry.url);
    if (!url || url === 'about:blank' && start + offset !== activeIndex) continue;
    if (start + offset === activeIndex) index = result.length;
    // Chromium pageState is opaque and may include form entries or local file paths.
    result.push({ url, title: String(entry.title || '').toWellFormed().replaceAll('\0', '').slice(0, 1024).toWellFormed() });
  }
  if (index === undefined || result.length < 2) return null;
  return { index, entries: result };
}

module.exports = { captureNavigation, MAX_NAVIGATION_ENTRIES };
