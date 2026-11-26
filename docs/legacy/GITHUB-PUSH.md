# Archived Push Checklist

This historical file is retained as a public-safe checklist. It does not describe any private snapshot, data repository, or unpublished asset.

Before pushing a branch:

- Inspect `git diff --cached` and verify that only reviewed source and documentation are staged.
- Run the public-surface and sanitization checks.
- Scan reachable history and build artifacts; `.gitignore` is not a security boundary.
- Use a credential manager or the GitHub CLI. Never paste an access token into a URL, file, issue, log, or chat.
- Push a review branch and open a pull request. Do not bypass review by changing the default branch directly.

Current installation and contribution instructions are in [Agent configuration](../AGENT-CONFIG.md) and [CONTRIBUTING](../../CONTRIBUTING.md).
