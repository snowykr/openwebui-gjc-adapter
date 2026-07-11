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

Use OpenWebUI 0.10.0 or newer so chat/message/task placeholders are available. Use `@gajae-code/coding-agent` 0.9.4 or newer so the adapter can consume `RpcClient.onSessionEvent` and project full GJC TUI/session progress into OpenWebUI. Background task calls such as title generation are no-ops and must not create GJC sessions.

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

Use the `gjc` model id and add the custom headers shown in [OpenWebUI setup](#openwebui-setup). The placeholders in those headers are required for the adapter to associate requests with the OpenWebUI chat, messages, user, and task.

### Safety and recovery

The CLI uses a readiness probe before reporting configuration as ready. It may reset or disclose an admin token only when it has a controlling TTY, so a token is not accidentally written to redirected output or unattended logs. If readiness or verification fails, correct the reported local configuration or credentials and rerun the relevant command; do not treat a partially configured deployment as ready.

Both paths preserve the loopback-safe boundary: the UI is not exposed by the CLI, and the adapter remains on its private network where applicable.

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

OpenWebUI should use the stable `gjc` model id. Project folders are not advertised as models; the adapter resolves the GJC working directory from the OpenWebUI chat folder. Historical imports place projected sessions under folder id `gjc-project-<project-id>` and chat id `gjc-project-<project-id>-session-<session-id>` unless OpenWebUI assigns runtime ids.

Use OpenWebUI 0.10.0 or newer so chat/message/task placeholders are available. The adapter uses full session events when the installed GJC RPC client exposes `onSessionEvent`; otherwise it falls back to the standard agent-event stream. Background task calls such as title generation are no-ops and must not create GJC sessions.
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

- GJC JSONL and artifacts remain authoritative.
- OpenWebUI chat rows and chat messages are projection/cache records.
- Adapter metadata is stored under `gjc_adapter`; user-visible OpenWebUI fields such as title/rating are preserved on reprojection.
- The live gateway uses `/v1/models` and `/v1/chat/completions`.
- The package entrypoint wires chat completions through the GJC RPC turn runner and stores OpenWebUI chat-to-GJC session mappings in a file-backed store under `GJC_OPENWEBUI_SESSION_ROOT`.
- The adapter uses full session events when the installed GJC RPC client exposes `RpcClient.onSessionEvent`; otherwise it safely falls back to the standard agent-event stream. Delivered session events are bounded OpenWebUI message events covering available lifecycle, tool/MCP, subagent, todo, goal, notice, retry, compaction, and workflow progress.
- Raw tool arguments/results and secret-looking text are not emitted directly; the adapter preserves bounded labels, counts, phases, and status descriptions for display.
- Workflow gates can be rendered as assistant-visible pending-gate text and validated with the exported gate primitives; wire those primitives into the deployment's event sink/continuation policy before claiming automatic gate approval handling.
- Regenerate/branch only proceeds when owner, project, session, and message lineage metadata match; otherwise the adapter forks safely.

## Operator notes

Keep the adapter session/project store on persistent storage. Do not give the adapter an allowed root broader than the directories intended for GJC operation. Artifact links are resolved with realpath containment and symlink escapes are rejected.
