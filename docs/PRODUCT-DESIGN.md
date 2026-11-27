# Cosmic Phantom Product Design

## 1. Product promise

Cosmic Phantom (CP) is a local-first memory control layer for one person and the Agent environments they use. Its job is narrow:

> Reduce repeated teaching, and prevent a stale or incorrect memory from misleading the next task.

CP does not promise that an Agent will remember everything. It makes persistent memory inspectable before activation, traceable after activation, and testable after correction.

The product is independent of any particular Agent, host, model provider, or cloud service. Host integrations are optional adapters. The CP instance and its data remain usable when an adapter or the CP plugin is disabled or removed.

## 2. The first user loop

The first product loop is one complete, observable journey:

```text
User expresses a durable intent
  -> CP records a source event
  -> CP creates an inactive candidate
  -> User reviews and approves it
  -> CP retrieves the active memory in a later task
  -> User corrects it
  -> CP proves the old version is no longer current and the new version is usable
```

The loop has four user-visible guarantees:

1. A proposal is not an active memory before approval.
2. An active result has a short source pointer and an explicit scope.
3. A correction preserves the old version for audit but removes it from current results.
4. Retrieval and correction verification run locally without an online model.

## 3. Product boundaries

### Included in the first product

- Append-oriented source events with stable source identity.
- Rebuildable daily projections for human inspection.
- Deterministic extraction of candidates from explicit user memory signals.
- On-demand review: inspect, expand source context, edit, approve, reject, or postpone.
- Approved active memories with scope, provenance, lifecycle status, and version relations.
- Bounded lexical retrieval with an optional local vector enhancement.
- Explicit cross-domain retrieval and conflict visibility.
- Correction and replacement with targeted old/new verification.
- A generic plugin package that keeps plugin code separate from instance data.
- Manual and normalized event inputs when a source has no automatic export.

### Deliberately excluded

- Automatic access to a host's private conversation files without a declared source export.
- Online LLM calls in the ingestion, approval, retrieval, or correction hot path.
- Automatic confirmation, automatic domain assignment, automatic fact merging, or silent conflict resolution.
- A separate dashboard, desktop window, or unsolicited review notification.
- A hosted multi-user permission system.
- A single-host product identity or a host-specific installation contract.
- Implicit migration of existing root-level memories into the new domain layout.

A source that cannot provide a transcript, JSONL stream, hook, MCP event, or manual input is reported as not connected. CP must not infer successful capture from the existence of a plugin or configuration file.

## 4. Data model and authority

The instance has one evidence layer and several controlled products derived from it:

```text
source adapter
  -> events.db                    authoritative raw events
  -> daily/                       replayable reading projection
  -> candidates/                  inactive proposals
  -> domains/<domain>/candidates/ classified inactive proposals
  -> domains/<domain>/memories/   approved active entities
  -> indexes / vectors / links    rebuildable retrieval assets
```

- `events.db` is append-oriented. Historical rows are not silently updated or deleted; corrections and erasures are represented by new audit events.
- `daily/`, indexes, vectors, links, and views are derived. They may be deleted and rebuilt from their inputs.
- A candidate is not an active memory. Unapproved, rejected, sensitive, or out-of-scope content is excluded from default retrieval and injection.
- `current-state.json` records what is being worked on now. It is not a replacement for long-lived memory.
- Every active memory keeps a provenance pointer to its candidate and source evidence, plus the actor and time of approval.

### Stable event identity

An adapter must preserve at least:

```json
{
  "source_instance": "stable-source",
  "source_id": "stable-record-id",
  "revision": 1,
  "session_id": "session-id",
  "role": "user",
  "content": "original content",
  "ts": "2026-01-01T00:00:00.000Z",
  "scope": "workspace"
}
```

`source_instance + source_id + revision` is the replay identity. A content hash can detect corruption or support a constrained fallback; it cannot merge two real records merely because their text is equal.

## 5. Memory domains

CP separates three purposes that otherwise become an undifferentiated memory pile:

| Domain | Stores | Does not store |
|---|---|---|
| `project` | Long-lived project goals, constraints, and decisions | Cross-project personal habits or transient work logs |
| `preference` | Stable personal preferences and collaboration habits | A decision that is valid only for one project |
| `knowledge` | User-approved facts, concepts, methods, and research cards | Raw sources, unapproved excerpts, or citations treated as facts |

`domain` and `scope` are independent:

- `domain` says what the memory is for.
- `scope` says where it may be used: `global`, `workspace`, or `agent`.

Each memory has one entity ID, one primary domain, one body, and one lifecycle state. It may list additional applicable domains, but CP never creates duplicate bodies or shortcut copies for them. A candidate whose primary domain has not been chosen stays in `candidates/unclassified/` and cannot enter domain retrieval.

Default retrieval chooses the smallest relevant domain. Cross-domain retrieval requires an explicit request and labels every result with domain, scope, state, and a short provenance pointer. Conflicts remain visible side by side; CP does not invent a merged fact.

## 6. Review and authorization

Candidate review is the central product experience and is intentionally quiet. The user asks to see candidates or uses an explicit review entry point in the current Agent environment.

The review contract is:

- Show the candidate text, short source summary, time, and safety state first.
- Expand only the requested source event and minimal surrounding context.
- Editing changes the candidate and preserves its edit history; saving an edit does not activate it.
- Approve, reject, postpone, and restore are separate explicit actions.
- Batch actions require an explicit candidate set and one action; suspected duplicates and conflicts are excluded by default.
- Rejecting preserves a minimal audit record and suppresses immediate regeneration of the same proposition.
- Postponing keeps the candidate pending but moves it out of the default review list.
- A sensitive candidate is isolated and never echoed into ordinary Agent context.

A normal “remember this” request creates a pending candidate. A direct activation request is allowed only when the user explicitly asks for immediate long-term effect; CP still shows a structured preview and records `activation_mode=explicit_direct` with source, actor, timestamp, and validation outcome.

## 7. Retrieval and injection

The retrieval contract is ordered by trust, not just by score:

```text
normalize query
  -> apply domain and scope boundaries
  -> lexical retrieval
  -> optional local vector retrieval
  -> fuse and rank
  -> apply evidence admission
  -> fold topics and bound output
```

- Status and scope are checked before ranking score can admit a result.
- Only confirmed active memories enter the default memory surface.
- The lexical path is the offline baseline and works without model assets.
- Local vectors are an optional recall enhancement. Missing or incompatible assets fail open to lexical retrieval and expose the actual fallback mode and reason.
- Output is bounded. The default result contains memory text, stable ID, status, scope, and a short provenance pointer; full raw evidence requires an explicit expansion request.
- Retrieval does not call an online model and does not create new memories.

## 8. Correction and replacement

A correction starts from the memory card or retrieval result. The user edits the new content and explicitly confirms it. CP records a replacement relation rather than erasing the old evidence.

Completion requires two local checks:

1. The new version is retrievable under a targeted query.
2. The old version is absent from current-valid results, while remaining available for audit and source inspection.

If either check fails, CP reports correction verification failure. It does not claim success merely because a file was written.

## 9. Standalone plugin boundary

The plugin is a delivery unit, not the data store:

```text
plugin package / runtime  !=  user instance data
```

The package may contain the engine, launcher, schemas, and adapters. The instance owns events, candidates, active memories, configuration, cursors, and derived assets.

Lifecycle rules:

- Configure an instance after installation; configuration is not an installer.
- Disable stops ingestion intent and preserves all data.
- Uninstall removes plugin code only; it preserves the instance.
- Reinstall or upgrade reattaches to the existing instance after package identity and integrity checks.
- Deleting instance data is a separate, high-risk, explicitly confirmed operation.
- Adapters are optional and must not bypass the candidate approval gate.

## 10. Definition of done for v1

CP v1 is product-complete when a clean instance can demonstrate, without an online model or private machine state:

- one normalized event becoming one pending candidate;
- the candidate staying outside default retrieval until explicit approval;
- one approved memory returning with domain, scope, status, and provenance;
- a correction making the new version current and the old version non-current;
- duplicate source delivery remaining idempotent;
- a failed source or derived layer producing an explicit, counted, recoverable failure;
- plugin disable/uninstall preserving instance data.

These are product acceptance criteria. They are not a claim that every host adapter, distributor, migration path, or recovery scenario has already been verified.

## 11. Public implementation status

The repository currently contains the event ledger, candidate approval flow, retrieval and correction mechanisms, an isolated three-domain API/CLI, and a generic plugin P0. The legacy default search/injection path remains unchanged while the domain contract is isolated. Existing instance data is not implicitly migrated.

The remaining work is integration hardening and evidence gathering around the contract above, not a change to the product identity. Host-specific adapters, distribution environments, and historical migration belong in separate follow-up work and must not redefine CP.
