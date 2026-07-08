# OpenWebUI GJC Adapter

Experimental TS/Bun adapter that treats GJC session JSONL/artifacts as the source of truth and projects them into OpenWebUI folders, chat history trees, message events, and an OpenAI-compatible live gateway.

## OpenWebUI setup

Configure OpenWebUI to use the adapter as an OpenAI-compatible backend:

```env
OPENAI_API_BASE_URL=http://127.0.0.1:8765/v1
OPENAI_API_KEY=<adapter-token>
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

Use OpenWebUI 0.10.0 or newer so chat/message/task placeholders are available. Background task calls such as title generation are no-ops and must not create GJC sessions.

## Registering projects

Register one project per working directory. The adapter validates the real path against an allowed root before exposing the project as a model and OpenWebUI folder.

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

The model id is `gjc/<project-name>` by default. Historical imports place projected sessions under folder id `gjc-project-<project-id>` and chat id `gjc-session-<session-id>`.

## Runtime contract

- GJC JSONL and artifacts remain authoritative.
- OpenWebUI chat rows and chat messages are projection/cache records.
- Adapter metadata is stored under `gjc_adapter`; user-visible OpenWebUI fields such as title/rating are preserved on reprojection.
- The live gateway uses `/v1/models` and `/v1/chat/completions`.
- GJC tool/MCP/skill/workflow progress is delivered as OpenWebUI message events through the adapter event sink.
- Workflow gates can be rendered as assistant-visible pending-gate text and validated with the exported gate primitives; wire those primitives into the deployment's event sink/continuation policy before claiming automatic gate approval handling.
- Regenerate/branch only proceeds when owner, project, session, and message lineage metadata match; otherwise the adapter forks safely.

## Operator notes

Keep the adapter session/project store on persistent storage. Do not give the adapter an allowed root broader than the directories intended for GJC operation. Artifact links are resolved with realpath containment and symlink escapes are rejected.
