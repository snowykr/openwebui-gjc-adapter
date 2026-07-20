import { accessSync, constants, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { GJC_RUNTIME_LOCATION_ENV, type GjcRuntimeLocations } from "../contracts";
import { type InstalledConfig, validateGjcCodingAgentDir, validateGjcConfigDirName } from "./installed-config-schema";

type InstalledRuntimeLocationFields = Readonly<Pick<InstalledConfig, "gjcConfigDirName" | "gjcCodingAgentDir">>;

export type ResolveGjcRuntimeLocationsInput =
	| { readonly mode: "managed" }
	| {
			readonly mode: "existing";
			readonly serviceHome?: string;
			readonly installedConfig?: InstalledRuntimeLocationFields;
			readonly environment?: Readonly<Record<string, string | undefined>>;
	  };

export class GjcRuntimeLocationError extends Error {
	readonly name = "GjcRuntimeLocationError";
	readonly code = "gjc_runtime_location_invalid";
}

function freezeLocations(input: {
	readonly home: string;
	readonly configDomain: string;
	readonly agentDir: string;
	readonly readerWorkspace: string;
	readonly readerSessionRoot: string;
	readonly configDirName: string;
}): GjcRuntimeLocations {
	const protectedProjectPaths = Object.freeze([
		input.configDomain,
		input.agentDir,
		input.readerWorkspace,
		input.readerSessionRoot,
	] as const);
	const childEnvironment = Object.freeze({
		HOME: input.home,
		GJC_CONFIG_DIR: input.configDirName,
		GJC_CODING_AGENT_DIR: input.agentDir,
	});
	return Object.freeze({
		home: input.home,
		configDomain: input.configDomain,
		agentDir: input.agentDir,
		readerWorkspace: input.readerWorkspace,
		readerSessionRoot: input.readerSessionRoot,
		protectedProjectPaths,
		childEnvironment,
	});
}

function canonicalExistingWritableDirectory(value: string, fieldName: string): string {
	try {
		if (!isAbsolute(value) || resolve(value) !== value) throw new GjcRuntimeLocationError("invalid path");
		const canonical = realpathSync(value);
		if (canonical !== value || !statSync(canonical).isDirectory())
			throw new GjcRuntimeLocationError("invalid directory");
		accessSync(canonical, constants.W_OK);
		return canonical;
	} catch (error) {
		if (error instanceof GjcRuntimeLocationError && error.message.startsWith(`${fieldName} `)) throw error;
		if (error instanceof Error)
			throw new GjcRuntimeLocationError(`${fieldName} must be a canonical existing writable directory`);
		throw error;
	}
}

function overlaps(left: string, right: string): boolean {
	const relation = relative(left, right);
	const reverse = relative(right, left);
	return (
		relation === "" ||
		(!relation.startsWith("..") && !isAbsolute(relation)) ||
		(!reverse.startsWith("..") && !isAbsolute(reverse))
	);
}

function provisionDerivedDirectory(path: string, fieldName: string): string {
	const entry = lstatSync(path, { throwIfNoEntry: false });
	if (entry === undefined) mkdirSync(path, { mode: 0o700 });
	else if (entry.isSymbolicLink() || !entry.isDirectory())
		throw new GjcRuntimeLocationError(`${fieldName} must be a canonical existing writable directory`);
	return canonicalExistingWritableDirectory(path, fieldName);
}

function resolveManagedLocations(): GjcRuntimeLocations {
	const home = "/var/lib/gjc/home";
	const configDomain = join(home, ".gjc");
	const readerWorkspace = join(configDomain, "openwebui", "default-reader");
	return freezeLocations({
		home,
		configDomain,
		agentDir: join(configDomain, "agent"),
		readerWorkspace,
		readerSessionRoot: join(readerWorkspace, ".gjc", "sessions"),
		configDirName: ".gjc",
	});
}

export function resolveGjcRuntimeLocations(input: ResolveGjcRuntimeLocationsInput): GjcRuntimeLocations {
	if (input.mode === "managed") return resolveManagedLocations();
	const environment = input.environment ?? process.env;
	const serviceHome = input.serviceHome ?? environment.HOME;
	if (serviceHome === undefined)
		throw new GjcRuntimeLocationError("service HOME must be a canonical existing writable directory");
	const home = canonicalExistingWritableDirectory(serviceHome, "service HOME");
	let configDirName: string;
	try {
		configDirName = validateGjcConfigDirName(
			input.installedConfig?.gjcConfigDirName ?? environment[GJC_RUNTIME_LOCATION_ENV.configDirName] ?? ".gjc",
		);
	} catch (error) {
		if (error instanceof Error) throw new GjcRuntimeLocationError(error.message);
		throw error;
	}
	const configDomain = join(home, configDirName);
	const readerWorkspace = join(configDomain, "openwebui", "default-reader");
	const readerSessionRoot = join(readerWorkspace, ".gjc", "sessions");
	const explicitAgent =
		input.installedConfig?.gjcCodingAgentDir ?? environment[GJC_RUNTIME_LOCATION_ENV.codingAgentDir];
	let agentDir = join(configDomain, "agent");
	if (explicitAgent !== undefined) {
		try {
			agentDir = canonicalExistingWritableDirectory(validateGjcCodingAgentDir(explicitAgent), "gjcCodingAgentDir");
		} catch (error) {
			if (error instanceof GjcRuntimeLocationError) throw error;
			if (error instanceof Error) throw new GjcRuntimeLocationError(error.message);
			throw error;
		}
		if ([configDomain, readerWorkspace, readerSessionRoot].some(path => overlaps(agentDir, path)))
			throw new GjcRuntimeLocationError("gjcCodingAgentDir must not overlap derived GJC runtime locations");
	}
	const resolvedConfigDomain = provisionDerivedDirectory(configDomain, "configDomain");
	if (explicitAgent === undefined) agentDir = provisionDerivedDirectory(agentDir, "gjcCodingAgentDir");
	provisionDerivedDirectory(join(configDomain, "openwebui"), "readerRoot");
	const resolvedReaderWorkspace = provisionDerivedDirectory(readerWorkspace, "readerWorkspace");
	provisionDerivedDirectory(join(readerWorkspace, ".gjc"), "readerConfigDomain");
	const resolvedReaderSessionRoot = provisionDerivedDirectory(readerSessionRoot, "readerSessionRoot");
	return freezeLocations({
		home,
		configDomain: resolvedConfigDomain,
		agentDir,
		readerWorkspace: resolvedReaderWorkspace,
		readerSessionRoot: resolvedReaderSessionRoot,
		configDirName,
	});
}
