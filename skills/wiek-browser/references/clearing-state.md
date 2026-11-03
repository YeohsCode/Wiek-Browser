# Clearing Wiek browsing state

Read `wiek-browser skill` before choosing a current SDK operation. First identify the intended Profile, task Space, site, and data category. Multiple Spaces can share a Profile: clearing profile cookies or cache can sign out its other Spaces too.

Use only the scope the user requested. If it is unclear whether the request covers the whole Profile, clarify before clearing it. Do not delete the browser data directory, credential vault, or unrelated profiles to clear a single site's data. Wiek does not automatically clear personal browsing data during tests.

`WIEK_DATA_DIR` selects an isolated test instance; `VEK_DATA_DIR` remains compatible. Use disposable test data for regression tests.
