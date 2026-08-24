# GJC public SDK contract map — upstream dev merge evidence

<!-- CONTRACT-MAP:provenance -->

This Slice 0 map reviews the exact upstream development merge `e3b3a76a590081ded16214a1188857524d40e701` (PR #4853), not an npm release. The reviewed package root is `packages/coding-agent`; its public import is `@gajae-code/coding-agent/sdk`. The dev worktree exports TypeScript source declarations and has no generated `dist/types` directory. The companion fixture embeds exact base64 bytes and SHA-256 for every reviewed source file and upstream `docs/sdk.md`; the test decodes and recomputes each digest without network or `node_modules`.

## Separate published npm metadata

<!-- CONTRACT-MAP:npm -->

| Field | Historical published metadata |
| --- | --- |
| Package | `@gajae-code/coding-agent@0.15.0` |
| Tarball | `https://registry.npmjs.org/@gajae-code/coding-agent/-/coding-agent-0.15.0.tgz` |
| Integrity | `sha512-mF7Fgdp40dYC2FufjKeEYY0W5/aI1O+/NinTo8bAuPefLN0K3p4EbRK0JvMv8sNV9qAZXEaSjPvWyJxufGoVZA==` |
| Generation status | Absent: the published npm 0.15.0 package predates `generationStatus`. |

Do not call the dev merge npm `@0.15.0`. The current repository may remain pinned to 0.14.

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

## Dev consumption and remaining gate

<!-- CONTRACT-MAP:consumption -->

The release-shaped exact dev package artifact has now been built from merge `e3b3a76a590081ded16214a1188857524d40e701`, with dist/type generation and published-manifest rewriting. Its vendor filename is `vendor/gajae-code-coding-agent-e3b3a76a590081ded16214a1188857524d40e701-8ba25005.tgz`; its SHA-256 is `8ba25005471c66871842cddefcdb98c0118ab26c3890b58f1f93665da524f4cb`, npm shasum is `40eca66fa90a933381bdca8be6e404db4088c18f`, and full pack integrity is `sha512-C5wDGvy2KOf+0DQKmo+q7Gi0y8XvUYjgXCZv03lGt+3zd+HPDPjz/Ll/cb6rf6FZPv+tY2AeqqymRlVYjz4HLA==`.

After Slice 1, `package.json` must point `@gajae-code/coding-agent` at exactly `file:vendor/gajae-code-coding-agent-e3b3a76a590081ded16214a1188857524d40e701-8ba25005.tgz`. This records a local release-shaped dev artifact; it does not claim an npm release. The retirement API contract and dev artifact provenance are proven. Production activation remains subject to the approved plan/user directive. User-owned artifacts remain excluded from all mutation.
