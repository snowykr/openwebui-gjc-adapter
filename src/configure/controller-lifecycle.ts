import type { DeploymentArtifacts } from "./deployment-artifacts";
import type { DeploymentRuntime } from "./deployment-runtime";
import type { CliDependencies } from "./installed-cli-contracts";
import { routeControllerUnitName } from "./systemd";

export interface ControllerState {
	readonly enabled: boolean;
	readonly active: boolean;
}

type ControllerInput = {
	readonly mode: "managed" | "existing";
	readonly runtime: DeploymentRuntime;
	readonly artifacts?: DeploymentArtifacts;
	readonly dependencies?: CliDependencies;
};

function outputField(error: unknown, name: "stdout" | "stderr"): string {
	return error instanceof Error && name in error ? String(Reflect.get(error, name) ?? "") : "";
}

function probeController(input: ControllerInput, action: "is-enabled" | "is-active"): boolean {
	const unit = routeControllerUnitName(input.mode);
	let output = "";
	try {
		output = input.runtime.runCapture(["systemctl", "--user", action, unit]);
	} catch (error) {
		const stdout = outputField(error, "stdout");
		const stderr = outputField(error, "stderr");
		output = stdout || stderr;
		if (stderr.trim().length > 0) throw new Error(`failed to probe ${unit} ${action}: ${stderr.trim()}`);
	}
	const state = output.trim();
	const accepted: ReadonlyMap<string, boolean> =
		action === "is-enabled"
			? new Map([
					["enabled", true],
					["disabled", false],
					["static", false],
					["indirect", false],
					["masked", false],
					["generated", false],
					["transient", false],
					["not-found", false],
				])
			: new Map([
					["active", true],
					["inactive", false],
					["failed", false],
					["dead", false],
					["unknown", false],
				]);
	const result = accepted.get(state);
	if (result !== undefined) return result;
	throw new Error(`failed to probe ${unit} ${action}: invalid systemd state ${JSON.stringify(state)}`);
}

export function captureControllerState(input: ControllerInput): ControllerState {
	return { enabled: probeController(input, "is-enabled"), active: probeController(input, "is-active") };
}

export function quiesceController(input: ControllerInput): void {
	const unit = routeControllerUnitName(input.mode);
	input.runtime.run(["systemctl", "--user", "stop", unit]);
	input.runtime.run(["systemctl", "--user", "disable", unit]);
}

export function restoreController(input: ControllerInput & { readonly state: ControllerState }): void {
	const unit = routeControllerUnitName(input.mode);
	const failures: Error[] = [];
	for (const action of [...(input.state.enabled ? ["enable"] : []), ...(input.state.active ? ["start"] : [])]) {
		try {
			input.runtime.run(["systemctl", "--user", action, unit]);
		} catch (error) {
			failures.push(error instanceof Error ? error : new Error(String(error)));
		}
	}
	if (failures.length > 0) throw new Error(failures.map(error => error.message).join("; "));
}

export function createControllerLifecycle(input: Omit<ControllerInput, "mode">) {
	return {
		stop: (mode: ControllerInput["mode"]) =>
			input.runtime.run(["systemctl", "--user", "stop", routeControllerUnitName(mode)]),
		disable: (mode: ControllerInput["mode"]) =>
			input.runtime.run(["systemctl", "--user", "disable", routeControllerUnitName(mode)]),
		reload: () => input.runtime.run(["systemctl", "--user", "daemon-reload"]),
		restore: (mode: ControllerInput["mode"], state: ControllerState) => restoreController({ ...input, mode, state }),
	};
}
