# OpenWebUI GJC Adapter

Experimental TS/Bun adapter that treats GJC session JSONL/artifacts as the source of truth and projects them into OpenWebUI folders, chat history trees, message events, and an OpenAI-compatible live gateway.

## OpenWebUI setup

Start the adapter service with Bun:

```sh
GJC_OPENWEBUI_BIND_HOST=127.0.0.1 \
GJC_OPENWEBUI_BIND_PORT=8765 \
GJC_OPENWEBUI_ADAPTER_API_TOKEN=<adapter-openai-key> \
GJC_OPENWEBUI_API_TOKEN=<openwebui-api-token> \
GJC_OPENWEBUI_OWNER_USER_ID=<openwebui-user-id> \
GJC_OPENWEBUI_PROJECTS="/home/me/src/my-repo|my-repo" \
GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS="/home/me/src" \
bun run start
```

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

Use OpenWebUI 0.10.0 or newer so chat/message/task placeholders are available. The adapter and managed image use the published `@gajae-code/ai`, `@gajae-code/bridge-client`, `@gajae-code/coding-agent`, and `@gajae-code/natives` `0.11.6` release. The image runs the published `gjc` executable as the non-root `adapter` user, including `tmux`; it does not build a private broker or apply an upstream source patch. Background task calls such as title generation are no-ops and must not create GJC sessions.

## CLI first-install configuration

The CLI supports two first-install paths. These commands configure a deployment; this README does not claim to run or verify a real Docker deployment.

### Managed default path

Use `configure managed` for a new, CLI-managed installation. It targets Docker with OpenWebUI v0.10.0, binds the OpenWebUI UI to loopback only, and places the adapter on a private Docker network. Credentials are passed by file descriptor rather than written into generated configuration. The command verifies that the configured OpenWebUI provider is strictly owned by the installation before accepting it.

The managed path intentionally does not automate Tailscale, tunnels, public ingress, or other exposure outside the loopback-safe boundary. Publish the UI separately only after reviewing the network and authentication model.

### Existing path

Use `configure existing` for an existing OpenWebUI deployment. It validates the supplied OpenWebUI admin token, but does not mutate externally managed provider or ingress configuration. Configure the OpenAI-compatible provider manually with:

```env
OPENAI_API_BASE_URL=http://127.0.0.1:8765/v1
OPENAI_API_KEY=<adapter-openai-key>
ENABLE_OPENAI_API=True
```

OpenWebUI requests may use the input-only `gjc` alias or a canonical model id from `/v1/models`. Add the custom headers shown in [OpenWebUI setup](#openwebui-setup). The placeholders in those headers are required for the adapter to associate requests with the OpenWebUI chat, messages, user, and task.

### Safety and recovery

The CLI uses a readiness probe before reporting configuration as ready. It may reset or disclose an admin token only when it has a controlling TTY, so a token is not accidentally written to redirected output or unattended logs. If readiness or verification fails, correct the reported local configuration or credentials and rerun the relevant command; do not treat a partially configured deployment as ready.

Both paths preserve the loopback-safe boundary: the UI is not exposed by the CLI, and the adapter remains on its private network where applicable.

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
| CLI lifecycle | Published `gjc` CLI | Only create, cold JSONL resume, readiness, and close of an exactly proven owned pane. It never supplies turns, models, events, gates, or an endpoint. |
| Transport detach | Local transport only | Detach is not `session.close` and never terminates a remote session. |
| Session close | Published `gjc` CLI `/exit` | For an exact persisted descriptor plus receipt-owned tmux pane/PID/tag, the adapter sends `/exit` first and requires endpoint disappearance and absence of the original pane PID. It never invokes released public `session.close` to terminate an owned CLI lifecycle. Missing pane proof fails closed without a kill or fallback. |
| Regenerate/branch | Persisted owner, project, session, and message lineage | Any missing, conflicting, or ambiguous authority fails closed; the adapter does not fork or replay the operation. |
The same exact-proof close applies to admin close and adapter-created temporary catalog sessions. Logical SDK attachment eviction occurs only after physical close proof; there is no destructive fallback after `/exit`.

The adapter does not use private daemon, global broker, private protocol, or GJC database interfaces.

Inside OpenWebUI, send these slash-style commands in a normal `gjc` chat for project administration:

```text
/gjc project link /home/me/src/my-repo
/gjc project list
/gjc project unlink my-repo
```

The adapter also seeds OpenWebUI Workspace Prompt hints for those project commands and for canonical GJC workflows:

```text
/skill:deep-interview {{REQUEST}}
/skill:ralplan {{TASK}}
/skill:ultragoal {{GOAL}}
/skill:team {{TASK}}
```

Deleting an adapter-created project folder in the OpenWebUI sidebar is treated as an unlink of the OpenWebUI projection only. Local folders, `.gjc` sessions, and GJC history are not deleted. If the same project path is linked again later, the adapter imports the existing session history again.

## Runtime contract

Canonical model ids use `gjc/<encoded-provider>/<encoded-model>:<thinking>`. Provider and model components use uppercase RFC 3986 percent-encoding; each component must decode exactly once and re-encode to the same bytes. Providers containing `/` are rejected because upstream `model.set` uses the first slash as its provider/model boundary, while model ids may contain `/`, `:`, and Unicode and are encoded normally. The bare `gjc` alias is accepted only as input and is never emitted. Catalog, JSON, SSE, workflow, event, and persisted mapping output use the normalized tuple returned by GJC.

Selection updates the machine-global last-successful-writer-wins default. Operations are serialized per stable client, but the adapter does not provide global request ordering or a distributed ordering guarantee. The adapter invokes the setter once and does not retry, compensate, or roll it back. It also does not roll back an already committed project link or unlink if the later model-selection read needed for the response fails.

- GJC session history and artifacts remain authoritative.
- OpenWebUI chat rows and chat messages are projection/cache records.
- Adapter metadata is stored under `gjc_adapter`; user-visible OpenWebUI fields such as title/rating are preserved on reprojection.
- The live gateway uses `/v1/models` and `/v1/chat/completions`.
- The package entrypoint wires chat completions through the released public SDK session surface and stores OpenWebUI chat-to-GJC session mappings in a file-backed store under `GJC_OPENWEBUI_SESSION_ROOT`.
- The adapter consumes correlated public SDK session events and correlates prompt completion by command and turn identity. Delivered session events are bounded OpenWebUI message events covering available lifecycle, tool/MCP, subagent, todo, goal, notice, retry, compaction, and workflow progress.
- Raw tool arguments/results and secret-looking text are not emitted directly; the adapter preserves bounded labels, counts, phases, and status descriptions for display.
- Workflow gates are rendered as assistant-visible pending-gate text. A matching user reply is validated against the persisted gate schema and resumed through the public SDK session; replies that do not match the stored project, session, message lineage, or gate correlation fail closed.
- Regenerate/branch requires matching persisted owner, project, session, and message lineage authority. Missing, conflicting, or ambiguous authority is rejected without fork, replay, or fallback.

## Operator notes

Keep the adapter session/project store on persistent storage. Do not give the adapter an allowed root broader than the directories intended for GJC operation. Artifact links are resolved with realpath containment and symlink escapes are rejected.
## OpenWebUI visual smoke test

With OpenWebUI and the adapter already running, use the focused Chromium smoke test to verify the real UI boundary:

```sh
GJC_OPENWEBUI_E2E_MODEL='gjc/<provider>/<model>:<thinking-level>' \
bun scripts/gjc-openwebui-e2e.ts
```

Set `GJC_OPENWEBUI_E2E_URL`, `GJC_TRUSTED_CHROMIUM_EXECUTABLE`, and OpenWebUI credentials when the local defaults do not apply. The smoke test selects the configured model through the real UI, submits a prompt that requires the `read` tool, and requires visible thinking/tool completion plus a native Socket.IO event. It writes a screenshot to `/tmp/gjc-openwebui-smoke.webp` by default.
