import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CONFIGURE = join(import.meta.dir, "..", "src", "configure");
const MODULES = [
	"pending-recovery.ts",
	"installed-cli-contracts.ts",
	"file-snapshots.ts",
	"durable-deployment-snapshot.ts",
	"pending-recovery-store.ts",
	"deployment-runtime.ts",
	"deployment-artifacts.ts",
	"deployment-phases.ts",
	"controller-lifecycle.ts",
	"deployment-transaction.ts",
	"production-deployment.ts",
	"configure-input.ts",
	"configure-command.ts",
] as const;
const MODULE_SET: ReadonlySet<string> = new Set(MODULES);
const ALLOWED_WIDE_CALLBACK =
	"request: async <T>(method: string, endpoint: string, body?: unknown, authorization?: string): Promise<T> =>";
const LEGACY_LEAVES = new Set([
	"bootstrap-state.ts",
	"credentials.ts",
	"grammar.ts",
	"installed-config-schema.ts",
	"managed-compose.ts",
	"openwebui-setup.ts",
	"orchestrator.ts",
	"private-config.ts",
	"runtime-locations.ts",
	"systemd.ts",
]);
const CHECKPOINTS = {
	A: MODULES.slice(0, 2),
	B: MODULES.slice(0, 5),
	C: MODULES.slice(0, 10),
	D: MODULES,
} as const;
const OWNERS = new Map<string, readonly string[]>([
	[
		"pending-recovery.ts",
		[
			"PendingRecoveryLinkageInput",
			"buildPendingRecoveryLinkage",
			"parsePendingRecoveryLinkage",
			"matchesPendingRecoveryLinkage",
		],
	],
	["installed-cli-contracts.ts", ["DeploymentResult", "ResetRequest", "DeploymentLifecycle", "CliDependencies"]],
	["file-snapshots.ts", ["FileSnapshot", "captureFileSnapshot", "restoreFileSnapshot", "removeFileSnapshot"]],
	[
		"durable-deployment-snapshot.ts",
		["DurableDeploymentSnapshot", "captureDurableDeploymentSnapshot", "restoreDurableDeploymentSnapshot"],
	],
	[
		"pending-recovery-store.ts",
		["PendingRecoveryStore", "readPendingRecovery", "writePendingRecovery", "updatePendingRecovery"],
	],
	["deployment-runtime.ts", ["DeploymentRuntime", "createDeploymentRuntime", "runDeploymentCommand"]],
	[
		"deployment-artifacts.ts",
		["DeploymentArtifacts", "stageDeploymentArtifacts", "commitDeploymentArtifacts", "rollbackDeploymentArtifacts"],
	],
	[
		"deployment-phases.ts",
		["DeploymentPhaseInput", "runManagedDeploymentPhase", "runExistingDeploymentPhase", "runResetDeploymentPhase"],
	],
	["controller-lifecycle.ts", ["ControllerState", "captureControllerState", "quiesceController", "restoreController"]],
	[
		"deployment-transaction.ts",
		[
			"DeploymentTransaction",
			"beginDeploymentTransaction",
			"commitDeploymentTransaction",
			"rollbackDeploymentTransaction",
		],
	],
	["production-deployment.ts", ["ProductionDeploymentInput", "createProductionDeployment"]],
	["configure-input.ts", ["ConfigureInput", "parseConfigureInput"]],
	["configure-command.ts", ["ConfigureCommandInput", "runConfigureCommand"]],
]);
const ALLOWED = new Map<string, ReadonlySet<string>>([
	["pending-recovery.ts", new Set()],
	["installed-cli-contracts.ts", new Set(["bootstrap-state.ts"])],
	["file-snapshots.ts", new Set()],
	["durable-deployment-snapshot.ts", new Set(["file-snapshots.ts", "installed-cli-contracts.ts"])],
	["pending-recovery-store.ts", new Set(["pending-recovery.ts", "file-snapshots.ts", "bootstrap-state.ts"])],
	["deployment-runtime.ts", new Set(["installed-cli-contracts.ts"])],
	["deployment-artifacts.ts", new Set(["file-snapshots.ts", "deployment-runtime.ts", "installed-cli-contracts.ts"])],
	[
		"deployment-phases.ts",
		new Set([
			"installed-cli-contracts.ts",
			"deployment-runtime.ts",
			"deployment-artifacts.ts",
			"pending-recovery-store.ts",
		]),
	],
	[
		"controller-lifecycle.ts",
		new Set(["installed-cli-contracts.ts", "deployment-runtime.ts", "deployment-artifacts.ts"]),
	],
	[
		"deployment-transaction.ts",
		new Set([
			"installed-cli-contracts.ts",
			"file-snapshots.ts",
			"durable-deployment-snapshot.ts",
			"deployment-artifacts.ts",
			"controller-lifecycle.ts",
		]),
	],
	[
		"production-deployment.ts",
		new Set([
			"installed-cli-contracts.ts",
			"pending-recovery-store.ts",
			"deployment-runtime.ts",
			"deployment-artifacts.ts",
			"deployment-phases.ts",
			"controller-lifecycle.ts",
			"deployment-transaction.ts",
		]),
	],
	["configure-input.ts", new Set(["installed-cli-contracts.ts", "pending-recovery.ts", "pending-recovery-store.ts"])],
	[
		"configure-command.ts",
		new Set([
			"installed-cli-contracts.ts",
			"configure-input.ts",
			"pending-recovery-store.ts",
			"production-deployment.ts",
			"deployment-phases.ts",
		]),
	],
]);

function source(name: string): string {
	return readFileSync(join(CONFIGURE, name), "utf8");
}

function pureLoc(value: string): number {
	return value
		.split("\n")
		.filter(line => line.trim().length > 0 && !line.trim().startsWith("//") && !line.trim().startsWith("*")).length;
}

function parameterCount(value: string): number {
	if (value.trim().length === 0) return 0;
	let depth = 0;
	let count = 1;
	for (const character of value) {
		if ("<([{".includes(character)) depth++;
		if (">)]}".includes(character)) depth--;
		if (character === "," && depth === 0) count++;
	}
	return value.trim().endsWith(",") ? count - 1 : count;
}

function imports(name: string, runtimeOnly = false): readonly string[] {
	const found: string[] = [];
	for (const match of source(name).matchAll(/(?:import|export)\s+([\s\S]*?)\s+from\s+["']\.\/(.+?)["']/g)) {
		if (runtimeOnly && match[1]?.trim().startsWith("type ")) continue;
		if (match[2] !== undefined) found.push(`${match[2]}.ts`);
	}
	return found;
}

function assertAcyclic(runtimeOnly: boolean): void {
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (name: string): void => {
		if (visiting.has(name)) throw new Error(`configure module cycle at ${name}`);
		if (visited.has(name)) return;
		visiting.add(name);
		for (const dependency of imports(name, runtimeOnly).filter(value => MODULE_SET.has(value))) visit(dependency);
		visiting.delete(name);
		visited.add(name);
	};
	for (const name of MODULES) visit(name);
}

function expectStrictSource(name: string): void {
	const value = source(name);
	expect(pureLoc(value), `${name} pure LOC`).toBeLessThanOrEqual(250);
	expect(value).not.toMatch(/\bas\s+(?:unknown|any|Record<)|@ts-(?:ignore|expect-error)|\w+!(?:\.|\[|\)|,|;)/);
	expect(value).not.toMatch(/\barguments\b/);
	for (const match of value.matchAll(
		/(?:async\s+)?function\s+\w+(?:<[^>]+>)?\s*\(([^)]*)\)|constructor\s*\(([^)]*)\)/g,
	)) {
		const parameters = match[1] ?? match[2] ?? "";
		expect(parameters, `${name} function rest parameters`).not.toContain("...");
		expect(parameterCount(parameters), `${name} function parameters`).toBeLessThanOrEqual(3);
	}
	const callbacks = [
		...value.matchAll(
			/(?:^\s*|[=,]\s*)(?:(\w+)\s*:\s*)?((?:async\s+)?(?:<[^>\n]+>\s*)?\(([^)]*)\)\s*(?::\s*[^=\n]+)?\s*=>)/gm,
		),
	];
	for (const match of callbacks) expect(match[3] ?? "", `${name} callback rest parameters`).not.toContain("...");
	const wideCallbacks = callbacks
		.filter(match => parameterCount(match[3] ?? "") > 3)
		.map(match => `${match[1] === undefined ? "" : `${match[1]}: `}${match[2]}`);
	expect(wideCallbacks, `${name} callback parameters`).toEqual(
		name === "deployment-runtime.ts" ? [ALLOWED_WIDE_CALLBACK] : [],
	);
}

function expectCheckpoint(names: readonly string[]): void {
	for (const name of names) {
		expect(existsSync(join(CONFIGURE, name)), `${name} must exist`).toBeTrue();
		expectStrictSource(name);
		for (const symbol of OWNERS.get(name) ?? [])
			expect(source(name), `${name} owns ${symbol}`).toMatch(
				new RegExp(`export\\s+(?:interface|type|class|function|async\\s+function)\\s+${symbol}\\b`),
			);
		for (const imported of imports(name).filter(value => MODULE_SET.has(value) || value === "bootstrap-state.ts"))
			expect(ALLOWED.get(name)?.has(imported), `${name} -> ${imported}`).toBeTrue();
	}
}

test("checkpoint A: contracts and pending recovery leaves", () => expectCheckpoint(CHECKPOINTS.A));
test("checkpoint B: snapshots and pending store", () => expectCheckpoint(CHECKPOINTS.B));
test("checkpoint C: deployment lifecycle seams", () => expectCheckpoint(CHECKPOINTS.C));
test("checkpoint D: exact architecture", () => {
	expectCheckpoint(CHECKPOINTS.D);
	const owned = readdirSync(CONFIGURE).filter(
		name => name.endsWith(".ts") && name !== "installed-cli.ts" && !LEGACY_LEAVES.has(name),
	);
	expect(owned.sort()).toEqual([...MODULES].sort());
	for (const name of ["installed-cli.ts", "bootstrap-state.ts"]) expectStrictSource(name);
	expect([...new Set(imports("installed-cli.ts").filter(value => MODULE_SET.has(value)))].sort()).toEqual(
		["installed-cli-contracts.ts", "configure-command.ts", "production-deployment.ts"].sort(),
	);
	expect([...new Set(imports("bootstrap-state.ts").filter(value => MODULE_SET.has(value)))].sort()).toEqual([
		"pending-recovery.ts",
	]);
	for (const name of MODULES) expect(imports(name)).not.toContain("installed-cli.ts");
	assertAcyclic(true);
	assertAcyclic(false);
});
