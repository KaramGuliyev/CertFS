# Security Policy

## Supported versions

Only the latest release of CertFS Quiz gets security fixes. Update through Obsidian → Settings → Community plugins → **Check for updates**.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub: [Security → Report a vulnerability](https://github.com/KaramGuliyev/CertFS/security/advisories/new).

Include:
- What the problem is and what an attacker could do with it.
- Steps to reproduce (plugin version, Obsidian version, platform).
- Never include your real OpenRouter API key or private notes.

You should get a first answer within 7 days. Once fixed, a new release is published and the advisory is made public, crediting you if you want.

## What the plugin does with your data

See the **Privacy** section of the [README](README.md#-privacy): the only network calls go to `openrouter.ai`, the API key is stored unencrypted in the plugin's `data.json`, and note text is sent only when you start a quiz.
