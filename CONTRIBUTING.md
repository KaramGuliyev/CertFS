# Contributing to CertFS Quiz

Thanks for helping! Issues and pull requests are welcome.

## Reporting a bug or idea

Open an issue on [GitHub](https://github.com/KaramGuliyev/CertFS/issues) with:
- What you did, what you expected, what happened.
- Obsidian version, platform (desktop / mobile) and the OpenRouter model you used.
- The error text from the plugin notice or the developer console (Ctrl/Cmd+Shift+I), if any.

Never paste your OpenRouter API key or private note content.

## Working on the code

- The plugin is a single no-build file: `main.js` (plus `styles.css` and `manifest.json`). No bundler, no dependencies.
- To try a change: copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/certfs-quiz/` and reload Obsidian (or toggle the plugin).
- Pure helpers are exported on `module.exports._test` so they can be unit-tested with Node by stubbing the `obsidian` module.
- Keep it small: plain JavaScript, Obsidian API only, no new network calls without documenting them in the README Privacy section.

## Pull requests

- One change per PR, with a short description of what and why.
- Update the README (Daily use / What's new) when behaviour changes.
- Don't bump the version in a PR; releases are cut by the maintainer.

## Releases (maintainer)

1. Bump `version` in `manifest.json` and add it to `versions.json`.
2. Merge to `master`, then either push a tag equal to the version (no `v`, e.g. `0.3.5`) or run the **Release Obsidian plugin** workflow from the Actions tab.
3. The release workflow checks the tag, attests the build provenance of `main.js`, `manifest.json` and `styles.css`, and publishes the GitHub release.
