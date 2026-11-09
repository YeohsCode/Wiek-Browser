---
name: wiek-browser
description: Use Wiek Browser for browser automation, local web testing, screenshots, page extraction and collaboration with the user. Read this Skill before browser tasks and use the independently installed wiek-browser command.
metadata:
  version: "2.1.0"
  date: "2026-10-08"
  bootstrap: true
---

# wiek-browser

Before any browser task, run:

```bash
wiek-browser skill
```

and follow its output. It prints the usage guide that matches the installed
Wiek Browser version. Run it again after `wiek-browser upgrade`, or when any output
says to.

The guide ends with a line starting `[wiek-browser:skill] end of guide`. If that
line is missing, the output was truncated: save it to a file and read the file
in parts, for example `wiek-browser skill > "$TMPDIR/wiek-browser-skill.md"`, or
`wiek-browser skill > "$env:TEMP\wiek-browser-skill.md"` in PowerShell.

## References

- [Install or upgrade Wiek Browser](references/install.md) — read when
  `wiek-browser` is not found, or `skill` is an unknown command.
- [Clearing cookies, cache, and storage](references/clearing-state.md) — read
  before clearing any cookie, cache, or storage; some clears reach the whole
  browser profile.
