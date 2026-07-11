# OpenWebUI GJC Adapter

The adapter is a Bun CLI and an OpenAI-compatible gateway for GJC-backed OpenWebUI deployments.

## Install and run

Install the package globally, then use the `openwebui-gjc-adapter` command:

```sh
bun add --global openwebui-gjc-adapter
openwebui-gjc-adapter serve --config /etc/openwebui-gjc-adapter/config.json
```

The launcher resolves its own real path before loading the package, so the global-install symlink is safe to invoke from any working directory.

## Choose a deployment route

### Managed route: private adapter and loopback UI

Run the adapter and OpenWebUI together in Compose. The adapter listens on
`0.0.0.0:8765` only on the Compose network, while OpenWebUI reaches it at:

```text
http://adapter:8765/v1
```

Only the OpenWebUI UI is published, on `127.0.0.1:8080` by default. Do not
publish the adapter port to the host. The adapter configuration file is mounted
read-only at `/run/openwebui-gjc-adapter/config.json`; adapter state, session
data, and the neutral workspace use separate persistent mounts.

Managed installation requires a rootful Docker daemon with user-namespace remapping disabled. The preflight checks `docker info` before writing managed Compose artifacts or changing the managed controller; rootless Docker and `userns-remap` are unsupported.
Configure a dedicated managed instance. The CLI uses the supplied administrator
credentials only for the initial OpenWebUI signup session; they are read from
inherited file descriptors and are not persisted:
```sh
openwebui-gjc-adapter configure managed \
  --admin-email-fd=3 --admin-password-fd=4
```
OpenWebUI returns a temporary session token during signup. The installer records
that token in bootstrap state and uses it to exchange for a durable API key;
the durable key is retained in the private configuration for managed operation.
After successful configure, the bootstrap journal remains mode `0600` and retains the duplicate API key for recovery/audit purposes.

### Existing route: provider-neutral and manual

Keep an existing deployment when its ingress and OpenAI provider connection are
managed by the operator. The CLI validates the supplied OpenWebUI API token,
starts a loopback-only adapter, and leaves provider and ingress configuration
manual. Supply the existing OpenWebUI URL, its token FD, and the operator's
external adapter URL ending in `/v1`:

```sh
openwebui-gjc-adapter configure existing \
  --openwebui-url=https://openwebui.example \
  --openwebui-api-token-fd=3 \
  --adapter-ingress-url=https://adapter.example/v1
```
In the existing Open WebUI Admin provider form, configure the operator-owned
connection with the ingress URL, the adapter token revealed below, and the sole
model ID `gjc`. Add these request headers using Open WebUI templates:

```text
X-OpenWebUI-Chat-Id: {{CHAT_ID}}
X-OpenWebUI-Message-Id: {{MESSAGE_ID}}
X-OpenWebUI-User-Message-Id: {{USER_MESSAGE_ID}}
X-OpenWebUI-User-Message-Parent-Id: {{USER_MESSAGE_PARENT_ID}}
X-OpenWebUI-User-Id: {{USER_ID}}
X-OpenWebUI-Task: {{TASK}}
```

The operator owns TLS, ingress reachability, provider verification, and a final
chat test. The CLI never configures that provider or ingress. The adapter's
provider-neutral runtime may still reconcile its own prompt suggestion on
`/readyz`: this applies to both managed and existing routes, preserves foreign
suggestions, and reports readiness only after the OpenWebUI readback matches the
merged suggestions. A readiness probe may therefore trigger this pending
adapter-owned reconciliation.
Use `openwebui-gjc-adapter probe-ready --config /path/to/config.json` to verify the adapter readiness endpoint after deployment.

## Adapter token handling

The generated adapter token is retained in the installer-owned `0600` configuration file and a separate private `0600` `adapter-token` copy used by deployment consumers. It is never displayed during configure. Reveal it only after confirming on the same controlling terminal (the CLI opens `/dev/tty` and writes only there):

```sh
openwebui-gjc-adapter credentials show adapter-token --config /path/to/config.json
```

Keep the configuration file and any mounted state on persistent, operator-controlled storage. Existing mode stores its default project root under `$XDG_STATE_HOME` (falling back to `$XDG_DATA_HOME`, then `$HOME/.local/state`) at `openwebui-gjc-adapter/workspace`; explicit project roots remain supported. Restrict project roots to directories intended for GJC operation.
The installer may create these private copies:

- `config.json` contains the adapter token, readiness token, and (after managed
  bootstrap) the Open WebUI API token; it is mode `0600`.
- `adapter-token` is a private mode-`0600` deployment copy. In managed mode it
  is supplied as Compose-secret input; existing mode also creates the copy for
  deployment use. It is not mounted into Open WebUI.
- Managed bootstrap checkpoints retain the temporary OpenWebUI signup session
  token in the private `config.json.bootstrap.json` journal (mode `0600`).
  The session token is exchanged for a durable API key, and retries reuse the
  same installation identity without creating another account or token.
  The bootstrap journal is paired with `config.json.recovery.json`; after
  successful configure both recovery records are cleared. A failed fresh install
  retains the pending recovery/bootstrap and recovery snapshot bundle, including
  its installation identity and API-key checkpoint, so retrying the same
  configure invocation resumes that installation rather than creating another
  account.

For a failed installation, retry with the same `configure managed` or `configure existing` invocation and persisted options. To intentionally recover or change a route, use `--reset --reset-proof=...`; reset confirmation and token display require the controlling `/dev/tty`, not redirected stdout.
`probe-ready` verifies readiness and may reconcile the adapter-owned prompt suggestion; it is not a provider or ingress configuration operation.

Managed mode configures its dedicated provider connection. Existing-mode provider and ingress settings, external tunnels, and OCI registry/manifest research remain operator-owned.
