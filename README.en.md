# Cosmic Phantom

**Long-term memory for AI agents that users can approve, trace, and correct.**

When work spans many sessions, people have to repeat decisions and correct stale assumptions. Cosmic Phantom (CP) is designed to make persistent memory accountable: proposed memories stay inactive until a user approves them, active memories retain source links, and corrections can be checked against prior versions.

CP is a local-first engine for a single user. It is not a hosted multi-tenant service, and the repository does not include personal memory data.

## What CP provides

- An append-oriented event ledger that can be replayed into readable projections.
- A review boundary between extracted candidates and active memories.
- Search over approved memories, with optional local vector retrieval and explicit fallback behavior.
- Source and revision links to help inspect and correct memory results.
- A generic plugin package with manual, JSONL, and transcript adapter contracts.

## Current status

CP is under active development. The generic plugin P0 and isolated three-domain API/CLI have implementation and tests, but the three-domain product specifications remain drafts. Three-domain migration and changes to legacy default search or injection are not enabled. A passing test suite is not evidence of complete production readiness; consult the limitations below and in the linked documents.

## Quick start

Requirements: Node.js 22.5 or newer and Git.

```bash
git clone https://github.com/JZzzzStudio/CosmicPhantom.git
cd cosmic-phantom
npm install
node --experimental-sqlite memory-cli.js verify --root .
```

This checks the engine checkout. It does not import personal conversations or memory data. To connect an instance or an agent environment, follow [the configuration guide](docs/AGENT-CONFIG.md).

Local vector retrieval is optional. Without its model or runtime, CP should report and use its lexical fallback. See [the plugin package guide](docs/PLUGIN-PACKAGE.md) before packaging the generic plugin.

## Memory lifecycle

```text
source input -> event ledger -> review candidate -> user approval -> active memory -> bounded retrieval
```

Unreviewed candidates are not part of the legacy default search or injection path. The isolated three-domain API requires an explicit domain (or an explicit cross-domain request); it does not change the legacy default path.

## Documentation

- [中文 README](README.md)
- [Documentation index](docs/README.md)
- [Architecture and invariants](docs/ARCHITECTURE.md)
- [Product design and v1 acceptance](docs/PRODUCT-DESIGN.md)
- [Agent configuration](docs/AGENT-CONFIG.md)
- [Generic plugin package](docs/PLUGIN-PACKAGE.md)
- [Evaluation methodology and limitations](eval/METRICS.md)
- [Security and privacy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
- [MIT License](LICENSE)

## Privacy boundary

The public repository is for code, documentation, synthetic examples, and redacted validation numbers. Do not commit personal conversations, memory instances, runtime databases, credentials, unredacted source exports, or machine-specific configuration. See [SECURITY.md](SECURITY.md).
