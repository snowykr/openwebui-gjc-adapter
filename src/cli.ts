import { startAdapterServiceFromEnv } from "./adapter-server-options";
import { type CliDependencies, runInstalledCli } from "./configure/installed-cli";
import { buildResolvedInstalledAdapterServerOptions } from "./installed-adapter-server-options";
import { type AdapterServerHandle, type AdapterServerOptions, startAdapterServer } from "./server";

export {
	type BuildAdapterServerOptionsDependencies,
	buildAdapterServerOptions,
	buildAdapterServerOptionsFromEnv,
	startAdapterServiceFromEnv,
} from "./adapter-server-options";
export { buildInstalledAdapterServerOptions } from "./installed-adapter-server-options";

const TOP_LEVEL_USAGE = `Usage: openwebui-gjc-adapter [command]

Without a command, starts the adapter service from environment configuration.

Commands:
  configure managed   Configure a managed local OpenWebUI installation
  configure existing  Configure an adapter for an existing OpenWebUI installation
  serve --config PATH Start an installed adapter service
  probe-ready         Check an installed adapter service readiness
  credentials show adapter-token  Display an installed adapter token

Models:
  gjc/<encoded-provider>/<encoded-model>:<thinking>  Canonical GJC model id
  gjc  Input-only alias for the current machine-global default
`;
const EXISTING_CONFIGURE_USAGE = `Usage: openwebui-gjc-adapter configure existing [options]

GJC runtime location options:
  --gjc-config-dir-name NAME   Set the persisted GJC config directory name
  --gjc-coding-agent-dir PATH  Set the persisted canonical coding-agent directory

Precedence: persisted CLI values, adapter-namespaced environment values, then derived defaults.
Pending recovery values are authoritative for retries.
`;
const MANAGED_CONFIGURE_USAGE = `Usage: openwebui-gjc-adapter configure managed [options]

Managed GJC runtime locations are fixed; runtime location overrides are rejected.
`;

export interface RunCliDependencies extends CliDependencies {
	/** Test seam for observing the fully composed installed server options. */
	readonly startConfiguredServer?: (
		options: AdapterServerOptions,
	) => AdapterServerHandle | Promise<AdapterServerHandle>;
}

export async function runCli(
	argv: readonly string[] = process.argv.slice(2),
	dependencies: RunCliDependencies = {},
): Promise<number> {
	if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
		(dependencies.stdout ?? process.stdout).write(TOP_LEVEL_USAGE);
		return 0;
	}
	if (
		argv.length === 3 &&
		argv[0] === "configure" &&
		(argv[1] === "existing" || argv[1] === "managed") &&
		argv[2] === "--help"
	) {
		const usage = argv[1] === "existing" ? EXISTING_CONFIGURE_USAGE : MANAGED_CONFIGURE_USAGE;
		(dependencies.stdout ?? process.stdout).write(usage);
		return 0;
	}
	if (isInstalledCommand(argv)) {
		const startConfiguredServer = dependencies.startConfiguredServer;
		return runInstalledCli(argv, {
			...dependencies,
			startServer:
				dependencies.startServer ??
				(startConfiguredServer
					? async config => startConfiguredServer(await buildResolvedInstalledAdapterServerOptions(config))
					: async config => startAdapterServer(await buildResolvedInstalledAdapterServerOptions(config))),
		});
	}
	try {
		const handle = await startAdapterServiceFromEnv();
		console.log(`openwebui-gjc-adapter listening on ${handle.url}`);
		installShutdownHandler(handle);
		return 0;
	} catch (error) {
		if (error instanceof Error) {
			console.error(error.message);
			return 1;
		}
		throw error;
	}
}

function isInstalledCommand(argv: readonly string[]): boolean {
	return (
		argv[0] === "configure" ||
		argv[0] === "probe-ready" ||
		argv[0] === "serve" ||
		(argv[0] === "credentials" && argv[1] === "show" && argv[2] === "adapter-token")
	);
}

function installShutdownHandler(handle: AdapterServerHandle): void {
	const stop = (): void => {
		handle.stop().then(
			() => process.exit(0),
			error => {
				if (error instanceof Error) {
					console.error(error.message);
				}
				process.exit(1);
			},
		);
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}

if (import.meta.main) {
	process.exitCode = await runCli();
}
