# Install Wiek Browser

Use the Wiek repository and its [current build instructions](../../../README.md). From a checkout: `npm ci`, `npm --prefix packages/sdk ci --ignore-scripts`, `npm run build:sdk`, then `npm start`. The canonical CLI is `node cli/wiek-browser.mjs`; the old `vek-browser` entry is a compatibility alias.

This project does not provide an automatic updater or a signed public installer yet. Build the macOS application with `npm run dist`; restore the pinned optional speech model with `node tools/fetch-speech-model.mjs` before building a speech-enabled package. Do not download Ego as a replacement for Wiek.
