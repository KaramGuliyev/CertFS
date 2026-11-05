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

1. Merge the changes to `master`.
2. Actions → **Release Obsidian plugin** → **Run workflow** → pick the bump (`patch` 0.3.5 → 0.3.6, `minor` → 0.4.0, `major` → 1.0.0).
3. The workflow bumps `manifest.json` + `versions.json`, commits to `master`, attests the build provenance of `main.js`, `manifest.json` and `styles.css`, and publishes the GitHub release.

Use **Run workflow**, not **Re-run** on an old run: a re-run repeats that old commit. Pushing a tag equal to `manifest.json`'s version still works too.
