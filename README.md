# Wiek Browser

[简体中文](README.zh-CN.md) · English

![Wiek Browser](app/assets/wiek.svg)

A local Chromium browser and agent workspace with task spaces, isolated browser profiles, file/Git tools, scheduled automations, and browser automation. Wiek has an independently implemented Electron host and local services, plus its own standalone SDK build and runtime namespace. No separate browser installation or service is required. Third-party license and copyright details are retained in [NOTICE.md](NOTICE.md).

**Current checkpoint: 0.30.0.** Functional coverage and acceptance are still in progress. See the [plan](PLAN.md), [capability matrix](analysis/implementation-matrix.md), and [validation results](reports/RESULTS.md).

Choose **Settings → Interface language** to follow the system or switch between Simplified Chinese and English. Changes apply immediately and persist across restarts.

## Run locally

```sh
git clone https://github.com/YeohsCode/Wiek-Browser.git
cd Wiek-Browser
npm ci
npm --prefix packages/sdk ci --ignore-scripts
npm run build:sdk
npm run build:desktop-native
npm start
```

The native helpers and the application distribution currently target macOS ARM64. Browser automation and local services do not require a cloud account. Model-backed agent turns require a separately configured provider.

```sh
node cli/wiek-browser.mjs install
node cli/wiek-browser.mjs start
node cli/wiek-browser.mjs skill
node cli/wiek-browser.mjs status
node cli/wiek-browser.mjs stop
```

Use `WIEK_DATA_DIR=/absolute/path` to start an isolated instance. Development data defaults to `data/`; packaged builds use `~/Library/Application Support/Wiek Browser/`. Existing compatible data is reused without automatic movement or deletion. OS-bound encrypted credentials and system permissions require separate migration acceptance.

## Features

- Browser tabs, task spaces, isolated profiles, bookmarks, history, downloads, permissions, and user/agent handoff.
- JavaScript browser SDK with snapshots, locators, input, frames, screenshots, upload/download, and CDP.
- Agent workspace with approvals, attachments, conversation branches, selected native adapters, and model catalogues.
- Scoped files, Git operations, reviewed remote operations, and file checkpoints with linked-worktree isolation.
- **Project local services:** refresh listening processes, open a loopback address, explicitly read its title, review a process stop, and confirm it. Process birth identity, directory, executable and endpoints are rechecked before one termination signal. Discovery does not fetch pages or read process arguments/environment.
- MCP connections over legacy/modern stdio and HTTP, scoped tools/resources, subscriptions, inert prompt previews, reviewed OAuth and bounded input continuations.
- Encrypted profile archives can transfer local/session storage and bounded IndexedDB data from selected tabs, including auto-increment keys, shared references, cycles, sparse arrays, typed-array views, and Blob/File attachments. Older archive formats remain readable.
- Scheduled automations, opt-in background jobs, execution modes, busy deferral, run memory/results, and crash recovery.
- Collections, screenshots and annotation, page/application action history, explicit desktop capture, local transcription, and configurable offline translation.

Project local services require the macOS native helper. Only matching project directories are shown; protected processes and unsupported runtimes cannot be stopped. A process that ignores the signal remains reported as running. No force-stop escalation is performed.

## Browser automation

```sh
node cli/wiek-browser.mjs nodejs <<'JS'
const task = await taskSpace('research');
const page = task.page('p1');
await page.goto('https://example.com');
console.log(await page.snapshot());
JS
```

While the browser stays running, reuse the task ID and page label for the same task. Use unique names and isolated data directories for independent tests. After a browser restart, identify the reopened tabs again. See the [terminology guide](docs/terminology.md), [usability audit](reports/usability-audit.md), and [project tools API](skills/wiek-browser/API.md).

Use `wiek-browser start --no-restore` to start with a blank tab. Saved tabs remain available on the next normal launch, and browser profile data stays available.

## Optional local models

Restore the pinned speech model before speech-enabled packaging:

```sh
node tools/fetch-speech-model.mjs
```

Download identities and licenses are in [the model notice](models/MODEL-NOTICE.md). Translation installs into the selected data directory:

```sh
node cli/wiek-browser.mjs translation install --python /absolute/path/to/python3.12 --pairs en-zh,zh-en,en-es,es-en
```

Four synthetic English/Chinese/Spanish examples passed through source and packaged services with socket connections blocked during inference. This is bounded functional acceptance, not a general quality score. Python and translation weights are installed separately.

## Validation and packaging

```sh
npm test
npm run test:upstream
npm run test:e2e -- --browser wiek
npm run test:workbench
npm run dist
```

The app is built at `dist/mac-arm64/Wiek Browser.app`. It remains unsigned and unnotarized until release credentials are configured. The [CI workflow](.github/workflows/wiek-ci.yml) runs SDK, local, native, framework, packaged-host and browser checks from a clean checkout.

The local 69-case browser suite and the 31-task online model benchmark are separate. Online evaluation requires matched model/thinking/limits and dedicated test accounts; it has not run. See the [shared adapter setup](benchmark/sdk-v2/README.md) and [current results](reports/RESULTS.md).

Remaining work includes broader profile migration, additional MCP flows, semantic memory, other provider integrations, final native-device acceptance, and signed release. Physical sleep/login, multiple displays, permission revocation and real account workflows are recorded separately from synthetic tests.

## License

Wiek's original implementation uses the MIT license. Bundled SDK, runtime, decoder and model components retain their own notices and licenses. Runtime data, credentials, dependencies, builds, model weights, reference artifacts and full research records are excluded from Git.
