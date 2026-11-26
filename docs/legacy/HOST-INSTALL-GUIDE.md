# Archived Host Installation Guide

The former version recorded one machine's host-specific configuration, user profile, local paths, and historical validation results. Those details are intentionally not part of the public repository.

Use the host-neutral integration contract in [Agent configuration](../AGENT-CONFIG.md). An integration should point to one selected CP instance, keep instance data outside the source tree, and expose failures instead of silently treating a missing source as success.

The current plugin package and adapter contract are documented in [Plugin package](../PLUGIN-PACKAGE.md). Host-specific launchers belong in the host's own configuration and must not be copied into public examples with real paths or session data.
