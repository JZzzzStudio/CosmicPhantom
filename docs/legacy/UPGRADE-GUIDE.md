# Archived Upgrade Guide

The former upgrade procedure depended on private host layouts and machine-bound bundles. It is retained only to preserve the filename for old links.

For current work, review the repository's package and instance boundaries before upgrading. Back up the instance data, install code into a separate source directory, run the relevant tests, and verify that the selected instance still points to the intended engine. Never overwrite an event database or session transcript as part of a source-code upgrade.

Start with [Agent configuration](../AGENT-CONFIG.md), [Architecture](../ARCHITECTURE.md), and [Security](../../SECURITY.md).
