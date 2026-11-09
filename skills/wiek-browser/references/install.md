# Install or update Wiek Browser

From the Wiek checkout, run `node cli/wiek-browser.mjs install` to register the command and Skill. The application package also includes `cli/wiek-browser.mjs`; its install command uses that package as the runtime root. Ensure `~/.local/bin` is on PATH.

Build a local macOS ARM64 application with `npm ci`, `npm --prefix packages/sdk ci --ignore-scripts`, `npm run build:sdk`, `npm run build:desktop-native`, and `npm run dist`. Optional speech models are restored with `node tools/fetch-speech-model.mjs`.

`wiek-browser upgrade` describes the explicit build/update process. It never downloads a different browser or runs an automatic installer. After rebuilding, run `wiek-browser skill` again.
