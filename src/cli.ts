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

First-install route:
  Shared: managed and existing both require user systemd and OpenWebUI >=0.10.0.
  managed   Requires rootful Docker with userns-remap disabled.
  existing  Uses an externally owned OpenWebUI deployment and provider setup;
            choose it for rootless Docker or Docker userns-remap incompatibilities.

Readiness:
  probe-ready checks adapter/OpenWebUI readiness only. It does not prove GJC
  provider authentication, usable models, or a successful first turn. Complete
  GJC provider/model onboarding separately; see route help and README.

Models:
  gjc/<encoded-provider>/<encoded-model>:<thinking>  Canonical GJC model id
  gjc  Input-only alias for the current machine-global default
`;
const EXISTING_CONFIGURE_USAGE = `Usage: openwebui-gjc-adapter configure existing [options]

Prerequisites before this command:
  Shared by managed and existing: user systemd and OpenWebUI >=0.10.0.
  For rootless Docker or Docker userns-remap incompatibilities, choose existing
  instead of managed; shared prerequisites still apply.
Required existing-route inputs:
  --openwebui-url URL          Existing OpenWebUI base URL
  --adapter-ingress-url URL    Adapter URL reachable from OpenWebUI
  --openwebui-api-token-fd FD  Distinct inherited decimal FD for the admin token

Project link locations:
  --project-root PATH          Allowed parent for linkable project directories
  Project directories must be readable/searchable. Existing session roots need
  read/write/search access; prospective roots need write/search access on the
  nearest existing ancestor.

Ownership:
  Provider connection, custom headers, ingress, and their operation remain
  manual and externally owned. The adapter validates the supplied OpenWebUI
  administration token; it does not configure that provider.

GJC runtime location options:
  --gjc-config-dir-name NAME   Set the persisted GJC config directory name
  --gjc-coding-agent-dir PATH  Set the persisted canonical coding-agent directory

FD safety: pass inherited descriptor numbers, never secret values. Keep setup
descriptors distinct and open for this process.

Precedence: persisted CLI values, adapter-namespaced environment values, then derived defaults.
Pending recovery values are authoritative for retries.
`;
const MANAGED_CONFIGURE_USAGE = `Usage: openwebui-gjc-adapter configure managed [options]

Prerequisites before this command:
  Shared by managed and existing: user systemd and OpenWebUI >=0.10.0.
  Managed additionally requires rootful Docker with Docker userns-remap disabled.
  Use configure existing for rootless Docker or Docker userns-remap
  incompatibilities only; shared prerequisites still apply.
Managed GJC runtime locations are fixed; runtime location overrides are rejected.
Required managed-route inputs:
  --admin-email-fd FD           Distinct inherited decimal FD for admin email
  --admin-password-fd FD        Distinct inherited decimal FD for admin password

FD safety: pass two distinct inherited decimal descriptor numbers, never secret
values. Managed configures only its owned OpenWebUI provider after adapter
readiness; GJC provider authentication and model onboarding remain GJC-owned.
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
					? async config => {
							const options = await buildResolvedInstalledAdapterServerOptions(config);
							try {
								return await startConfiguredServer(options);
							} catch (error) {
								await options.runtimeLock.release();
								throw error;
							}
						}
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
