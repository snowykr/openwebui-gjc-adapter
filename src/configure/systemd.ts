export interface SystemdComposeUnitInput {
	readonly name?: string;
	readonly workingDirectory: string;
	readonly composeFile: string;
	readonly dockerBinary?: string;
	readonly description?: string;
	readonly adapterCommand?: readonly string[];
}
export function routeControllerUnitName(mode: "managed" | "existing"): string {
	return mode === "managed" ? "openwebui-gjc-adapter.service" : "openwebui-gjc-adapter-existing.service";
}

/** Managed mode is a concrete Compose controller; systemd owns the foreground process. */
export function renderSystemdComposeUnit(input: SystemdComposeUnitInput): string {
	return renderComposeUnit(input, "OpenWebUI GJC adapter managed Compose", "default.target");
}
/** Existing mode runs the host adapter directly and never treats the host as Compose-managed. */
export function renderExistingSystemdUnit(input: Omit<SystemdComposeUnitInput, "composeFile">): string {
	const command = input.adapterCommand ?? ["/usr/bin/bun", "run", "src/cli.ts", "serve"];
	return renderHostUnit(
		{ ...input, name: input.name ?? "openwebui-gjc-adapter-existing", adapterCommand: command },
		input.description ?? "OpenWebUI GJC adapter existing instance",
		"default.target",
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
): string {
	const name = input.name ?? "openwebui-gjc-adapter-existing";
	return `[Unit]\nDescription=${escapeUnitValue(input.description ?? defaultDescription)}\nAfter=network-online.target\nWants=network-online.target\nStartLimitIntervalSec=5min\nStartLimitBurst=5\n\n[Service]\nType=simple\nWorkingDirectory=${escapeUnitValue(input.workingDirectory)}\nExecStart=${input.adapterCommand?.map(escapeUnitValue).join(" ")}\nRestart=always\nRestartSec=5s\n\n[Install]\nWantedBy=${wantedBy}\n# unit name: ${escapeUnitValue(name)}\n`;
}
function escapeUnitValue(value: string): string {
	return value.length === 0 || /[\s"'\\]/.test(value)
		? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
		: value;
}
