---
name: vek-browser
description: Drive the local Vek Browser using its JavaScript agent SDK, with persistent task spaces, page snapshots, input, downloads, and human handoff.
---

# Vek Browser

Run `vek-browser skill` for the installed SDK reference. From a source checkout, use `node cli/vek-browser.mjs skill` and `node cli/vek-browser.mjs nodejs`.

The host starts automatically when a script runs. Use a named task space and the Page model:

```sh
vek-browser nodejs <<'JS'
const task = await taskSpace('research');
const page = task.page('p1');
await page.goto('https://example.com');
console.log(await page.snapshot());
JS
```

Restore the same task name and page label in later rounds. Page refs persist across rounds but must be refreshed after document changes. Use `await task.finish({keep: []})` to close managed pages and finish, or `await task.finish({keep:'all'})` to retain them for the user. Never claim or take over an existing user space without the user's authorization. Follow user instructions for publishing, payments, and other consequential actions.

Use `VEK_DATA_DIR` for an isolated browser profile when testing. `vek-browser status` describes the current host and `vek-browser stop` closes it. This skill does not import personal browser data or install other skills automatically.
