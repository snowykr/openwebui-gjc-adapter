# Changelog

## [Unreleased]

### Added

- Added an OpenAI-compatible `/v1/models` and `/v1/chat/completions` gateway backed by the released GJC public SDK, with canonical `gjc/<provider>/<model>:<thinking>` model selection.
- Added live OpenWebUI projection for GJC reasoning, assistant text deltas, tool/MCP activity, subagents, todos, goals, notices, retries, compaction, artifacts, workflow progress, and terminal status.
- Added workflow-gate rendering and continuation, including persisted schema and lineage validation before a reply is resumed.
- Added project linking, listing, and unlinking from chat commands, project-folder/session-history projection, file attachment handoff, and safe folder-deletion reconciliation.
- Added managed and existing-install CLI configuration paths with readiness probing, resumable recovery journals, runtime-location configuration, and loopback/private-network defaults.
- Added a focused Chromium/OpenWebUI smoke test and CI policy, compatibility, lifecycle, and runtime validation coverage.

### Changed

- Updated the runtime to the published GJC `0.11.6` packages and SDK v3 hybrid lifecycle backend. Session attachment, turns, selection, gates, and events use the public SDK; the published CLI is limited to lifecycle creation, cold resume, readiness, and proof-bound close.
- Streamed assistant reasoning/text and lifecycle events while a turn is running instead of waiting for transcript completion. Workflow-gate continuations use the same streaming path.
- Made GJC session JSONL, artifacts, and correlated SDK finals authoritative while preserving OpenWebUI rows as projections and user-owned fields during reprojection.
- Separated project identity from model identity and made the bare `gjc` model an input-only alias; emitted model ids are canonical normalized tuples.
- Made runtime path resolution deterministic and isolated from ambient `GJC_CONFIG_DIR`, `PI_CONFIG_DIR`, and `GJC_CODING_AGENT_DIR`.
- Clarified managed Docker feasibility prerequisites and existing-route ownership, separated adapter/OpenWebUI readiness from GJC provider/model availability, and documented picker-to-`DEFAULT`, profile, and role-assignment semantics without adding runtime controls.

### Fixed

- Rejected failed turns before exposing a successful stream and required the referenced session final before accepting completion.
- Preserved terminal-event chronology, streamed lifecycle delivery, text-shaped GJC deltas, and text-only turn recovery.
- Unwrapped nested SDK event payloads, projected GJC message-event variants, avoided duplicate artifact lifecycle events, and isolated best-effort OpenWebUI progress delivery failures from accepted GJC turns.
- Failed closed on malformed or ambiguous session, project, model, regenerate/branch, workflow-gate, and close authority instead of replaying, killing, or selecting a fallback.
- Persisted successor session authority before SDK rebinding, honored configured session roots, closed pre-ack lifecycle leaks, and aligned server timeout handling with the turn budget.
- Made existing-mode units launch and runtime configuration consume the packaged GJC executable with a usable Bun search path, accepted the explicitly supplied derived default agent directory, and kept fresh preflight rollback from stopping an absent unit.
- Reset session authority history and retired displaced provisional operations when an OpenWebUI chat moves to a different project so the new project mapping remains restart-valid and late old-project work cannot regain authority.
- Replaced interactive-only `/model` role guidance with the verified natural-language persistent-configuration flow and clarified that role updates need neither an adapter restart nor a new GJC session.
