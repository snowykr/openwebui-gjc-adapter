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

Use OpenWebUI 0.10.0 or newer so chat/message/task placeholders are available. Production serving uses the public managed SDK from `@gajae-code/coding-agent` 0.16.4, pinned with matching `@gajae-code/ai` and `@gajae-code/natives` versions from the npm registry. Both `managed` and `existing` startup modes require a pre-existing canonical managed V3 authority and active marker before any state, lock, database, outbox, runtime, or listener effect; absent, V2, malformed, or unmarked authority fails closed. The marker admits its activation epoch without freezing ordinary mutable V3 persistence. Public `SessionRouter.generationStatus` must positively prove exact-generation retirement; attachment absence alone never proves close. The image uses pinned Bun 1.4.0 and the installed registry `gjc` executable as the non-root `adapter` user. Historical dev-package contract evidence is retained separately from the runtime dependency. The legacy bridge transport, descriptor-backed lifecycle, and tmux container dependency are removed; aggregate cutover approval still depends on the exact-close contract gap below. Background task calls such as title generation are no-ops and must not create GJC sessions.

SDK 0.16.4 does not expose the opaque incarnation needed for a replacement-safe remote close through its public Router/lifecycle binding surfaces. A generation alone is rejected by the SDK; closing by session ID and checking retirement afterward can close a replacement. The adapter therefore fails closed on remote close without complete exact authority. The isolated compatibility harness proves positive retirement only, not replacement-race-safe production close.

Canonical V3 operations retain lifecycle intent, acknowledgement, and exact-generation proof alongside the full routing journal. Adoption-only proof cannot authorize prompts, queries, or subscriptions; active work requires durable generation proof and a live tenant lease. Idle retirement uses a fresh reaper lease against the unchanged historical generation, persists a successful matching close acknowledgement before observation, and commits positive retirement with its journal result atomically. A retryable label, lost attachment, or changed turn ID does not reactivate that generation. Interrupted operations retain their request identity and remain blocked for reconciliation; this does not yet provide the original staged-bootstrap or automatic same-key recovery contract.

Idle retirement shares one finite budget across the entire scan, admission, lease acquisition, close, observation, and local publication. Late admission or lease grants are released without dispatching a close. The inactive migration implementation requires real runtime-root and mutation-lock ownership, captures immutable base/WAL evidence before private replay, and recovers a proven V3 replacement forward without restoring V2 or overwriting external replacements. Private replay retains acknowledged WAL-only updates and completed event history. These safeguards do not enable V2 startup or complete the restricted staged-bootstrap contract.

Generation-free historical nodes now round-trip through ordinary V3 storage, including scoped journal results, provisionals, successors, and tombstone chains. Historical bindings retain source provenance but contain no invented generation, lease, or request key; a proof applies only to its exact source occurrence, never every result sharing a session ID. Session-file paths and active-leaf values remain inert projection metadata. Unbound live roots block startup before public SDK effects, while normal tenant-scoped history lookup remains available inside the store. Migration reopens the private historical V3 stage before resolving bindings; the restricted public bootstrap and same-key recovery are still incomplete.

Direct V3 startup uses one finite configured turn budget across Router startup, mapping reconciliation, attachment/generation checks, the external lease fence, and failure cleanup. A timed-out phase cannot continue registering or publishing tenants. Private migration retains its historical stage under an immutable manifest-bound checkpoint; changed journal evidence blocks regeneration rather than being discarded on retry.

`bun scripts/gjc-saved-resume-compat.ts` exercises saved-session resume through the released public SDK in an isolated workspace. Bare `resume` with only a full session ID and workspace cannot resume a saved session; `resumeExternal` supplies the saved-session resolution. With `--exact`, the probe instead selects `savedSession` using public `list(resolveSessionId)` and passes that public path/identity to `resume`, without adapter filesystem discovery. Both modes check the returned identity/workspace, same-key outcomes from a fresh client process, foreign-workspace denial, and no same-key reactivation after retirement. Neither proves a saved-snapshot precondition, recovery of the original incarnation after replacement, broker-crash recovery, or production restricted-bootstrap authorization; refreshed same-key results must not be treated as such proof.

The additional `--exact --replacement` mode reproduces two SDK 0.16.4 recovery gaps: resume accepts a deliberately mismatched public snapshot hash, and an old request key acknowledges an independently resumed replacement with the same numeric generation. A successful run of this adversarial probe means the limitation was reproduced, not that production recovery is safe. Automatic uncertain bootstrap replay remains blocked.

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
| Session close | Public lifecycle service plus positive exact-generation retirement | Remote mutation requires the original generation/incarnation authority pair. SDK 0.16.4 does not publicly supply that incarnation; production close fails closed rather than targeting a replacement by session ID. |
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
