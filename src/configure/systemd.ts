import type { GjcRuntimeLocations } from "../contracts";

export interface SystemdComposeUnitInput {
	readonly name?: string;
	readonly workingDirectory: string;
	readonly composeFile: string;
	readonly dockerBinary?: string;
	readonly description?: string;
	readonly adapterCommand?: readonly string[];
	readonly runtimeLocations?: GjcRuntimeLocations;
	readonly gjcCommand?: string;
	readonly executableSearchPath?: string;
}
export interface ResolvedSystemdComposeUnitInput extends SystemdComposeUnitInput {
	readonly runtimeLocations: GjcRuntimeLocations;
}
export function routeControllerUnitName(mode: "managed" | "existing"): string {
	return mode === "managed" ? "openwebui-gjc-adapter.service" : "openwebui-gjc-adapter-existing.service";
}

/** Managed mode is a concrete Compose controller; systemd owns the foreground process. */
export function renderSystemdComposeUnit(input: SystemdComposeUnitInput): string {
	if (input.runtimeLocations !== undefined)
		return renderResolvedSystemdComposeUnit({ ...input, runtimeLocations: input.runtimeLocations });
	return renderComposeUnit(input, "OpenWebUI GJC adapter managed Compose", "default.target");
}
export function renderResolvedSystemdComposeUnit(input: ResolvedSystemdComposeUnitInput): string {
	if (input.runtimeLocations === undefined) throw new TypeError("resolved runtime locations are required");
	return renderComposeUnit(input, "OpenWebUI GJC adapter managed Compose", "default.target");
}
/** Existing mode runs the host adapter directly and never treats the host as Compose-managed. */
export function renderExistingSystemdUnit(input: Omit<SystemdComposeUnitInput, "composeFile">): string {
	if (input.runtimeLocations !== undefined)
		return renderResolvedExistingSystemdUnit({ ...input, runtimeLocations: input.runtimeLocations });
	const command = input.adapterCommand ?? ["/usr/bin/bun", "run", "src/cli.ts", "serve"];
	return renderHostUnit(
		{ ...input, name: input.name ?? "openwebui-gjc-adapter-existing", adapterCommand: command },
		input.description ?? "OpenWebUI GJC adapter existing instance",
		"default.target",
		"",
	);
}
export function renderResolvedExistingSystemdUnit(input: Omit<ResolvedSystemdComposeUnitInput, "composeFile">): string {
	if (input.runtimeLocations === undefined) throw new TypeError("resolved runtime locations are required");
	const command = input.adapterCommand ?? ["/usr/bin/bun", "run", "src/cli.ts", "serve"];
	const childEnvironment = {
		...input.runtimeLocations.childEnvironment,
		...(input.gjcCommand === undefined ? {} : { GJC_OPENWEBUI_GJC_COMMAND: input.gjcCommand }),
		...(input.executableSearchPath === undefined ? {} : { PATH: input.executableSearchPath }),
	};
	const environment = `${Object.entries(childEnvironment)
		.map(([key, value]) => `Environment=${escapeEnvironmentValue(`${key}=${value}`)}`)
		.join("\n")}\nUnsetEnvironment=PI_CONFIG_DIR\n`;
	return renderHostUnit(
		{ ...input, name: input.name ?? "openwebui-gjc-adapter-existing", adapterCommand: command },
		input.description ?? "OpenWebUI GJC adapter existing instance",
		"default.target",
		environment,
	);
}
function renderComposeUnit(input: SystemdComposeUnitInput, defaultDescription: string, wantedBy: string): string {
	const name = input.name ?? "openwebui-gjc-adapter",
		docker = input.dockerBinary ?? "/usr/bin/docker";
	return `[Unit]\nDescription=${escapeUnitValue(input.description ?? defaultDescription)}\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=5min\nStartLimitBurst=5\n\n[Service]\nType=simple\nWorkingDirectory=${escapeUnitValue(input.workingDirectory)}\nExecStart=${escapeUnitValue(docker)} compose -f ${escapeUnitValue(input.composeFile)} -p ${escapeUnitValue(name)} up --build --remove-orphans\nExecStop=${escapeUnitValue(docker)} compose -f ${escapeUnitValue(input.composeFile)} -p ${escapeUnitValue(name)} down --remove-orphans\nRestart=always\nRestartSec=5s\n\n[Install]\nWantedBy=${wantedBy}\n`;
}
function renderHostUnit(
	input: Omit<SystemdComposeUnitInput, "composeFile">,
	defaultDescription: string,
	wantedBy: string,
	environment: string,
): string {
	const name = input.name ?? "openwebui-gjc-adapter-existing";
	return `[Unit]\nDescription=${escapeUnitValue(input.description ?? defaultDescription)}\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=5min\nStartLimitBurst=5\n\n[Service]\nType=simple\nWorkingDirectory=${escapeUnitValue(input.workingDirectory)}\n${environment}ExecStart=${input.adapterCommand?.map(escapeUnitValue).join(" ")}\nRestart=always\nRestartSec=5s\n\n[Install]\nWantedBy=${wantedBy}\n# unit name: ${escapeUnitValue(name)}\n`;
}
function escapeEnvironmentValue(value: string): string {
	if (/[\0\r\n]/.test(value)) throw new Error("systemd environment values must not contain NUL, CR, or LF");
	const escaped = value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"');
	return value.length === 0 || /[\s"'\\%]/.test(value) ? `"${escaped}"` : escaped;
}
function escapeUnitValue(value: string): string {
	if (/[\0\r\n]/.test(value)) throw new Error("systemd unit values must not contain NUL, CR, or LF");
	const escaped = value
		.replaceAll("%", "%%")
		.replaceAll("$", () => "$$")
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"');
	return value.length === 0 || /[\s"'\\$%]/.test(value) ? `"${escaped}"` : escaped;
}
