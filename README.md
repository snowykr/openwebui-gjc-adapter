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
- With GJC 0.9.4 or newer, full session events from `RpcClient.onSessionEvent` are delivered as bounded OpenWebUI message events through the adapter event sink. This includes thinking lifecycle, tool/MCP execution, subagent messages, todo reminders, goal updates, notices, retry, compaction, and workflow progress.
- Raw tool arguments/results and secret-looking text are not emitted directly; the adapter preserves bounded labels, counts, phases, and status descriptions for display.
- Workflow gates can be rendered as assistant-visible pending-gate text and validated with the exported gate primitives; wire those primitives into the deployment's event sink/continuation policy before claiming automatic gate approval handling.
- Regenerate/branch only proceeds when owner, project, session, and message lineage metadata match; otherwise the adapter forks safely.

## Operator notes

Keep the adapter session/project store on persistent storage. Do not give the adapter an allowed root broader than the directories intended for GJC operation. Artifact links are resolved with realpath containment and symlink escapes are rejected.
## Real OpenWebUI E2E

`Real OpenWebUI E2E` is a manual, default-branch-only workflow. Before dispatching it, configure the protected `real-openwebui-e2e` GitHub environment with these variables:

- `E2E_ADAPTER_BASE_URL`
- `E2E_OPENWEBUI_BASE_URL`
- `E2E_REAL_PROJECT_DIR`

Configure these environment secrets:

- `E2E_ADAPTER_API_TOKEN`
- `E2E_OPENWEBUI_API_TOKEN`
- `E2E_OPENWEBUI_OWNER_USER_ID`

Use a dedicated OpenWebUI test account and an adapter/OpenWebUI deployment intended for E2E traffic. `E2E_REAL_PROJECT_DIR` must be a project directory available to the adapter and permitted by its configured allowed roots. Environment protection should restrict who can approve access to these credentials. The workflow uploads its E2E evidence even when the run fails.
