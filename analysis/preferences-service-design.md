# Local preferences service and panel

Implemented from the client feature facts in `analysis/client-resource-feature-ledger.md`, especially Ego resource 58614's settings routes, theme/tab layout controls, shortcut conflict UI, selection toolbar and scoped memory/instructions controls. No proprietary client implementation or visual assets are copied. These modules implement local Vek configuration; effects such as native menus, page selection tools and agent context are supplied by the host.

## Host contract

```js
const { createPreferencesService } = require('./preferences-service.cjs');
const preferences = createPreferencesService({
  dataDir: DATA,
  platform: process.platform, // optional, also makes conflict tests deterministic
  reservedShortcuts: [],     // optional { accelerator, label } host reservations
  onChange: current => { /* update theme, layout, native menu, current snapshot */ },
});
const current = preferences.snapshot();
await preferences.dispatch(action, payload);
preferences.close();
```

`onChange` runs once at initialization and after each saved mutation. The host should initialize its service variable before relying on that callback to access the instance. The callback receives an independent JSON snapshot; mutation of a returned snapshot does not modify stored preferences.

State defaults:

```json
{
  "version": 1,
  "theme": "system",
  "tabLayout": "horizontal",
  "backgroundMode": false,
  "onDeviceModels": true,
  "selectionToolbar": {"enabled":false,"copy":true,"ask":true,"save":true,"translate":false},
  "memory": {"browserActivity":false,"localFiles":false},
  "instructions": "",
  "shortcuts": {"newTab":"CommandOrControl+T", "closeTab":"CommandOrControl+W", "openLocation":"CommandOrControl+L", "reload":"CommandOrControl+R", "find":"CommandOrControl+F", "back":"CommandOrControl+[", "forward":"CommandOrControl+]", "zoomIn":"CommandOrControl+Plus", "zoomOut":"CommandOrControl+-", "zoomReset":"CommandOrControl+0", "voiceInput":"", "screenshot":"", "clip":"", "chat":"", "switchSpace":"", "spaceManager":""}
}
```

A snapshot also contains `actions:[{id,label,defaultAccelerator}]` and `reservedShortcuts:[{accelerator,label}]` for rendering and host accelerator wiring.

| Action | Payload | Result |
| --- | --- | --- |
| `preferences:snapshot` | `{}` | Full snapshot |
| `preferences:update` | Partial fields `theme`, `tabLayout`, `backgroundMode`, `onDeviceModels`, `selectionToolbar`, `memory`, `instructions` | Saved snapshot |
| `preferences:shortcuts:validate` | `{action,accelerator}` | `{valid,normalized,physicalChord,conflicts,error?}` without mutation |
| `preferences:shortcuts:set` | `{action,accelerator}` | Saved snapshot; rejects conflict |
| `preferences:shortcuts:reset` | `{action?}` | Restore one default, or all defaults; one-action reset checks collisions |
| `preferences:reset` | `{}` | Restore all defaults |

Partial nested patches preserve omitted flags. Unknown fields and wrong types are rejected. `theme` permits `light`, `dark`, `system`; `tabLayout` permits `horizontal`, `vertical`. Instructions are UTF-8 text of at most 8192 bytes, with no NUL. Values over the limit produce `VEK_PREFERENCES_INVALID`; there is no silent truncation.

Shortcut aliases normalize to Electron accelerators. A shortcut requires Command/Control/Alt/Super and one supported key; empty text means unassigned. Conflict comparison resolves CommandOrControl to the current platform's primary modifier. App action collisions and a documented common-system reservation set are rejected; the host can add reservations. This is not an exhaustive query of user-customized OS shortcuts. Invalid changes produce `VEK_PREFERENCES_INVALID` or `VEK_PREFERENCES_SHORTCUT_CONFLICT` and preserve prior configuration. The host binds the action IDs above to native menu commands; this module does not register global shortcuts.

Storage is `DATA/preferences/state.json`, written atomically via mode-0600 temporary file and rename, inside a mode-0700 directory. Directory/state symlinks and invalid saved shortcuts are rejected. All data is local. The service reads its own configuration only; it never harvests browser history or project files. Persistence and effect handlers are separate, so a host effect failure should be surfaced by the host rather than represented as an applied runtime capability.

## UI contract

Load `preferences-panel.css` and `preferences-panel.js` in the trusted browser chrome, then:

```js
const panel = window.VekPreferencesPanel.mount(container, invoke);
panel.update({ preferences: state.preferences }); // direct snapshot also accepted
panel.destroy();
// Alternatively use window.createVekPreferencesPanel(container, invoke) for an independent instance.
```

`invoke(action,payload)` returns the service action result. The panel supports theme/layout controls, selection Copy/Ask/Save flags, scoped memory flags, instructions, background mode and local speech-model switch, plus shortcut recording/manual input, conflict validation, clear and reset. It renders light/dark/system appearance and follows `prefers-color-scheme` changes. Translate is explicitly disabled and labeled unavailable because no translation provider is implemented. The underlying schema retains a translate flag for future compatibility, without claiming that a provider exists.

## Host effect boundaries

- Set `nativeTheme.themeSource`, chrome theme and tab orientation from preferences.
- Bind shortcut action IDs to native menu accelerators and actual browser/agent actions.
- Apply selection toolbar preferences only in the user-visible page; Save targets the local Library.
- `backgroundMode` controls the host's tray/task lifecycle after windows close.
- `onDeviceModels` controls bundled Whisper speech capability only; it does not imply a local general-purpose agent model.
- Add browser activity context only from the current task's Space, and file context only from its current project. Flags do not authorize scanning unrelated folders.
- Append instructions into bounded run context without truncating stored instructions. The 8 KiB preference limit leaves room for the host's tool catalog and fixed context under its 32 KiB run-context budget.

## Verification

- `node --test tests/preferences-service.test.mjs`: 5/5 tests pass. Defaults, partial persistence/file modes, cross-platform shortcut normalization and conflicts, unknown/bad field rejection, 8192-byte multibyte boundary, reset collisions, close, symlink and invalid saved-state rejection.
- `node tests/preferences-panel-smoke.mjs`: 13 assertions pass in actual Electron with sandbox/context isolation. Real IPC/service updates, system dark rendering, theme changes, vertical layout, disabled Translate, instruction saving, reserved conflict UI and custom shortcut saving are checked.
- `reports/preferences-service-test.log`, `reports/preferences-panel-smoke.log`, and visually inspected `reports/preferences-panel-dark.png` record results. Test uses a separate temporary profile and does not start the main browser or rebuild the SDK.
