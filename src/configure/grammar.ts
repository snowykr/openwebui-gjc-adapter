export type ConfigureMode = "managed" | "existing";
export type CliCommand =
	| { kind: "configure"; mode: ConfigureMode; options: Record<string, string | boolean> }
	| { kind: "serve"; options: Record<string, string | boolean> }
	| { kind: "probe-ready"; options?: Record<string, string | boolean> }
	| { kind: "credentials-show-adapter-token"; options?: Record<string, string | boolean> };
export class CliUsageError extends Error {
	readonly exitCode = 2;
	constructor(message: string) {
		super(message);
		this.name = "CliUsageError";
	}
}
const optionNames = new Set([
	"config",
	"admin-email-fd",
	"admin-password-fd", // ggignore: CLI option name; credential values only arrive through an inherited FD.
	"openwebui-api-token-fd",
	"adapter-ingress-url",
	"bind-host",
	"bind-port",
	"ui-port",
	"openwebui-url",
	"project-root",
	"gjc-config-dir-name",
	"gjc-coding-agent-dir",
	"reset",
	"reset-proof",
]);
const fdNames = ["admin-email-fd", "admin-password-fd", "openwebui-api-token-fd"]; // ggignore: CLI option names, not credential values.
function option(options: Record<string, string | boolean>, name: string): string | undefined {
	const value = options[name];
	return typeof value === "string" ? value : undefined;
}
export function parseCliArguments(argv: readonly string[]): CliCommand {
	if (argv.length === 0) return { kind: "serve", options: {} };
	if (argv[0] === "serve") {
		if (argv.length === 1) return { kind: "serve", options: {} };
		if (argv.length === 3 && argv[1] === "--config" && argv[2])
			return { kind: "serve", options: { config: argv[2] } };
		if (argv.length === 2 && argv[1].startsWith("--config=") && argv[1].slice(9))
			return { kind: "serve", options: { config: argv[1].slice(9) } };
		throw new CliUsageError("serve accepts only --config=PATH");
	}
	if (argv[0] === "probe-ready") {
		if (argv.length === 1) return { kind: "probe-ready" };
		if (argv.length === 3 && argv[1] === "--config" && argv[2])
			return { kind: "probe-ready", options: { config: argv[2] } };
		if (argv.length === 2 && argv[1].startsWith("--config=") && argv[1].slice(9))
			return { kind: "probe-ready", options: { config: argv[1].slice(9) } };
		throw new CliUsageError("probe-ready accepts only --config=PATH");
	}
	if (argv[0] === "credentials" && argv[1] === "show" && argv[2] === "adapter-token") {
		if (argv.length === 3) return { kind: "credentials-show-adapter-token", options: {} };
		if (argv.length === 5 && argv[3] === "--config" && argv[4])
			return { kind: "credentials-show-adapter-token", options: { config: argv[4] } };
		if (argv.length === 4 && argv[3].startsWith("--config=") && argv[3].slice(9))
			return { kind: "credentials-show-adapter-token", options: { config: argv[3].slice(9) } };
		throw new CliUsageError("credentials show adapter-token accepts only --config=PATH");
	}
	const mode: ConfigureMode | undefined =
		argv[1] === "managed" || argv[1] === "existing"
			? argv[1]
			: argv[1] === "--managed"
				? "managed"
				: argv[1] === "--existing"
					? "existing"
					: undefined;
	if (argv[0] !== "configure" || !mode)
		throw new CliUsageError(
			"expected configure managed|existing, serve, probe-ready, or credentials show adapter-token",
		);
	const options: Record<string, string | boolean> = {};
	for (let i = 2; i < argv.length; i++) {
		const argument = argv[i];
		if (!argument.startsWith("--")) throw new CliUsageError(`unexpected argument: ${argument}`);
		const equals = argument.indexOf("=");
		const name = equals < 0 ? argument.slice(2) : argument.slice(2, equals);
		if (!optionNames.has(name)) throw new CliUsageError(`unknown option: --${name}`);
		if (name === "bind-host")
			throw new CliUsageError("--bind-host is not supported; the adapter bind host is selected by deployment mode");
		if (name === "reset" && equals < 0) {
			options[name] = true;
			continue;
		}
		const value = equals < 0 ? argv[++i] : argument.slice(equals + 1);
		if (!value || value.startsWith("--")) throw new CliUsageError(`option --${name} requires a value`);
		options[name] = value;
	}
	if (
		mode === "managed" &&
		(options["openwebui-api-token-fd"] !== undefined || options["adapter-ingress-url"] !== undefined)
	)
		throw new CliUsageError("managed configuration does not accept existing-route credentials");
	if (mode === "managed" && options["openwebui-url"] !== undefined)
		throw new CliUsageError("managed configuration does not accept openwebui-url");
	if (mode === "managed" && options["bind-port"] !== undefined)
		throw new CliUsageError("managed configuration does not accept bind-port customization");
	if (
		mode === "managed" &&
		(options["gjc-config-dir-name"] !== undefined || options["gjc-coding-agent-dir"] !== undefined)
	)
		throw new CliUsageError("managed configuration does not accept GJC runtime location overrides");
	if (mode === "existing" && (options["admin-email-fd"] !== undefined || options["admin-password-fd"] !== undefined))
		throw new CliUsageError("existing configuration does not accept managed admin credentials");
	if (mode === "existing" && options["ui-port"] !== undefined)
		throw new CliUsageError("existing configuration does not accept ui-port");
	const descriptors = fdNames.map(name => option(options, name)).filter((v): v is string => v !== undefined);
	if (descriptors.some(value => !/^(?:0|[1-9][0-9]*)$/.test(value)))
		throw new CliUsageError("secret FD must be a decimal integer");
	if (new Set(descriptors).size !== descriptors.length)
		throw new CliUsageError("secret FDs must be distinct inherited descriptors");
	return { kind: "configure", mode, options };
}
