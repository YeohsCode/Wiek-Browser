# Vek 0.3 native UI QA

The final macOS ARM64 package was tested using a separate `data/v030-native-ui` profile and `tests/fixtures/native-ui-server.mjs` on literal loopback. Native actions used CUA accessibility targets; no personal browser, microphone, location, camera, clipboard read or third-party account was accessed.

- The sidebar showed version 0.3.0 and the actual loopback page.
- Right-clicking the fixture link opened a native menu with new-tab/new-Space/save/copy/navigation/inspect actions. Opening the menu handed an Agent Space to the user. Selecting **Open link in new tab** created a second tab; selecting it showed `/next` and the heading **Opened native menu link**.
- The test explicitly returned control to the Agent, then evaluated `Notification.requestPermission()` on the original loopback page. A real native modal showed the canonical origin and block-once/always-block/allow-once/always-allow choices. **Always block** was selected. The real CLI promise returned `denied` (v030-native-permission-result.log).
- The saved browser JSON had exactly the scoped Default/top/requester notifications block rule. The Space persisted `ownership: agentDelegatedToUser` and `controlReason: notifications`, proving native permission-triggered handoff rather than a simulated status label.
- Settings displayed the origin's Notifications value **Block**. Expanding active-site permissions showed separate Microphone and Camera controls, both **Ask**, without requesting either device. The actual layout was visually checked; screenshot `v030-native-site-permissions.png`.
- The QA host and its owned loopback server were stopped. The final package was started against normal `~/Library/Application Support/Vek Browser`, and native UI/status confirmed 0.3.0 with the ordinary Personal Space and no QA fixture tabs. No model prompt was sent.

The initial setup mistakenly requested an unmanaged SDK label `fixture`; the SDK correctly rejected it. Setup used existing Page `p1` thereafter. This was a QA invocation error, not a package test success or suppressed failure.
