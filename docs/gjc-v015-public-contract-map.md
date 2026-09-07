# GJC public SDK contract map — released SDK and historical dev evidence

<!-- CONTRACT-MAP:provenance -->

This Slice 0 map reviews the exact upstream development merge `e3b3a76a590081ded16214a1188857524d40e701` (PR #4853), not an npm release. The reviewed package root is `packages/coding-agent`; its public import is `@gajae-code/coding-agent/sdk`. The dev worktree exports TypeScript source declarations and has no generated `dist/types` directory. The companion fixture embeds exact base64 bytes and SHA-256 for every reviewed source file and upstream `docs/sdk.md`; the test decodes and recomputes each digest without network or `node_modules`.

## Current released evidence — SDK 0.16.6

Production consumes the public managed SDK from `@gajae-code/coding-agent` 0.16.6 with matching AI/native packages from the npm registry. This section records current released evidence separately from the historical Slice 0 embedded source fixture and Slice 1 dev artifact below; neither historical artifact instructs the current dependency pin.

| Field | Current released provenance |
| --- | --- |
| Package | `@gajae-code/coding-agent@0.16.6` |
| Tarball | `https://registry.npmjs.org/@gajae-code/coding-agent/-/coding-agent-0.16.6.tgz` |
| Integrity | `sha512-53/Mdppx1gDzdtslKpGpuhVEU9he5+G7WfaHCXdbXRBYAbjkKBVwL9xFN9bAlRbX+gwWRShvr/dnYmTV2PHrWw==` |
| Release target | `f238c66de513d9a8b1b8d2544d413bd04e1c43db` |

The separately recorded `public-sdk-authority-api-test-report` and `public-lifecycle-producer-api-test-report` for installed 0.16.6 establish the exercised public lifecycle producer and rejection fences, not an aggregate cutover. `createExternal`, `fork`, exact saved `resume`, and `resumeExternal` produce an original opaque lowercase 64-hex `endpointIncarnation` paired with a positive `endpointGeneration`; exact original-pair close obtains positive `SessionRouter.generationStatus` retirement. The lifecycle producer from PR #5380 is shipped in this release; no claim is made that later merged changes are present.

The current `bun scripts/gjc-saved-resume-compat.ts --exact --replacement` probe requires a mismatched public saved-session snapshot hash to return `invalid_input`, live same-key replay to retain the original outcome, and old-key replay plus stale-original-pair close after independent replacement to return `endpoint_stale` while preserving the replacement. Cleanup uses each acknowledged endpoint's original lifecycle pair, not a Router-refreshed or session-ID-only target. Historical SDK 0.16.4 probes accepted the wrong snapshot and acknowledged the replacement under the old key; reproducing that unsafe behavior is no longer a successful probe result.

The released facade still projects generation and incarnation independently: both fields are optional, malformed members are omitted independently, and `ok:true` does not establish a complete exact-close pair. `validateSessionLifecycleMutationRequest` validates the close envelope, not the pair's completeness or shape; partial and malformed pairs reach its client unchanged. `test/gjc-released-authority-contract.test.ts` observes these facade behaviors using the real public service with a synthetic client, not a real Broker or endpoint. Adapter-side full-pair and durable-provenance validation remain mandatory; the separate live probes establish only their explicitly exercised producer and rejection paths.

The adapter now persists a sibling `endpointReceipt` from the original raw lifecycle result in ordinary create/resume/fork, late-success, initial-create, and historical-resume evidence. Validation and copying admit exactly `sessionId`, positive `endpointGeneration`, and lowercase 64-hex `endpointIncarnation`, matching the acknowledgement. The first acknowledgement seals both receipt presence and absence; no replacement or later backfill is allowed. An otherwise valid session/generation acknowledgement without a complete pair is retained as uncertain without renewed proof. Incarnation remains outside routing authority and generation proof. Ordinary retirement and catalog cleanup reservations bind their exact original source receipt without borrowing an older receipt, and pending-close reuse revalidates its `sourceProofRef` and source evidence.

The `managed-routing-api-package-test-report` from `scripts/gjc-managed-runtime-compat.ts` records `originalEndpointReceiptReopened: true`, `originalEndpointReceiptUsed: true`, and positive retirement after public exact close in an exclusively owned probe workspace. The separate historical bootstrap report records `originalEndpointReceiptPreserved: true`. These establish durable raw receipt retention and the isolated public close path; subsequent production reaper verification is recorded separately below.

The `production-reaper-public-sdk-integration` report records genuine empty activation, a full turn's persisted original receipt, the exact reserved close target, persisted raw lifecycle close acknowledgement, and positive `host_unregistered` retirement before mapping eviction. Workspace lease reacquisition, runtime disposal, and subsequent singleton reacquisition succeeded with an empty error list. This probe used real `buildAdapterServerOptions` purpose fences, public SDK Router/transport, workspace leases, and SQLite; only reaper scheduling controls were overridden, with a hermetic provider. Scoped reaper review is clear after actual raw admission/lease/preparation settlement and controlled heartbeat fixes. The empty activation coordinator stopped its own Router before the production runtime started: this verifies the scoped reaper path, not migration or a one-Router bootstrap-to-serving handoff.

Router `bindingAuthority` still exposes only `sessionId` and `endpointGeneration`, and public delete has no exact generation/incarnation target. Numeric generation proof cannot reconstruct a missing original receipt. Interactive/admin and opportunistic close and temporary catalog provisioning remain denied or unwired. Fresh-client replay, durable reopen, and the exercised rejection/close/reaper probes do not establish full uncertain/restart or broker-crash recovery. Delete, migration, bootstrap serving handoff, recovery, and non-reaper cleanup ownership remain unfinished; the original obligations are not reduced to receipt persistence or scoped reaper verification, and aggregate cutover approval remains held. Verified reaper integration is not general close or recovery authorization.

## Separate published npm metadata

<!-- CONTRACT-MAP:npm -->

| Field | Historical published metadata |
| --- | --- |
| Package | `@gajae-code/coding-agent@0.15.0` |
| Tarball | `https://registry.npmjs.org/@gajae-code/coding-agent/-/coding-agent-0.15.0.tgz` |
| Integrity | `sha512-mF7Fgdp40dYC2FufjKeEYY0W5/aI1O+/NinTo8bAuPefLN0K3p4EbRK0JvMv8sNV9qAZXEaSjPvWyJxufGoVZA==` |
| Generation status | Absent: the published npm 0.15.0 package predates `generationStatus`. |

Do not call the dev merge npm `@0.15.0`. The 0.14 pin was historical Slice 0 context; current production provenance is the released 0.16.6 package above. The following exports, request, generation-status, and disposition sections retain their historical embedded dev-source evidence rather than asserting a new 0.16.6 source audit.

## Public exports and lifecycle

<!-- CONTRACT-MAP:exports -->

The dev package export map maps `./sdk` types and import to `./src/sdk/index.ts`. That entry exports the `lifecycle` and `router` namespaces. Router index exports `SessionRouter`; lifecycle index exports the lifecycle service.

`lifecycle.createSessionLifecycleService(agentDir)` remains the public lifecycle factory. Create/fork/resume/close/delete mutations require actor, matching capability, and request key for deterministic idempotency; outcomes are explicit success or certainty-bearing failure. `session.list` follows `continuationCursor` pages and treats malformed, repeated, or exhausted traversal as uncertain.

These claims are source-bound by embedded `src/sdk/lifecycle/service.ts`, `src/sdk/lifecycle/client.ts`, and `src/sdk/session-list.ts`: service validates actor ID/namespace, capability, request key, and target; canonical SHA-256 derives idempotency; broker/transport/malformed outcomes map to explicit certainty; client implements `createExternal` and `resumeExternal`; traversal rejects malformed pages, repeated cursors, and page-budget exhaustion.

## Generic managed requests

<!-- CONTRACT-MAP:request -->

`SessionRouter.request(sessionId, frame, expectedGeneration?, expectedAttachment?, { timeoutMs?, beforeDispatch?, onDispatch? }?)` returns `Promise<Record<string, unknown>>`. It is the sole settler, applies exact-generation/current attachment checks, and rechecks authority after the response. `beforeDispatch` and `onDispatch` remain synchronous boundaries.

The approved managed query envelope is `{ type: "query_request", query: string, input?: Record<string, unknown>, cursor?: string }`. Parse each response before following `continuationCursor`; malformed, stale, timeout, or transport-close results are non-authoritative/uncertain.

The approved managed terminal-cancel envelope is `{ type: "control_request", operation: "turn.abort", input: { mode: "terminal", scope: "turn" | "owned" }, idempotencyKey: string }`. `Router.request` supplies transport request correlation through its request frame; the public terminal control contract source-binds mode, scope, and idempotency key. Parse an acknowledged terminal result before settling cancellation. Timeout, transport close, malformed result, or stale attachment is uncertain.

The source-bound evidence is `docs/sdk.md`, `src/sdk/cli/session-cli.ts`, and `src/sdk/host/control/dispatch.ts`, together with Router source. The CLI sends `query_request` and `control_request` through `Router.request`; official host control code validates terminal mode, scope, and a nonempty bounded idempotency key before side effects. Query pagination is represented by `continuationCursor`; lifecycle traversal rejects malformed pages, repeated cursors, and page-budget exhaustion. These official internal implementation/docs files are review evidence only: **production imports remain public `/sdk` only**.

## Exact-generation retirement

<!-- CONTRACT-MAP:generation-status -->

PR #4853 / merge `e3b3a76a590081ded16214a1188857524d40e701` publicly adds `SessionRouter.generationStatus(sessionId: string, endpointGeneration: number): Promise<SessionGenerationStatus>`.

The contract returns `current`, `retired`, `replaced`, or `unknown`:

- Evidence is credential-free `session_index` evidence with `observedIndexSeq` and, for positive states, `evidenceIndexSeq`.
- `retired` is positive only for the exact generation and includes one terminal event: `host_unregistered`, `session_closed`, or `session_deleted`.
- `replaced` supplies `currentGeneration`; it is not retirement proof.
- `unknown` reasons are `invalid_generation`, `index_unavailable`, `index_incomplete`, `session_not_observed`, `generation_not_observed`, `generation_reused`, `ambiguous_authority`, `proof_expired`, and `reconciliation_incomplete`.
- Retirement requires retained terminal evidence matching the registered incarnation, PID, and state root. Evidence beyond policy `maxAgeMs` becomes `unknown/proof_expired`; reuse, ambiguity, incomplete reconciliation, or absence never proves retirement.

Therefore close/delete may transition to retired only after `generationStatus` returns `retired` for the exact old generation under the adapter tenant fence. Stop, missing attachment, replacement, and unknown results remain insufficient.

## Approved old-to-new disposition

<!-- CONTRACT-MAP:disposition -->

The fixture contains the approved exhaustive old-to-new table. Its mandatory highlights are: delete `src/gjc/sdk-v3-client.ts`; delete `public-sdk-session-port.ts`, `public-sdk-contract.ts`, `PublicSdkSessionClient`, and `PublicSdkSessionPort` without a facade; remove `./gjc/public-sdk-contract` exports; delete `switchSession` with no `session.switch` alias/fallback; replace lifecycle operations with public lifecycle calls; and delete descriptor, CLI/tmux, bridge, and obsolete old-authority paths after migration.

## Required exclusions

<!-- CONTRACT-MAP:forbidden -->

Production code uses only `@gajae-code/coding-agent/sdk`. It must not import bridge client, `/sdk/client`, `/sdk/acp`, broker paths or internals; `router.SessionRouter#adoptLifecycleResult` remains forbidden.

## Historical Slice 1 dev consumption and remaining gate

<!-- CONTRACT-MAP:consumption -->

The historical release-shaped exact dev package artifact was built from merge `e3b3a76a590081ded16214a1188857524d40e701`, with dist/type generation and published-manifest rewriting. Its vendor filename is `vendor/gajae-code-coding-agent-e3b3a76a590081ded16214a1188857524d40e701-8ba25005.tgz`; its SHA-256 is `8ba25005471c66871842cddefcdb98c0118ab26c3890b58f1f93665da524f4cb`, npm shasum is `40eca66fa90a933381bdca8be6e404db4088c18f`, and full pack integrity is `sha512-C5wDGvy2KOf+0DQKmo+q7Gi0y8XvUYjgXCZv03lGt+3zd+HPDPjz/Ll/cb6rf6FZPv+tY2AeqqymRlVYjz4HLA==`.

Historical Slice 1 required `package.json` to point `@gajae-code/coding-agent` at exactly `https://raw.githubusercontent.com/snowykr/openwebui-gjc-adapter/c09e31dc85c514cffaf7e44827b47d311620c49f/vendor/gajae-code-coding-agent-e3b3a76a590081ded16214a1188857524d40e701-8ba25005.tgz`. This records an immutable release-shaped dev artifact hosted at an exact adapter commit, not an npm release or the current dependency instruction. The historical retirement API contract and dev artifact provenance remain proven by the embedded evidence; current production uses the registry 0.16.6 pin above. Production activation remains subject to the approved plan/user directive and outstanding integration obligations. User-owned artifacts remain excluded from all mutation.
