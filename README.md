# Wiek Browser

<img src="app/assets/wiek.svg" alt="Wiek Browser" width="96">

The app and Skills use [independently authored Wiek artwork](analysis/wiek-brand-assets.md).

[English](README.md) | [简体中文](README.zh-CN.md)

A local Chromium browser and agent workspace, previously named **Vek Browser**. Wiek implements its own Electron host, browser UI, profiles, task spaces, and local services, and reuses the MIT-licensed public SDK from [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite).

**Development checkpoint: 0.20.3.** The repository includes ongoing P3 work; full Ego feature parity and the P4 live-site benchmark are **not complete**. See [PLAN.md](PLAN.md), [feature coverage](analysis/feature-parity.md), and [validation](reports/RESULTS.md). Historical reports retain the former project name and describe their original builds.

The 0.20.3 source gates passed **512/512 local tests**, **532/532 SDK tests**, and **197/197 packaged host checks**. The shared-SDK browser suite passed 69/69 on Wiek and 68/69 on Ego 0.6.2.7; the remaining Ego failure is HTML paste. Native P3 acceptance and the online model benchmark remain open.

## Quick start

The tested desktop target is **macOS ARM64**. Use Node.js 24 or a compatible newer version.

```sh
git clone https://github.com/YeohsCode/Wiek-Browser.git
cd Wiek-Browser
npm ci
npm --prefix packages/sdk ci --ignore-scripts
npm run build:sdk
npm start
```

The source checkout starts without the optional speech model. Rebuild the native macOS desktop helpers after changing their Swift sources:

```sh
npm run build:desktop-native
```

CLI:

```sh
node cli/wiek-browser.mjs start
node cli/wiek-browser.mjs status
node cli/wiek-browser.mjs skill
node cli/wiek-browser.mjs stop
```

Use `WIEK_DATA_DIR=/absolute/path` for an isolated instance. `VEK_DATA_DIR` and `cli/vek-browser.mjs` remain compatibility aliases. Development data defaults to `data/`; packaged builds use `~/Library/Application Support/Wiek Browser/`. If only the former `Vek Browser` directory exists, Wiek reuses it without moving or deleting it. An existing Wiek directory takes precedence. Changes to the app identifier can require renewed macOS permissions and login-job review.

Data-directory reuse covers stored files; OS-bound encrypted credential migration remains separately unverified. See [rename compatibility](analysis/wiek-rebrand.md).

## Features and scope

- Multi-tab browsing, task spaces, isolated profiles, bookmarks/history/downloads, website permissions, and user/agent handoff.
- JavaScript browser SDK: snapshots, locators, keyboard/mouse input, frames, screenshots, upload/download, and CDP.
- Local agent workspace with CLI providers, selected native protocol adapters, approvals, attachments, conversation history, and turn-linked file/Git checkpoints.
- Scoped file editing/search/watch, local Git, reviewed remote fetch/pull/push, and GitHub PR workflows through an installed, authenticated `gh` CLI.
- stdio and HTTP MCP, scoped connections, resources/subscriptions, reviewed OAuth/PKCE, client metadata, and bounded tool-input continuations.
- Scheduled automations, execution modes, opt-in macOS login jobs, busy deferral, run memory/results, stop evaluation, and conservative crash recovery.
- Library/collections, screenshot annotation, webpage recording, local speech transcription, and opt-in desktop tools.

**P3 work in this checkpoint still needs final acceptance:** physical multi-display/permission-revocation coverage and additional translation languages, system sleep/login/revocation behavior. Remote Git is tested against disposable local bare repositories; GitHub PR tests use synthetic protocol processes, with no real account writes. Other agent integrations remain deferred. Full browser-data migration, some MCP features, semantic memory, signing/notarization, and the 31-task live-site benchmark remain open.

## Browser automation

```sh
node cli/wiek-browser.mjs nodejs <<'JS'
const task = await taskSpace('research');
const page = task.page('p1');
await page.goto('https://example.com');
console.log(await page.snapshot());
JS
```

Reuse the task name and page label across turns. Run `node cli/wiek-browser.mjs skill` for the SDK guide or `node cli/wiek-browser.mjs api help` for the [local workbench API](skills/wiek-browser/API.md).

## Optional local models

Speech uses a local Whisper tiny model. Its pinned download, checksum, license, and decoder build identity are documented in [models/MODEL-NOTICE.md](models/MODEL-NOTICE.md). Model weights are excluded from Git; restore them before speech validation or building a speech-enabled package.

The experimental translation adapter uses an explicitly installed Python/Argos runtime and English/Chinese models:

```sh
node cli/wiek-browser.mjs translation install --python /absolute/path/to/python3.12
```

Installation downloads dependencies/models into the selected data directory; inference is intended to remain offline. Two real English/Chinese examples have passed through the service with socket connections blocked during inference; this is a bounded acceptance result, not a general translation-quality score. Python and Argos models are not bundled in the application.

## Validation and packaging

```sh
npm test
npm run test:upstream
npm run test:workbench
npm run dist
```

The Wiek-owned [CI workflow](.github/workflows/wiek-ci.yml) installs locked dependencies, restores pinned speech weights, and runs SDK/local/packaged tests on macOS ARM64. The complete remote run [41830745101](https://github.com/YeohsCode/Wiek-Browser/actions/runs/41830745101) passed on code commit `b50f9b7`; the source and packaged gates match the recorded scope. `npm run test:upstream` restores two exact upstream workflow files as inactive test fixtures; it does not enable their publishing automation.


The macOS artifact is `dist/mac-arm64/Wiek Browser.app`. It is a local unsigned build until signing/notarization is configured.

**0.20.3 acceptance:** 512 local tests, 532 SDK tests, 197 packaged host checks, and 69/69 Wiek browser cases (1,248 assertions) passed. Ego 0.6.2.7 passed 68/69 (1,235 assertions) with the same modified SDK, fixture and case index; 81 original upstream test inputs remain unchanged. Both local canonical V2 smoke runs passed. See [reports/RESULTS.md](reports/RESULTS.md) and [SDK changes](analysis/sdk-changes.md). These checks are separate from the unrun 31-task model benchmark.

Ego reference comparisons require separately obtained reference artifacts under ignored `references/` and `downloads/`; ordinary Wiek-only development does not. Do not rebuild the SDK concurrently with reference E2E. Pin the native reference version explicitly and use `tools/ego-reference-cli` with the dedicated `vek-reference` instance, rather than a personal default session. For the recorded run, `WIEK_REFERENCE_VERSION=0.6.2.7` and `VEK_COMPARISON_EGO_CLI="$PWD/tools/ego-reference-cli"` were set. Use an isolated Wiek data directory for comparison runs.

## Project documents

- [Plan and outstanding acceptance](PLAN.md)
- [Document index](docs/README.md)
- [Feature coverage and evidence limits](analysis/feature-parity.md)
- [Shared-suite comparison](reports/comparison.md)
- [Third-party notices](NOTICE.md) and [MIT license](LICENSE)

Runtime data, credentials, dependencies, builds, model weights, reference binaries, and full extracted proprietary evidence are excluded from Git. Wiek is independently implemented and is not affiliated with CitroLabs. Historical Vek identifiers remain where required for data, protocol, and test-evidence compatibility.
