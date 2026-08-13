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

- Updated the runtime to the published GJC `0.12.8` packages and SDK v3 hybrid lifecycle backend. `/v1/models` now intersects the GJC model catalog with the SDK's active-provider catalog, so OpenWebUI is shown only models from currently connected providers. Session attachment, turns, selection, gates, and events use the public SDK; the published CLI is limited to lifecycle creation, cold resume, readiness, and proof-bound close.
- Streamed assistant reasoning/text and lifecycle events while a turn is running instead of waiting for transcript completion. Workflow-gate continuations use the same streaming path.
- Made GJC session JSONL, artifacts, and correlated SDK finals authoritative while preserving OpenWebUI rows as projections and user-owned fields during reprojection.
- Separated project identity from model identity and made the bare `gjc` model an input-only alias; emitted model ids are canonical normalized tuples.
- Made runtime path resolution deterministic and isolated from ambient `GJC_CONFIG_DIR`, `PI_CONFIG_DIR`, and `GJC_CODING_AGENT_DIR`.
- Clarified managed Docker feasibility prerequisites and existing-route ownership, separated adapter/OpenWebUI readiness from GJC provider/model availability, and documented picker-to-`DEFAULT`, profile, and role-assignment semantics without adding runtime controls.
- Updated the managed deployment default from OpenWebUI v0.10.0 to v0.11.0 while retaining the v0.10.0 minimum for existing deployments and the explicit `GJC_OPENWEBUI_IMAGE` override.
- Documented that OpenWebUI v0.11's stock regenerate/fork UI cannot carry adapter branch-control metadata to an OpenAI-compatible provider; direct branch controls remain fail-closed rather than inferred.

### Fixed

- Rejected failed turns before exposing a successful stream and required the referenced session final before accepting completion.
- Preserved terminal-event chronology, streamed lifecycle delivery, text-shaped GJC deltas, and text-only turn recovery.
- Unwrapped nested SDK event payloads, projected GJC message-event variants, avoided duplicate artifact lifecycle events, and isolated best-effort OpenWebUI progress delivery failures from accepted GJC turns.
- Failed closed on malformed or ambiguous session, project, model, regenerate/branch, workflow-gate, and close authority instead of replaying, killing, or selecting a fallback.
- Persisted successor session authority before SDK rebinding, honored configured session roots, closed pre-ack lifecycle leaks, and aligned server timeout handling with the turn budget.
- Made existing-mode units launch and runtime configuration consume the packaged GJC executable with a usable Bun search path, accepted the explicitly supplied derived default agent directory, and kept fresh preflight rollback from stopping an absent unit.
- Made OpenWebUI chat project reassignment a durable two-phase authority transition: failed destination turns retain the source mapping, successful commits preserve retired operation tombstones, and stale source retries fail closed before destination runner effects, including after restart.
- Replaced interactive-only `/model` role guidance with the verified natural-language persistent-configuration flow and clarified that role updates need neither an adapter restart nor a new GJC session.
- Added fail-fast project-link permission validation for project directories and existing/prospective session roots, with client-correct errors before registration or OpenWebUI folder projection.
- Made installed `serve --config` honor and validate `GJC_OPENWEBUI_TURN_TIMEOUT_MS` instead of always forcing the 180-second default.
- Rejected accepted SDK turns whose terminal assistant message reports a provider transport error, including usage-limit failures, instead of persisting and returning an empty successful response.
- Removed the obsolete global `GJC` default prompt suggestion that auto-sent a generic coding-agent request; project and workflow Workspace Prompt hints remain available.
- Stopped the session authority from duplicating full per-turn event arrays inside every journal result, bounded record-level event growth in workflow-gate chains to the answered and next gate events plus the current turn's events (accepted gates from earlier chain steps are no longer retained), and made retired mappings drop their event payloads, so mapping documents no longer grow without bound.
- Preserved the strong gate-answer hash binding on replays of a still-current workflow gate operation (conflicting payloads are rejected again), bound completed workflow gate results to a compact answered-gate identity so replays of superseded gate operations are still verified by recomputing the durable request hash instead of bypassing payload validation, and made replayed control operations re-enqueue projection rows only when still current and only from the record mapping so payload hashes match completion-time rows.
