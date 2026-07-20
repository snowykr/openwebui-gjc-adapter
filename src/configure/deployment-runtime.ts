import { execFileSync } from "node:child_process";
import type { CliDependencies } from "./installed-cli-contracts";
import type { CommandRunner } from "./managed-compose";
import type { OpenWebUIHttpClient } from "./openwebui-setup";
import type { InstalledConfig } from "./private-config";

type RuntimeInput = Pick<
	CliDependencies,
	"managedDocker" | "managedReadinessDelayMs" | "probeManagedAdapter" | "systemctl"
> & { readonly composeFile: string };

export interface DeploymentRuntime {
	readonly docker: CommandRunner;
	readonly managedReadinessDelayMs: number | undefined;
	readonly run: (args: readonly string[], env?: NodeJS.ProcessEnv) => void;
	readonly runCapture: (args: readonly string[]) => string;
	readonly waitForAdapterReady: (
		probe: () => void | Promise<void>,
		attempts?: number,
		delayMs?: number,
	) => Promise<void>;
	readonly waitForManagedOpenWebUITarget: () => Promise<void>;
	readonly probeAdapter: (config: InstalledConfig) => Promise<void>;
	readonly probeManagedAdapter: (composeFile: string) => void | Promise<void>;
}

function commandFailure(error: unknown): { readonly status: number; readonly stdout: string; readonly stderr: string } {
	return {
		status: typeof Reflect.get(Object(error), "status") === "number" ? Reflect.get(Object(error), "status") : 1,
		stdout: String(Reflect.get(Object(error), "stdout") ?? ""),
		stderr: String(Reflect.get(Object(error), "stderr") ?? ""),
	};
}

function defaultDockerRunner(): CommandRunner {
	return {
		run: async (command, args, options) => {
			try {
				if (options?.output === "inherit") {
					execFileSync(command, [...args], { stdio: ["ignore", "inherit", "inherit"] });
					return { exitCode: 0, stdout: "", stderr: "" };
				}
				const stdout = execFileSync(command, [...args], { stdio: ["ignore", "pipe", "pipe"] }).toString();
				return { exitCode: 0, stdout, stderr: "" };
			} catch (error) {
				const failure = commandFailure(error);
				return { exitCode: failure.status, stdout: failure.stdout, stderr: failure.stderr };
			}
		},
	};
}

async function waitForReady(probe: () => void | Promise<void>, attempts = 10, delayMs = 250): Promise<void> {
	let failure: unknown;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			await probe();
			return;
		} catch (error) {
			failure = error;
			if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)));
		}
	}
	throw failure;
}

function defaultManagedProbe(composeFile: string): void {
	const script =
		'const config = JSON.parse(await Bun.file("/run/openwebui-gjc-adapter/config.json").text()); const response = await fetch("http://127.0.0.1:8765/readyz", { headers: { authorization: `Bearer $' +
		"{config.readinessToken}` } }); if (!response.ok) process.exit(1);";
	try {
		execFileSync(
			"docker",
			["compose", "-f", composeFile, "-p", "openwebui-gjc-adapter", "exec", "-T", "adapter", "bun", "-e", script],
			{ stdio: "pipe" },
		);
	} catch (error) {
		const detail = String(Reflect.get(Object(error), "stderr") ?? "").trim();
		throw new Error(`adapter is not ready${detail ? ` (${detail})` : ""}`);
	}
}

export function runDeploymentCommand(
	runtime: DeploymentRuntime,
	input: { readonly args: readonly string[]; readonly env?: NodeJS.ProcessEnv; readonly capture?: boolean },
): string | undefined {
	if (input.capture) return runtime.runCapture(input.args);
	runtime.run(input.args, input.env);
	return undefined;
}

export function createOpenWebUIHttpClient(
	config: InstalledConfig,
	managedReadinessDelayMs?: number,
): OpenWebUIHttpClient {
	return {
		request: async <T>(method: string, endpoint: string, body?: unknown, authorization?: string): Promise<T> => {
			const token = authorization ?? config.openWebUIApiToken;
			const managedProbe = config.mode === "managed" && endpoint === "/api/version";
			const attempts = managedProbe ? 60 : endpoint === "/api/version" ? 10 : 1;
			const delayMs = managedProbe ? (managedReadinessDelayMs ?? 1_000) : 500;
			let failure: unknown;
			for (let attempt = 0; attempt < attempts; attempt++) {
				try {
					const response = await fetch(`${config.openWebUIApiUrl}${endpoint}`, {
						method,
						headers: {
							...(token ? { authorization: `Bearer ${token}` } : {}),
							"content-type": "application/json",
						},
						body: body === undefined ? undefined : JSON.stringify(body),
					});
					if (!response.ok) throw new Error(`OpenWebUI request ${method} ${endpoint} failed (${response.status})`);
					return JSON.parse(await response.text());
				} catch (error) {
					failure = error;
					if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
				}
			}
			throw failure;
		},
	};
}

export function createDeploymentRuntime(input: RuntimeInput): DeploymentRuntime {
	const docker = input.managedDocker ?? defaultDockerRunner();
	const delayMs = input.managedReadinessDelayMs ?? 1_000;
	const run = (args: readonly string[], env?: NodeJS.ProcessEnv): void => {
		const command = args[0];
		if (command === undefined) throw new Error("deployment command is empty");
		if (input.systemctl && command === "systemctl") input.systemctl(args);
		else execFileSync(command, args.slice(1), { stdio: "inherit", env });
	};
	const runCapture = (args: readonly string[]): string => {
		const command = args[0];
		if (command === undefined) throw new Error("deployment command is empty");
		return input.systemctl && command === "systemctl"
			? String(input.systemctl(args) ?? "")
			: String(execFileSync(command, args.slice(1), { stdio: ["ignore", "pipe", "pipe"] }));
	};
	return {
		docker,
		managedReadinessDelayMs: input.managedReadinessDelayMs,
		run,
		runCapture,
		waitForAdapterReady: waitForReady,
		probeManagedAdapter: input.probeManagedAdapter ?? defaultManagedProbe,
		probeAdapter: async config => {
			const host = config.bindHost === "0.0.0.0" ? "127.0.0.1" : config.bindHost;
			const response = await fetch(`http://${host}:${config.bindPort}/readyz`, {
				headers: { authorization: `Bearer ${config.readinessToken}` },
			});
			if (!response.ok) throw new Error(`adapter is not ready (${response.status})`);
		},
		waitForManagedOpenWebUITarget: async () => {
			let failure: unknown;
			for (let attempt = 0; attempt < 60; attempt++) {
				try {
					const result = await docker.run("docker", [
						"compose",
						"-f",
						input.composeFile,
						"-p",
						"openwebui-gjc-adapter",
						"ps",
						"--status",
						"running",
						"--services",
						"openwebui",
					]);
					if (result.exitCode !== 0) throw new Error("failed to inspect the managed OpenWebUI service");
					if (result.stdout.trim() !== "openwebui") throw new Error("managed OpenWebUI service is not running");
					return;
				} catch (error) {
					failure = error;
					if (attempt + 1 < 60) await new Promise(resolve => setTimeout(resolve, delayMs));
				}
			}
			throw failure;
		},
	};
}
