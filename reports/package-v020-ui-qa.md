# Vek 0.2.0 packaged UI QA

Tested the packaged app using native CUA in the isolated data/final-package-v020-ui profile. No personal browser store, Keychain item, microphone or paid model was used.

- Confirmed all workbench sidebar entries and version 0.2.0.
- Exported an empty synthetic Profile with a masked test-only passphrase through the native Save dialog. The resulting AES-GCM archive is 624 bytes, mode 0600 and contains no plaintext fixture passphrase.
- Reopened it through the native Open dialog and restored one blank Space into a distinct Personal (imported) Profile; the original default remains available.
- Applied dark mode and vertical tabs through the actual preference controls, visually checked the chrome, then restarted and verified both settings and Profiles persisted.
- Verified the bundled local transcription provider is ready, with executable arguments hidden under Advanced settings. Public JFK WAV file transcription was exercised through the real file picker.

Screenshot: package-v020-dark-vertical.png. Backend/workbench checks are separately logged in package-workbench-integration.log; UI checks do not substitute for browser SDK cases.
