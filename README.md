# OpenWebUI GJC Adapter

Experimental TS/Bun adapter that treats GJC session JSONL/artifacts as the source of truth and projects them into OpenWebUI folders, chat history trees, message events, and an OpenAI-compatible live gateway.

## OpenWebUI setup

Start the adapter service with Bun:

```sh
GJC_OPENWEBUI_MODE=existing \
GJC_OPENWEBUI_BIND_HOST=127.0.0.1 \
GJC_OPENWEBUI_BIND_PORT=8765 \
GJC_OPENWEBUI_ADAPTER_API_TOKEN=<adapter-openai-key> \
GJC_OPENWEBUI_API_TOKEN=<openwebui-api-token> \
GJC_OPENWEBUI_OWNER_USER_ID=<openwebui-user-id> \
GJC_OPENWEBUI_PROJECTS="/home/me/src/my-repo|my-repo" \
GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS="/home/me/src" \
bun run start
```

`GJC_OPENWEBUI_MODE` must be exactly `managed` or `existing`. The adapter fails closed during startup when it is omitted, empty, whitespace-padded, a case variant, or any other value, with `GJC_OPENWEBUI_MODE must be exactly managed or existing`.

Configure OpenWebUI to use the adapter as an OpenAI-compatible backend:

```env
OPENAI_API_BASE_URL=http://127.0.0.1:8765/v1
OPENAI_API_KEY=<adapter-openai-key>
ENABLE_OPENAI_API=True
```

Add the required custom headers on the OpenAI connection:

```json
{
  "X-OpenWebUI-Chat-Id": "{{CHAT_ID}}",
  "X-OpenWebUI-Message-Id": "{{MESSAGE_ID}}",
  "X-OpenWebUI-User-Message-Id": "{{USER_MESSAGE_ID}}",
  "X-OpenWebUI-User-Message-Parent-Id": "{{USER_MESSAGE_PARENT_ID}}",
  "X-OpenWebUI-User-Id": "{{USER_ID}}",
  "X-OpenWebUI-Task": "{{TASK}}"
}
```
`X-OpenWebUI-User-Id` is required on every `/v1` request, including `/v1/models`. The adapter must be reachable only from trusted private or loopback OpenWebUI ingress: the shared adapter token authenticates that ingress, while the forwarded user ID establishes the request principal. Only the exact configured `GJC_OPENWEBUI_OWNER_USER_ID` is an administrator. Other users receive a durable private workspace at `<adapter-state>/workspaces/<sha256-user-id>/workspace`, with `.gjc/sessions` inside that workspace; raw user IDs never appear in paths.

Normal users cannot resolve linked host projects, project-admin routes, or another principal's chat, file, message, session, replay, close, or reaper state. Administrator project operations remain available through the configured owner identity. Workspace cleanup is administrator-only: `POST /admin/workspaces/{userId}/cleanup/preview` returns a short-lived confirmation token, and `POST /admin/workspaces/{userId}/cleanup` consumes `{ "confirmationToken": "…" }`. Cleanup is lease-fenced and leaves the workspace blocked when completion is uncertain.

Use OpenWebUI 0.10.0 or newer so chat/message/task placeholders are available. Production serving uses the public managed SDK from `@gajae-code/coding-agent` 0.16.6, pinned with matching `@gajae-code/ai` and `@gajae-code/natives` versions from the npm registry. Both `managed` and `existing` startup modes require a pre-existing canonical managed V3 authority and active marker before any state, lock, database, outbox, runtime, or listener effect; absent, V2, malformed, or unmarked authority fails closed. The marker admits its activation epoch without freezing ordinary mutable V3 persistence. Public `SessionRouter.generationStatus` must positively prove exact-generation retirement; attachment absence alone never proves close. The image uses pinned Bun 1.4.0 and the installed registry `gjc` executable as the non-root `adapter` user. Historical dev-package contract evidence is retained separately from the runtime dependency. The legacy bridge transport, descriptor-backed lifecycle, and tmux container dependency are removed. Scoped reaper exact-close verification is complete, but aggregate cutover approval remains held on the other close/catalog paths and full migration, recovery, delete, and serving-handoff obligations below. Reaper verification is not general close or migration enablement. Background task calls such as title generation are no-ops and must not create GJC sessions.

SDK 0.16.6 public lifecycle probes show `createExternal`, `fork`, exact saved `resume`, and `resumeExternal` returning an original `endpointIncarnation` (opaque lowercase 64-hex) paired with a positive `endpointGeneration`. Closing with that original lifecycle pair obtains positive retirement; closing with a stale pair after independent replacement returns `endpoint_stale` and preserves the replacement. This released producer is distinct from Router `bindingAuthority`, which still returns only `sessionId` and `endpointGeneration`; public delete still lacks an exact generation/incarnation target. Neither numeric-generation proof nor a refreshed Router binding can reconstruct missing original authority. Full uncertain/restart and broker-crash recovery remain unproven, and the existing bootstrap handoff, recovery, and cleanup obligations remain open.

The adapter now durably retains an original raw lifecycle `endpointReceipt` beside the acknowledgement in ordinary create/resume/fork, late-success, initial-create, and historical-resume evidence. It strictly validates and copies exactly `sessionId`, positive `endpointGeneration`, and lowercase 64-hex `endpointIncarnation`; the first acknowledgement seals receipt presence or absence against later replacement or backfill. An otherwise valid session/generation acknowledgement without a complete pair remains recorded as uncertain, with no renewed proof. Incarnation is not added to routing authority or generation proof. Ordinary retirement and catalog cleanup reservations bind the exact original source receipt; they cannot borrow an older receipt when the selected source lacks one, and pending-close reuse revalidates its `sourceProofRef` rather than bypassing the source check.

`bun scripts/gjc-managed-runtime-compat.ts` verified durable reopen of the original endpoint tuple and isolated public exact close with positive retirement; the historical bootstrap probe separately verified raw receipt retention. The subsequent production reaper probe exercised real `buildAdapterServerOptions` purpose fences, public SDK Router/transport, workspace leases, and SQLite, with only reaper scheduling controls overridden and a hermetic provider. A full turn persisted its original receipt; the reaper reserved that exact target, persisted the raw lifecycle close acknowledgement, obtained positive `host_unregistered` retirement, and only then evicted the mapping. Workspace lease reacquisition and runtime disposal followed by singleton reacquisition succeeded with no report errors. Scoped reaper review is clear after raw admission/lease/preparation settlement and controlled heartbeat fixes. Its genuine empty activation coordinator stopped its own Router before the production runtime started: this is reaper proof, not a one-Router bootstrap-to-serving handoff. Interactive/admin and opportunistic close paths and temporary catalog provisioning remain denied or unwired; delete, full uncertain recovery, migration, and serving handoff remain unfinished.

Canonical V3 operations retain lifecycle intent, acknowledgement, and exact-generation proof alongside the full routing journal. Adoption-only proof cannot authorize prompts, queries, or subscriptions; active work requires durable generation proof and a live tenant lease. The verified reaper path reserves an original-pair close, persists a matching close acknowledgement before observation, and commits positive retirement with its journal result atomically before eviction. A retryable label, lost attachment, or changed turn ID does not reactivate that generation. Interrupted operations retain their request identity and remain blocked for reconciliation; this does not yet provide the original staged-bootstrap or automatic same-key recovery contract.

Idle retirement has one finite budget across the entire scan, admission, lease acquisition, close, observation, and local publication. Ownership remains held through actual raw admission, lease acquisition, and preparation settlement; controlled heartbeat release stops new renewal and awaits any in-flight renewal before releasing the lease. Late durable preparation is retained as uncertain rather than dispatched after expiry. The inactive migration implementation requires real runtime-root and mutation-lock ownership, captures immutable base/WAL evidence before private replay, and recovers a proven V3 replacement forward without restoring V2 or overwriting external replacements. Private replay retains acknowledged WAL-only updates and completed event history. These safeguards do not enable V2 startup or complete the restricted staged-bootstrap contract.

Generation-free historical nodes now round-trip through ordinary V3 storage, including scoped journal results, provisionals, successors, and tombstone chains. Historical bindings retain source provenance but contain no invented generation, lease, or request key; a proof applies only to its exact source occurrence, never every result sharing a session ID. Tenant-scoped history reads preserve the original historical chat/header/result identities rather than rewriting them into logical live-chat views; ordinary managed writes likewise leave historical identities unchanged. Managed live views still expose logical chat IDs. Session-file paths and active-leaf values remain inert projection metadata. Unbound live roots block startup before public SDK effects, while normal tenant-scoped history lookup remains available inside the store. Migration reopens the private historical V3 stage before resolving bindings; the restricted public bootstrap and same-key recovery are still incomplete.

Direct V3 startup uses one finite configured turn budget across Router startup, mapping reconciliation, attachment/generation checks, the external lease fence, and failure cleanup. A timed-out phase cannot continue registering or publishing tenants. Private migration retains its historical stage under an immutable manifest-bound checkpoint; changed journal evidence blocks regeneration rather than being discarded on retry. Canonical V3 and its activation marker use the original cutover schema epoch `gjc-public-sdk-v015-managed/1`; persisted workspace/runtime lease epochs remain independent. The obsolete `managed/1` schema epoch is rejected, not silently converted.

`bun scripts/gjc-saved-resume-compat.ts` exercises saved-session resume through the released public SDK in an isolated workspace. Bare `resume` with only a full session ID and workspace cannot resume a saved session; `resumeExternal` supplies the saved-session resolution. With `--exact`, the probe instead selects `savedSession` using public `list(resolveSessionId)` and passes that public path/identity to `resume`, without adapter filesystem discovery. Both modes check the returned identity/workspace, equal same-key outcomes from a fresh client process, foreign-workspace denial, and no same-key reactivation after retirement. Cleanup uses the original lifecycle generation/incarnation pair for each acknowledged endpoint, then checks positive exact-generation retirement; it does not close by session ID alone or refresh authority from Router bindings. A new client process is not a broker/storage crash, and these checks do not establish complete interrupted-invocation recovery or production restricted-bootstrap authorization.

The additional `--exact --replacement` mode now verifies SDK 0.16.6 rejection fences: a deliberately mismatched public snapshot hash returns `invalid_input`; after an independent valid resume creates a replacement incarnation, the old request key and a close using the original stale pair both return `endpoint_stale`, leaving the replacement current. Historical SDK 0.16.4 probes instead accepted the mismatched hash and acknowledged the replacement under the old key, even with a reused numeric generation; that unsafe success is no longer the probe's success criterion. Historical 0.16.4 lifecycle surfaces also omitted the close incarnation, so isolated session-ID-only closes plus positive retirement did not prove replacement-race safety. Current probe success proves only the exercised snapshot, replay, and stale-close fences, not full uncertain recovery. Automatic uncertain bootstrap replay remains blocked.

Lifecycle certainty labels and error names are not public nonapplication receipts. The journal rejects post-invocation terminal classification, restoration using retained pre-close proof, and indirect retries through uncertain/acknowledged cleanup states. Local pre-invocation failure and initial cleanup of an acknowledged target remain distinct. These fail-closed guards do not establish the still-unproven full interrupted-recovery contract. Runtime shutdown uses one monotonic budget: graceful drain receives at most half, reserving the remainder to initiate local Router stop. `stop()` is the bounded observation; `dispose()` succeeds only after the actual stop and every admitted raw call, start, reconciliation, and listener settle. An already-started stop can finish after observation times out, without renewing effect authority. A delayed start cannot overlap stop, and exhaustion prevents initiating a later stop. Failed actual cleanup retains the runtime lock and dependent stores. Neither timeout nor local shutdown proves remote retirement or captures a missing durable lifecycle receipt.

External lifecycle readiness configuration is separate from the adapter's logical operation deadline. SDK `readinessTimeoutMs`, when explicitly supplied, must be an integer from 4,000 through 60,000 ms and is not rewritten after authorization waits. Adapter create/resume and catalog calls leave it absent and pass their finite operation budget separately; a short budget or the 180-second turn default is never sent as an invalid SDK readiness value.

After an admitted public lifecycle mutation returns, the runtime delivers its outcome to the durable owner without another lease or registration await. A revoked lease must not hide an already-created session identity or close acknowledgement. This receipt alone grants no attachment, prompt, publication, or retirement authority: those require their separate current, purpose-specific fences. List disclosure remains fenced after the public read. A production create whose lease is revoked during the effect retains its exact acknowledgement as uncertain canonical evidence, including after reopen, without sending a prompt.

Branch and create/resume control receipts likewise bind to the immutable admitted source: a same-tenant predecessor replacement during the mutation cannot erase the returned identity. The canonical operation retains its acknowledgement (and successor for create/fork) before rejecting renewed predecessor currentness; no adoption, prompt, or publication follows, and reopen preserves uncertainty without another mutation. Pre-invocation replacement still prevents dispatch. This receipt retention is not original-incarnation recovery or cleanup authorization.

For branch, `session.new`, and selected `session.resume` operations that have already timed out into canonical uncertainty, the original runtime invocation can still retain a late success as a write-once passive observation. It binds the reserved operation, original source, request identity, and payload without changing lifecycle state or granting successor authority. Selected resume observations must match the original exact session and generation and retain the validated original `endpointReceipt` when present; missing-pair acknowledgement remains uncertain and cannot gain renewed proof. Scoped storage rejects conflicting observations and preserves exact duplicates without rewriting the document. Raw outcome delivery remains owned through actual disposal; a persistence failure rejects disposal and retains exclusion. Renewed proof is a separate callback and cannot follow passive capture.

Initial session creation retains late success in a distinct provisional-only observation, bound to the original invoking reservation and complete prepared tenant/workspace/lease/key identity. It never invents a predecessor or copies the returned session/generation into a routable binding. The operation and lifecycle remain uncertain; missing/replaced reservations and storage failures retain disposal failure rather than reconstructing an owner. Cancellation after invocation preserves that reservation. Startup snapshots caller data and callbacks, and proof admission stays separate from original receipt delivery. Unpublished-session cleanup, temporary model-reader ownership, and interrupted-bootstrap recovery remain incomplete; neither kind of passive observation authorizes recovery or cleanup.

Successor creation shares a finite budget across source admission, invocation and acknowledgement callbacks, fork, target proof, publication callback, and cleanup. The enclosing branch also owns one configured budget through the subsequent transaction, state read, continuation, and final mapping write; remaining time reaches the successor and continuation rather than restarting their defaults. Delayed callbacks cannot publish after expiration. Model setters and prompts retain their caller's synchronous dispatch fence as well as the inner runtime fence, preventing a nested timer from admitting work after the original operation expires. These bounds and durable receipts do not complete exact-close effect ownership, durable cleanup, or crash recovery.

Live queries, requests, prompt acquisition, and retirement observation also pass their remaining budget into runtime proof calls and check it before starting the next effect. Standalone attachment acquisition is bounded; an expired post-dispatch cancellation cannot create a renewed one-millisecond abort attempt.

Create/resume and ordinary controls share their configured budget through transaction admission, remote effects, final attachment proof, and canonical publication. Delayed publication callbacks recheck the original deadline and predecessor before writing. Timeout before invocation discards the uninvoked reservation; after invocation it retains uncertainty, while an already committed result remains replayable. The managed operation owns dispatch-aware cancellation: the routing gateway does not send a second abort or send one for a pre-aborted request.

Managed session startup bounds pre-prompt binding, final publication, failure-owner callbacks, and cleanup within its original creation/prompt budget. Its lifecycle transaction rejects writes after that budget closes, cleanup receives only remaining time, and a failed failure-owner callback retains both errors. Once final publication begins, failure cannot trigger remote session cleanup because a local commit may already have happened. These fences do not provide the missing durable cleanup or original-incarnation recovery proof.

Model catalog queries use the same complete-page collector as live queries: incomplete pages need a nonrepeating continuation cursor, with 256-page and 100,000-item limits. One factory-owned budget covers context/lease admission, resolution, runtime acquisition or temporary creation, every catalog query, and final disposal. Both production paths receive the configured turn timeout; queries and stop cannot renew it. A stopped reader rejects new or late results, and repeated stop calls retain the original shutdown failure. Cancellation observes an already-admitted temporary create within the remaining budget and awaits any known-target cleanup rather than swallowing a detached cleanup failure; expiration starts no later cleanup. Durable receipts and source-bound catalog cleanup reservations are implemented, but temporary catalog provisioning remains denied pending complete reader/runtime effect ownership, exact-close dispatch, and recovery integration; these deadline fixes do not enable it.

Managed model readers register actual settlement with their owner before admission. A reader-specific accounting scope retains original resolver/fence work and raw SDK producers beneath deadline races, without stopping the shared Router or borrowing another reader's work. A bounded failure cannot release a chat/catalog workspace lease while that settlement is pending; later fulfillment permits release, while receipt persistence or required temporary-cleanup failure retains exclusion. The HTTP result may report uncertainty before cleanup settles. Same-reference lease renewal does not renew SDK effect permission. This is not a durable temporary-session journal, exact-close capability, or cross-process crash-recovery proof.

`--bootstrap` exercises the restricted adapter coordinator against the real public SDK and an owned durable workspace lease. It reopens ordinary V3 staging before creating a Router, selects the exact saved session publicly, persists one manifest/occurrence-bound intent before resume, retains acknowledgement before adoption checks, and commits that same staged journal without rewriting old results. Add `--bootstrap-history` for committed reassignment with two-level tombstone history, and `--bootstrap-unscoped` for the configured-admin owner rule. An existing historical principal takes precedence; only genuinely unowned history uses the exact configured administrator. Missing/invalid owners, conflicting identities, occupied destinations, and unavailable existing project/workspace/lease authority block before SDK construction. Promotion atomically gives the live root its canonical `[principal, chat]` key while preserving historical child identities. A unique completed bootstrap receipt binds historical results, tombstones, and completed provisional aliases to that live owner; no parallel index or post-activation administrator fallback supplies authority.

Completed reassignment/provisional receipts remain historical; only the current occurrence receives live proof. Missing reassignment completion, unresolved tombstone operations, and every noncomplete provisional (including unassigned ones) block before SDK construction. Private snapshot replay uses a stable source-observation time for local reassignment rollback, so unchanged base/WAL snapshots reproduce the same historical checkpoint on retry. This local rollback never proves an unresolved destination effect was not applied. An uninvoked prepared intent retains its original owner/lease/key/hash across retry; invoked or uncertain work is not redispatched. A final synchronous attachment/lease check precedes replacement. The bootstrap Router stops before the coordinator returns; it never supplies serving capabilities. Interrupted incarnation recovery remains blocked. This internal coordinator is not yet an operator provisioning command and does not enable V2 serving startup. The obsolete flat-bootstrap store and server hook have been removed; canonical V3 alone owns the staged graph and lifecycle journal.

The internal bootstrap attempt exposes a budget-bounded `result` separately from `settled`, which succeeds only after pending admission, local Router stop, owned admission-resource release, and mutation-lock release. A timed-out result cannot authorize releasing the outer runtime lock. Optional admission runs once after all offline candidates validate in the reopened historical stage; repeated authority resolution never acquires a replacement lease. The public bootstrap probe now acquires its migration lease at that post-stage boundary. This is not yet production operator admission or a serving handoff: expiring a migration lease at command exit would invalidate the persisted live lease, and the original-incarnation recovery limitation remains.

Original historical resume outcomes, including a valid raw `endpointReceipt`, are durably captured inside the tracked SDK producer, before renewed proof or deadline checks. The same live invocation retains its staged journal and storage exclusions until acknowledgement/uncertainty persistence settles, even after its bounded result expires. A receipt can outlive effect admission but cannot renew it: no late adoption, publication, cleanup or retry follows. Replaced source snapshots, stage identity, manifest or lock ownership reject actual settlement; expired-but-identically-owned storage exclusion permits only this passive write. A reopened or already-uncertain invocation cannot obtain that receipt handle. Missing-pair acknowledgements retain the actual session/generation as uncertain without renewed proof. This persistence is not cross-process recovery, cleanup authorization, or a serving handoff.

Historical selection checks synchronous purpose authority immediately before public listing and before returning its saved-session receipt. Resume validates the retained operation asynchronously, then consumes its one invocation permission at the synchronous dispatch boundary. Both initial and repeated bootstrap admission snapshot identity and receiver-bound lease callbacks before awaiting validation; cleanup-pending or revoked leases cannot authorize SDK effects. Final admission verifies retained stage, manifest, checkpoint and snapshot ownership, rejecting even identical-byte file replacements before effects. Runtime state and deadline are checked again after synchronous callbacks. These admission checks never suppress an already-dispatched original outcome's passive persistence.

Installed initialization and configured-server startup failures share the same cleanup path: stop the runner, await actual managed-runtime disposal, then clean dependent stores. Server startup failure and normal shutdown enforce the same disposal prerequisite for dependent cleanup callbacks. The runtime lock is released only when every cleanup step succeeds; disposal failure retains both dependent resources and exclusion. The original startup error remains part of any aggregate cleanup failure.

The internal batch admission owner now validates existing linked projects and registered principal workspaces before acquiring any migration lease. It projects execution cwd/sessionRoot without rewriting source registrations or historical identity, shares one real lease per workspace, and resolves only this attempt's retained handles. Registry/project/workspace replacement, cleanup-pending state, cancellation or lease loss revokes authority; a new owner rejects retained intents rather than reacquiring or renewing them. Release closes admission immediately and retains late acquisitions through actual cleanup, preserving any release failure. The public bootstrap probe uses this concrete owner. It is not connected to installed startup and does not provide a serving lease/Router handoff or original-incarnation recovery.

## CLI first-install configuration

Choose the route before running a command:

| Route | Choose it when | Ownership |
| --- | --- | --- |
| `managed` | Rootful Docker is available and Docker userns-remap is disabled; both CLI-managed routes require user systemd and OpenWebUI >=0.10.0 | GJC owns the generated OpenWebUI deployment and configures its owned provider after adapter readiness |
| `existing` | Rootless Docker or Docker userns-remap incompatibility, or an externally operated OpenWebUI deployment that meets the shared requirements | OpenWebUI, provider connection, custom headers, ingress, and their operation remain external |

Both CLI-managed routes require user systemd and OpenWebUI >=0.10.0; existing mode is not a fallback for missing shared prerequisites. Choose existing mode for rootless or userns-remapped Docker, or for an externally operated OpenWebUI deployment that meets those shared requirements. These commands configure a deployment; this README does not claim to run or verify a real deployment. Run the packaged binary (or replace it with `bun src/cli.ts` from a checkout). Run `openwebui-gjc-adapter --help` and the route-specific help for first-install guidance. Route help documents required first-install inputs and prerequisites; it is not an authoritative complete reference for every accepted operational or recovery flag.

### Managed route

Managed setup requires two distinct inherited decimal file descriptors for the setup-only admin email and password. Open the files in the invoking shell; never put credential values in argv, environment, generated configuration, logs, or examples:

```sh
exec 3<"$ADMIN_EMAIL_FILE"
exec 4<"$ADMIN_PASSWORD_FILE"
openwebui-gjc-adapter configure managed \
  --admin-email-fd 3 \
  --admin-password-fd 4
exec 3<&-
exec 4<&-
```

The managed deployment uses OpenWebUI v0.11.0 by default (while accepting existing deployments on OpenWebUI >=0.10.0), rootful Docker, userns-remap disabled, user systemd, a loopback-only UI, and a private adapter network. It configures only its strictly owned OpenWebUI provider after the adapter is ready. GJC provider authentication and model onboarding remain GJC-owned. The managed path does not automate Tailscale, tunnels, public ingress, or other exposure outside the loopback-safe boundary.

### Existing route

Existing setup requires the OpenWebUI URL, an adapter ingress URL reachable from OpenWebUI, one inherited decimal FD for the OpenWebUI administrator token, and an allowed source parent for project links. Set `--project-root` to the operator-owned parent containing linkable projects (for example, `/home/me/src`); linked paths must be inside that configured root. The configuring user must be able to read and search each project directory. An existing session root needs read/write/search access; a prospective root such as the default per-project session root (`<cwd>/.gjc/sessions`) needs write/search access on its nearest existing ancestor. These permissions are checked before project registration.

```sh
exec 3<"$OPENWEBUI_API_TOKEN_FILE"
openwebui-gjc-adapter configure existing \
  --openwebui-url "https://openwebui.example" \
  --adapter-ingress-url "http://adapter.example:8765" \
  --openwebui-api-token-fd 3 \
  --project-root "/home/me/src"
exec 3<&-
```

The adapter validates the supplied OpenWebUI administration token but does not mutate an externally owned provider or ingress. Configure the OpenAI-compatible provider, its custom headers, and its operation manually:

```env
OPENAI_API_BASE_URL=http://adapter.example:8765/v1
OPENAI_API_KEY=<adapter-openai-key>
ENABLE_OPENAI_API=True
```

Add the custom headers shown in [OpenWebUI setup](#openwebui-setup). The adapter ingress URL must be reachable from the OpenWebUI process, not merely from the operator's shell.

### Readiness and first usable model

Treat route configuration and model availability as separate stages:

1. Run `openwebui-gjc-adapter probe-ready`. This verifies adapter/OpenWebUI readiness, including the adapter's OpenWebUI access; it does not verify GJC provider credentials, a usable model catalog, or a successful GJC turn.
2. Complete provider authentication through GJC in the effective runtime. Do not add provider credentials to `configure`.
3. Verify that `/v1/models` returns one or more canonical routing ids such as `gjc/<encoded-provider>/<encoded-model>:<thinking>`, then select one in OpenWebUI and complete a first turn. The OpenWebUI-visible `name` is display-only: `openai-codex` models are shortened to `codex/<model>:<thinking>`, while their `id` remains canonical for routing. `/v1/models` filters models by GJC's active credential or credentialless provider catalog when that SDK query is available; GJC SDK versions that omit that query treat their `models.list/current` catalog as authoritative. It fails closed when neither source yields a valid catalog. OpenWebUI picker values may add one `<connection-id>.` prefix, which the adapter removes before validation.
4. Link/select a project chat after the selected model completes successfully.

For managed mode, the generated Compose adapter service uses the configuring process's rendered numeric UID:GID, while retaining effective `HOME=/var/lib/gjc/home`, GJC config `/var/lib/gjc/home/.gjc`, and agent state `/var/lib/gjc/home/.gjc/agent`; these persist in the managed state mount. After the generated Compose file is available, use the installed GJC executable in that container:

```sh
CONFIG_PATH=/path/to/openwebui-gjc-adapter/config.json
docker compose -f "${CONFIG_PATH}.compose.yml" -p openwebui-gjc-adapter \
  exec -it adapter /opt/openwebui-gjc-adapter/node_modules/.bin/gjc /login
```

For existing mode, perform GJC's supported onboarding (for example, `gjc /login`) under the same user as the generated user-systemd service and with the exact effective `HOME`, `GJC_CONFIG_DIR`, and `GJC_CODING_AGENT_DIR` from that unit. Inspect the generated `.service` file and run against its values; ambient host GJC variables are not equivalent and must not silently select another runtime.

An unavailable or empty catalog, noncanonical model id, or provider-auth failure on the first turn is GJC provider/model onboarding recovery. Correct that effective runtime and retry the onboarding/check; do not rerun configuration merely because `probe-ready` succeeded. The CLI may reset or disclose an adapter token only with a controlling TTY, so a token is not accidentally written to redirected output or unattended logs.

### Model selection, profiles, and roles

The OpenWebUI picker maps to GJC `DEFAULT`: selection is persisted as the shared agent-domain default and promoted in the currently attached session. It is not profile/preset selection, profile activation, or an all-role assignment. The adapter UI does not support selecting or activating GJC model profiles, forwarding profile options, configuration patching, or runtime reload. The bare `gjc` alias is input-only; `/v1/models` emits canonical routing ids and display-only names.

GJC 0.15.0 may still activate an already-persisted `modelProfile.default` when a new GJC process starts. That startup behavior is GJC-owned and does not mean the adapter can select a profile.

To change role models, tell GJC what to persist in a normal OpenWebUI message. For example:

```text
Set EXECUTOR to <provider>/<model>:<effort>,
PLANNER to <provider>/<model>:<effort>,
CRITIC to <provider>/<model>:<effort>, and
ARCHITECT to <provider>/<model>:<effort>.
Use the supported persistent GJC configuration, do not change DEFAULT or any
model profile, then read back and report all saved role assignments.
```

OpenWebUI messages are SDK prompts, not interactive GJC CLI input, so do not rely on typing `/model ...` or `/model roles` into the chat. GJC applies the requested `task.agentModelOverrides`; the adapter does not add a separate preset UI.

No adapter restart or new GJC session is required for these role changes in the instructed live session. Later task-agent launches resolve the saved override, while already-running or in-flight agents do not switch. Other already-live GJC processes are not guaranteed to reload shared settings. Starting a new GJC process/session is only the conservative boundary for loading changed startup profile/default state; restarting the adapter alone is not a GJC reload. If `modelProfile.default` is configured, ask GJC to explain the profile conflict before changing it because a new process can apply that profile's assignments.

### Safety and recovery

Both paths preserve the loopback-safe boundary: the UI is not exposed by the CLI, and the adapter remains on its private network where applicable. If route configuration fails, correct the reported local configuration or setup credentials and rerun the relevant route command. If provider/model verification fails, recover GJC onboarding in the effective runtime instead.

### GJC runtime locations and recovery

Existing installations accept exactly two direct runtime-location flags: `--gjc-config-dir-name NAME` and `--gjc-coding-agent-dir PATH`. Direct values are persisted. Runtime resolution uses persisted installed values, then adapter-namespaced environment values, then derived defaults. The namespaced selectors are `GJC_OPENWEBUI_GJC_CONFIG_DIR_NAME` and `GJC_OPENWEBUI_GJC_CODING_AGENT_DIR`. Managed configuration rejects both runtime-location flags because its runtime locations are fixed below `/var/lib/gjc/home`.

Ambient `GJC_CONFIG_DIR`, `PI_CONFIG_DIR`, and `GJC_CODING_AGENT_DIR` do not select shipped SDK runtime locations. Each child receives the resolved `HOME`, `GJC_CONFIG_DIR`, and `GJC_CODING_AGENT_DIR`; inherited `PI_CONFIG_DIR` is removed. XDG variables remain inherited but do not select or relocate these paths.

Recovery preserves the legacy vector when neither location field is present and records config-name only, agent-directory only, and both fields together when locations are explicit. A pending recovery journal is authoritative: a retry may omit both flags to resume the recorded values, while a differing retry is rejected before configuration, journal, reset, or deployment writes.

## Registering projects

Register one project per working directory. The adapter validates the real path against an allowed root before exposing the project as an OpenWebUI folder/projection.

For the service entrypoint, set `GJC_OPENWEBUI_PROJECTS` to a semicolon-separated list of `cwd|name|folderId|sessionRoot` entries. Only `cwd` is required; configured paths must resolve under `GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS`.

```ts
import { registerProjectDirectory, resolveAllowedRoots } from "openwebui-gjc-adapter";

const allowedRoots = await resolveAllowedRoots(["/home/me/src"]);
const project = await registerProjectDirectory(
  {
    cwd: "/home/me/src/my-repo",
    name: "my-repo",
  },
  allowedRoots,
);
```

Project folders are not advertised as models; the adapter resolves the GJC working directory from the OpenWebUI chat folder. Historical imports place projected sessions under folder id `gjc-project-<project-id>` and chat id `gjc-project-<project-id>-session-<session-id>` unless OpenWebUI assigns runtime ids.

The project guard protects exactly four resolved GJC paths: `configDomain`, `agentDir`, `readerWorkspace`, and `readerSessionRoot`. A project `cwd` or explicit `sessionRoot` is rejected when it is equal to, an ancestor of, or a descendant of any one of them. The guard does not cover adapter state, mappings, session stores, or SQLite.

Use OpenWebUI 0.10.0 or newer so chat/message/task placeholders are available. The adapter uses the released public SDK only for supported session attachment and actions. Background task calls such as title generation are no-ops and must not create GJC sessions.

### GJC routing matrix

| Operation | Primary route | Fallback and ownership |
| --- | --- | --- |
| Session attachment, turns, model selection, gates, and events | Released public GJC SDK | No fallback. Missing, malformed, or ambiguous SDK authority fails closed. |
| Session create/resume/fork | Public lifecycle service | Durable intent and exact principal/project/workspace/chat/session/generation/lease/epoch proof are required before publication. No CLI or transcript discovery fallback. |
| Runtime shutdown | Local `SessionRouter.stop()` | Local stop is not `session.close`, never proves retirement, and never terminates a remote session. |
| Session close | Public lifecycle service plus positive exact-generation retirement | Original lifecycle pairs are durably retained and source-bound reservations are implemented. Scoped production reaper paired-close ownership is verified; interactive/admin and opportunistic close remain denied or unwired, and aggregate cutover remains held. Missing original authority never permits a session-ID-only close. |
| Regenerate/branch | Persisted owner, project, session, and message lineage | Direct adapter controls require matching persisted lineage; the stock OpenWebUI v0.11 regenerate/fork UI does not forward its request metadata to an OpenAI-compatible provider, so the adapter never infers a branch from that UI action. Missing, conflicting, or ambiguous authority is rejected without fork, replay, or fallback. |
The same exact-proof close applies to admin close, idle reaping, and adapter-created temporary catalog sessions. No CLI, pane, process, or private API fallback is available when public close authority is missing.

The adapter does not use private daemon, global broker, private protocol, or GJC database interfaces.

Inside OpenWebUI, the configured administrator can send these slash-style commands in a `gjc` chat for project administration:

```text
/gjc project link /home/me/src/my-repo
/gjc project list
/gjc project unlink my-repo
```

The adapter seeds only normal-user-safe workflow prompts globally:

```text
/skill:deep-interview {{REQUEST}}
/skill:ralplan {{TASK}}
/skill:ultragoal {{GOAL}}
/skill:team {{TASK}}
```

Deleting an adapter-created project folder in the OpenWebUI sidebar is treated as an unlink of the OpenWebUI projection only. Local folders, `.gjc` sessions, and GJC history are not deleted. If the same project path is linked again later, the adapter imports the existing session history again.

## Runtime contract

Canonical routing model ids use `gjc/<encoded-provider>/<encoded-model>:<thinking>`. Provider and model components use uppercase RFC 3986 percent-encoding; each component must decode exactly once and re-encode to the same bytes. Providers containing `/` are rejected because upstream `model.set` uses the first slash as its provider/model boundary, while model ids may contain `/`, `:`, and Unicode and are encoded normally. The bare `gjc` alias is accepted only as input and is never emitted. The optional OpenAI-compatible model `name` is display-only; exact provider `openai-codex` is shown as `codex/<model>:<thinking>`, but no request path accepts that label as model authority. Catalog, JSON, SSE, workflow, event, and persisted mapping output use the normalized tuple returned by GJC.

Selection updates the machine-global last-successful-writer-wins default. Operations are serialized per stable client, but the adapter does not provide global request ordering or a distributed ordering guarantee. The adapter invokes the setter once and does not retry, compensate, or roll it back. It also does not roll back an already committed project link or unlink if the later model-selection read needed for the response fails.

- GJC session history and artifacts remain authoritative.
- OpenWebUI chat rows and chat messages are projection/cache records.
- Adapter metadata is stored under `gjc_adapter`; user-visible OpenWebUI fields such as title/rating are preserved on reprojection.
- The live gateway uses `/v1/models` and `/v1/chat/completions`.
- The package entrypoint wires chat completions through the released public SDK session surface and stores OpenWebUI chat-to-GJC session mappings in a file-backed store under `GJC_OPENWEBUI_SESSION_ROOT`.
- The adapter consumes correlated public SDK session events and correlates prompt completion by command and turn identity. A successful control response acknowledges dispatch, not semantic completion: publication waits for matching `agent_end.finalText` or a unique durable workflow gate established by a correlated ask event and public gate query. Delivered session events are bounded OpenWebUI message events covering available lifecycle, tool/MCP, subagent, todo, goal, notice, retry, compaction, and workflow progress.
- Streaming responses forward native GJC reasoning and assistant text deltas as they arrive. Lifecycle/progress events are delivered concurrently; OpenWebUI delivery failures are best-effort and do not invalidate a turn already accepted by GJC.
- A turn failure is surfaced before a successful stream is exposed when no activity has started. After streaming starts, terminal failure is propagated through the stream. Completion is accepted only from the correlated final for the referenced session.
- Native terminal events retain their observed order. Live completion never rediscovers transcript or descriptor authority; missing terminal evidence remains uncertain. Historical transcript imports remain projection-only and cannot authorize live session operations.
- Raw tool arguments/results and secret-looking text are not emitted directly; the adapter preserves bounded labels, counts, phases, and status descriptions for display.
- Workflow gates are rendered as assistant-visible pending-gate text. A matching user reply is validated against the persisted gate schema and resumed through the public SDK session; replies that do not match the stored project, session, message lineage, or gate correlation fail closed.
- Direct adapter branch controls require matching persisted owner, project, session, and message lineage. OpenWebUI v0.11's stock regenerate/fork UI does not forward its request metadata to OpenAI-compatible providers, so the adapter never infers a branch from that UI action. Missing, conflicting, or ambiguous authority is rejected without fork, replay, or fallback.

## Operator notes

Keep the adapter session/project store on persistent storage. Do not give the adapter an allowed root broader than the directories intended for GJC operation. Artifact links are resolved with realpath containment and symlink escapes are rejected.
## OpenWebUI visual smoke test

With OpenWebUI and the adapter already running, use the focused Chromium smoke test to verify the real UI boundary:

```sh
GJC_OPENWEBUI_E2E_MODEL='gjc/<provider>/<model>:<thinking-level>' \
GJC_OPENWEBUI_E2E_PROMPT='Use the read tool on /absolute/path/to/package.json, then reply with the package name. Do not skip the tool call.' \
GJC_OPENWEBUI_E2E_EXPECTED_TEXT='your-package-name' \
bun scripts/gjc-openwebui-e2e.ts
```

Use an absolute readable fixture path: a new chat without a mapped project runs in the neutral reader workspace, so a relative `package.json` is not the repository you launched the smoke command from. Set `GJC_OPENWEBUI_E2E_URL`, `GJC_TRUSTED_CHROMIUM_EXECUTABLE`, and OpenWebUI credentials when the local defaults do not apply. Set `GJC_OPENWEBUI_E2E_EXPECTED_VERSION` to require an exact target release, and `GJC_OPENWEBUI_E2E_SOURCE_HASH` to bind a saved transcript to a frozen source revision. The smoke test dismisses the v0.11 release-notes dialog, selects the configured model through the real UI, requires a newly rendered expected response and a post-submit native Socket.IO event, and writes a screenshot to `/tmp/gjc-openwebui-smoke.webp` by default. Set `GJC_OPENWEBUI_E2E_TRANSCRIPT` to persist the validated browser automation transcript.
