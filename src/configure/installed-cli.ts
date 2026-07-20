import { closeSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { ReadStream as TtyReadStream, WriteStream as TtyWriteStream } from "node:tty";
import { loadInstalledAdapterConfig } from "../config";
import { parseBootstrapState, resetBootstrapState } from "./bootstrap-state";
import { runConfigureCommand } from "./configure-command";
import { canDisplaySecret, displayAdapterToken } from "./credentials";
import { CliUsageError, parseCliArguments } from "./grammar";
import type { CliDependencies } from "./installed-cli-contracts";
import { acquireConfigLock, acquireRouteLock, defaultConfigPath, readInstalledConfig } from "./private-config";
import { createProductionDeployment } from "./production-deployment";

export type { CliDependencies, DeploymentLifecycle, DeploymentResult, ResetRequest } from "./installed-cli-contracts";
export { createProductionDeployment } from "./production-deployment";

async function confirmOnControllingTty(
	phrase: string,
	input?: NodeJS.ReadStream,
	output?: NodeJS.WriteStream,
): Promise<boolean> {
	let ownsTerminal = false;
	if (!input || !output) {
		const inputFd = openSync("/dev/tty", "r");
		let outputFd: number;
		try {
			outputFd = openSync("/dev/tty", "w");
		} catch (error) {
			closeSync(inputFd);
			throw error;
		}
		input = new TtyReadStream(inputFd);
		output = new TtyWriteStream(outputFd);
		ownsTerminal = true;
	}
	try {
		if (!canDisplaySecret(input, output)) return false;
		const prompt = createInterface({ input, output });
		const answer = await prompt.question(`Type exactly "${phrase}" to continue: `);
		prompt.close();
		return answer === phrase;
	} catch {
		return false;
	} finally {
		if (ownsTerminal) {
			input.destroy();
			output.destroy();
		}
	}
}

function optionValue(options: Record<string, string | boolean>, name: string): string | undefined {
	const value = options[name];
	return typeof value === "string" ? value : undefined;
}

function production(path: string, dependencies: CliDependencies) {
	return createProductionDeployment({
		path,
		parseState: parseBootstrapState,
		resetState: resetBootstrapState,
		setupOpenWebUI: dependencies.configureOpenWebUI,
		managedDocker: dependencies.managedDocker,
		systemctl: dependencies.systemctl,
		managedProbe: dependencies.probeManagedAdapter,
		managedReadinessDelayMs: dependencies.managedReadinessDelayMs,
	});
}

export async function runInstalledCli(
	argv: readonly string[] = process.argv.slice(2),
	dependencies: CliDependencies = {},
): Promise<number> {
	const stdout = dependencies.stdout ?? process.stdout;
	const stderr = dependencies.stderr ?? process.stderr;
	try {
		const command = parseCliArguments(argv);
		const options = "options" in command ? (command.options ?? {}) : {};
		const path = resolve(optionValue(options, "config") ?? defaultConfigPath());
		if (command.kind === "configure") {
			const unlock = acquireConfigLock(path);
			let unlockRoute: (() => void) | undefined;
			try {
				unlockRoute = acquireRouteLock();
				await runConfigureCommand({
					mode: command.mode,
					options,
					path,
					dependencies,
					production: production(path, dependencies),
					confirmReset: (mode, proof) =>
						Promise.resolve(
							(
								dependencies.confirmReset ??
								((valueMode, valueProof) => confirmOnControllingTty(`RESET ${valueMode} ${valueProof}`))
							)(mode, proof),
						),
				});
			} finally {
				unlockRoute?.();
				unlock();
			}
			return 0;
		}
		if (command.kind === "credentials-show-adapter-token") {
			const explicitTerminal = dependencies.terminal;
			let input: NodeJS.ReadStream;
			let output: NodeJS.WriteStream;
			let closeTerminal = false;
			if (explicitTerminal) {
				input = explicitTerminal.input;
				output = explicitTerminal.output;
			} else {
				const inputFd = openSync("/dev/tty", "r");
				let outputFd: number;
				try {
					outputFd = openSync("/dev/tty", "w");
				} catch (error) {
					closeSync(inputFd);
					throw error;
				}
				input = new TtyReadStream(inputFd);
				output = new TtyWriteStream(outputFd);
				closeTerminal = true;
			}
			try {
				if (!canDisplaySecret(input, output))
					throw new Error("adapter token display requires the same controlling /dev/tty");
				const token = readInstalledConfig(path).adapterToken;
				const confirmed = await (
					dependencies.confirmAdapterToken ?? (() => confirmOnControllingTty("SHOW ADAPTER TOKEN", input, output))
				)(token);
				if (!confirmed)
					throw new Error("adapter token confirmation phrase was not accepted on the same controlling /dev/tty");
				displayAdapterToken(token, input, output);
			} finally {
				if (closeTerminal) {
					input.destroy();
					output.destroy();
				}
			}
			return 0;
		}
		if (command.kind === "probe-ready") {
			await production(path, dependencies).probeInstalled();
			return 0;
		}
		const config = loadInstalledAdapterConfig(path);
		const server = dependencies.startServer
			? await dependencies.startServer(config)
			: (() => {
					throw new Error("installed service startup must be provided by the adapter CLI");
				})();
		stdout.write(`${server.url}\n`);
		return 0;
	} catch (error) {
		stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return error instanceof CliUsageError ? error.exitCode : 1;
	}
}
