# Archived Git Synchronization Notes

This historical file is retained as a pointer only. The original version described private data repositories, local snapshots, and credential handling that must not be copied into a public repository.

For a public checkout:

1. Keep source code and instance data in separate locations.
2. Use the repository's normal authentication flow or a credential manager; never put an access token in a remote URL or command history.
3. Review the staged tree, build output, package contents, and reachable Git history before pushing.
4. Treat `events.db`, transcripts, memory cards, reports, and exports as instance data unless they have been explicitly synthesized and reviewed.

See [CONTRIBUTING](../../CONTRIBUTING.md) and [SECURITY](../../SECURITY.md) for the current policy.
