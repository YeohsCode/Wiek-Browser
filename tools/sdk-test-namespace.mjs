// Test-only identifier migration. No assertions, timeouts, cases or fixtures
// are removed. Original input bytes remain pinned and separately verified.
export function migrateNamespace(source) {
  return source.replace(/ego lite/gi,'Wiek Browser')
    .replaceAll('Ego','Wiek')
    .replace(/(?<![A-Z])EGO(?=[A-Z_-]|$)/g,'WIEK')
    .replace(/(?<![A-Za-z0-9])ego(?=[^a-z0-9]|$)/g,'wiek');
}
