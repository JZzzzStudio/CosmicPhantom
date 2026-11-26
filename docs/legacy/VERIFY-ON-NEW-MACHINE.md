# Archived New-Machine Verification

The former checklist asked operators to query private names and paste memory正文. That is not suitable for a public repository and has been removed.

For a new machine, verify only synthetic or user-supplied test data:

1. Confirm the source directory and instance root are the intended ones.
2. Run `node --experimental-sqlite memory-cli.js verify --root <INSTANCE_ROOT>`.
3. Run a search against a synthetic probe card created in a temporary instance.
4. Check the adapter or MCP connection with non-sensitive test content.
5. Record command output, failures, dataset hashes, and environment details without copying private memory text.

Use [Agent configuration](../AGENT-CONFIG.md) for the current contract and [Security](../../SECURITY.md) for the publication boundary.
