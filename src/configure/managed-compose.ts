import type { GjcRuntimeLocations } from "../contracts";
import { resolveGjcRuntimeLocations } from "./runtime-locations";

export interface CommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}
export interface CommandRunOptions {
	readonly output?: "inherit";
}
export interface CommandRunner {
	run(command: string, args: readonly string[], options?: CommandRunOptions): Promise<CommandResult>;
}
export interface ManagedComposeCheckInput {
	readonly docker?: CommandRunner;
	readonly requireRootful?: boolean;
	readonly requireNoUsernsRemap?: boolean;
}
export interface ManagedComposeChecks {
	readonly rootful: boolean;
	readonly usernsRemapDisabled: boolean;
	readonly passed: boolean;
	readonly failures: readonly string[];
}
export async function checkManagedComposePrerequisites(input: ManagedComposeCheckInput): Promise<ManagedComposeChecks> {
	if (!input.docker) throw new Error("Docker command runner is required for managed checks");
	const result = await input.docker.run("docker", [
		"info",
		"--format",
		"{{json .SecurityOptions}} {{json .DockerRootDir}}",
	]);
	if (result.exitCode !== 0) throw new Error(`docker info failed: ${result.stderr.trim() || result.stdout.trim()}`);
	const options = [...`${result.stdout}\n${result.stderr}`.matchAll(/"([^"]+)"/g)].map(match =>
		match[1].trim().toLowerCase(),
	);
	const rootless = options.some(option => option === "rootless" || /^name=rootless(?:$|[,\s])/.test(option));
	const remapped = options.some(
		option =>
			/(?:^|[,\s])(?:name=)?userns(?:-remap)?(?:$|[=,:,\s])/.test(option) ||
			/(?:^|[,\s])userns-remap(?:$|[=,:,\s])/.test(option),
	);
	const failures: string[] = [];
	if (input.requireRootful !== false && rootless) failures.push("Docker rootless mode is not supported");
	if (input.requireNoUsernsRemap !== false && remapped)
		failures.push("Docker user namespace remapping is not supported");
	return { rootful: !rootless, usernsRemapDisabled: !remapped, passed: failures.length === 0, failures };
}
export interface ManagedComposeRenderInput {
	readonly openWebUIImage: string;
	readonly adapterImage: string;
	readonly openWebUIPort?: number;
	readonly configDirectory?: string;
	readonly configFile?: string;
	readonly openWebUIDataVolume?: string;
	readonly uid?: number;
	readonly gid?: number;
	readonly projectName?: string;
	readonly runtimeLocations?: GjcRuntimeLocations;
}
export interface ResolvedManagedComposeRenderInput extends ManagedComposeRenderInput {
	readonly runtimeLocations: GjcRuntimeLocations;
}
export interface ManagedAdapterImagePlan {
	readonly image: string;
	readonly pull: readonly [string, readonly string[]];
	readonly build: readonly [string, readonly string[]];
}
export function managedAdapterImagePlan(
	image: string,
	dockerfile = "Dockerfile.adapter",
	context = ".",
): ManagedAdapterImagePlan {
	if (!image.trim()) throw new Error("Adapter image name must be non-empty");
	return {
		image,
		pull: ["docker", ["pull", image]],
		build: ["docker", ["build", "--file", dockerfile, "--tag", image, context]],
	};
}
/** Render only; Docker is intentionally never invoked here. */
export function renderManagedCompose(input: ManagedComposeRenderInput): string {
	const runtimeLocations = input.runtimeLocations ?? resolveGjcRuntimeLocations({ mode: "managed" });
	return renderResolvedManagedCompose({ ...input, runtimeLocations });
}
export function renderResolvedManagedCompose(input: ResolvedManagedComposeRenderInput): string {
	if (input.runtimeLocations === undefined) throw new TypeError("resolved runtime locations are required");
	const port = input.openWebUIPort ?? 8080;
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Ports must be between 1 and 65535");
	const uid = input.uid ?? 1000,
		gid = input.gid ?? 1000;
	if (!Number.isInteger(uid) || !Number.isInteger(gid) || uid < 0 || gid < 0)
		throw new Error("UID and GID must be non-negative integers");
	const config = input.configDirectory ?? "./config",
		configFile = input.configFile ?? "config.json",
		configName = configFile.split("/").pop() ?? "config.json",
		data = input.openWebUIDataVolume ?? "openwebui-data",
		project = input.projectName ?? "openwebui-gjc-adapter";
	const locations = input.runtimeLocations;
	return `name: ${yaml(project)}
services:
  adapter:
    image: ${yaml(input.adapterImage)}
    user: "${uid}:${gid}"
    expose:
      - "8765"
    environment:
      HOME: ${yaml(locations.childEnvironment.HOME)}
      GJC_CONFIG_DIR: ${yaml(locations.childEnvironment.GJC_CONFIG_DIR)}
      GJC_CODING_AGENT_DIR: ${yaml(locations.childEnvironment.GJC_CODING_AGENT_DIR)}
      GJC_OPENWEBUI_BIND_HOST: 0.0.0.0
      GJC_OPENWEBUI_BIND_PORT: "8765"
      GJC_OPENWEBUI_BASE_URL: http://openwebui:8080
      GJC_OPENWEBUI_ADAPTER_API_TOKEN_FILE: /run/secrets/adapter-token
      GJC_OPENWEBUI_STATE_PATH: /var/lib/gjc
      GJC_OPENWEBUI_SESSION_ROOT: /run/gjc-session
      GJC_OPENWEBUI_ALLOWED_PROJECT_ROOTS: /workspace
    command: ["serve", "--config", "/run/openwebui-gjc-adapter/config.json"]
    volumes:
      - ${yaml(`${config}/${configName}`)}:/run/openwebui-gjc-adapter/config.json:ro
      - ${yaml(`${config}/state`)}:/var/lib/gjc
      - ${yaml(`${config}/session`)}:/run/gjc-session
      - ${yaml(`${config}/workspace`)}:/workspace
    labels:
      com.gjc.managed: "true"
      com.gjc.role: adapter
      com.gjc.project: ${yaml(project)}
      com.gjc.reader-workspace: ${yaml(locations.readerWorkspace)}
      com.gjc.reader-session-root: ${yaml(locations.readerSessionRoot)}
    secrets:
      - adapter-token
  openwebui:
    image: ${yaml(input.openWebUIImage)}
    environment:
      ENABLE_OLLAMA_API: "false"
      ENABLE_API_KEYS: "true"
    ports:
      - "127.0.0.1:${port}:8080"
    volumes:
      - ${yaml(data)}:/app/backend/data
    labels:
      com.gjc.managed: "true"
      com.gjc.role: openwebui
      com.gjc.project: ${yaml(project)}
secrets:
  adapter-token:
    file: ${yaml(`${config}/adapter-token`)}
volumes:
  ${yaml(data)}:
`;
}
function yaml(value: string): string {
	return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : JSON.stringify(value);
}
