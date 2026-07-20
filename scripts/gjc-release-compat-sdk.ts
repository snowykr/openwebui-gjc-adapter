import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SdkClient } from "@gajae-code/coding-agent/sdk";

export const lifecycleDeadlineMs = 15_000;
export type PublishedEndpoint = { readonly sessionId: string; readonly url: string; readonly token: string; readonly descriptor: string };
export type LifecycleAttachment = { readonly client: SdkClient; readonly sessionId: string; readonly cwd: string; readonly endpoint: PublishedEndpoint };
type Observe = (name: string, action: () => Promise<unknown>) => Promise<unknown>;

export async function connectFor(directory: string, sessionId: string): Promise<SdkClient> {
	const endpoint = await endpointFor(directory, sessionId);
	return SdkClient.connect(endpoint.url, endpoint.token, { timeoutMs: lifecycleDeadlineMs });
}

export async function endpointFor(directory: string, sessionId: string): Promise<PublishedEndpoint> {
	const endpoint = (await snapshotPublicEndpoints(directory)).get(sessionId);
	if (endpoint === undefined) throw new Error(`public SDK endpoint was not published for ${sessionId}`);
	return endpoint;
}

export async function snapshotPublicEndpoints(directory: string): Promise<Map<string, PublishedEndpoint>> {
	const stateDirectory = join(directory, ".gjc", "state", "sdk");
	const endpoints = new Map<string, PublishedEndpoint>();
	try {
		for (const entry of await readdir(stateDirectory)) {
			if (!entry.endsWith(".json")) continue;
			const descriptor = join(stateDirectory, entry);
			const value: unknown = JSON.parse(await readFile(descriptor, "utf8"));
			if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.url !== "string" || typeof value.token !== "string") continue;
			if (entry !== `${value.sessionId}.json`) throw new Error(`public SDK endpoint descriptor identity is ambiguous: ${entry}`);
			if (endpoints.has(value.sessionId)) throw new Error(`duplicate public SDK endpoint for ${value.sessionId}`);
			endpoints.set(value.sessionId, { sessionId: value.sessionId, url: value.url, token: value.token, descriptor });
		}
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return endpoints;
		throw error;
	}
	return endpoints;
}

export function endpointFingerprint(endpoint: PublishedEndpoint): string {
	return `${endpoint.sessionId}\u0000${endpoint.url}\u0000${endpoint.token}`;
}

export async function lifecycleSuccessor(
	client: SdkClient | undefined, operation: "session.new" | "session.resume" | "session.switch", input: Record<string, unknown>,
	workspace: string, observe: Observe, record: (name: string, value: unknown) => void, expectedSessionId?: string,
): Promise<LifecycleAttachment> {
	if (client === undefined) throw new Error(`${operation} cannot run without an attached released public SDK controller`);
	const deadline = Date.now() + lifecycleDeadlineMs;
	const remaining = () => {
		const timeoutMs = deadline - Date.now();
		if (timeoutMs <= 0) throw new Error(`released public SDK ${operation} lifecycle deadline exhausted`);
		return timeoutMs;
	};
	const before = await snapshotPublicEndpoints(workspace);
	const accepted = await observe(operation, () => client.control(operation, input, { timeoutMs: remaining() }));
	assertLifecycleAcknowledgement(operation, accepted);
	await awaitLifecycleDeadline(client.close().catch(() => undefined), remaining);
	const requestedSessionId = operation === "session.new" ? undefined : expectedSessionId;
	if (operation !== "session.new" && requestedSessionId === undefined) throw new Error(`${operation} requires an expected target sessionId`);
	const endpoint = await discoverSuccessorEndpoint(workspace, before, operation, requestedSessionId, remaining);
	const successor = await SdkClient.connect(endpoint.url, endpoint.token, { deadline, timeoutMs: remaining() });
	try {
		const metadata = sessionMetadataFrom(await observe(`${operation}.session.metadata`, () => awaitLifecycleDeadline(successor.query("session.metadata", {}, undefined, { timeoutMs: remaining() }), remaining)));
		if (typeof metadata.sessionId !== "string" || typeof metadata.cwd !== "string") throw new Error(`released public SDK ${operation} successor lacks a session.metadata sessionId/cwd contract`);
		if (metadata.sessionId !== endpoint.sessionId || metadata.cwd !== workspace) throw new Error(`released public SDK ${operation} reattached to a metadata-mismatched endpoint`);
		if (requestedSessionId !== undefined && metadata.sessionId !== requestedSessionId) throw new Error(`released public SDK ${operation} reattached to the wrong target session`);
		record(`${operation}.reattached`, {
			previousEndpointCount: before.size, descriptor: endpoint.descriptor, sessionId: metadata.sessionId, cwd: metadata.cwd,
			targetSessionId: requestedSessionId,
		});
		return { client: successor, sessionId: metadata.sessionId, cwd: metadata.cwd, endpoint };
	} catch (error) {
		await successor.close().catch(() => undefined);
		throw error;
	}
}

function sessionMetadataFrom(value: unknown): Record<string, unknown> {
	if (!isRecord(value) || value.ok !== true || !isRecord(value.page) || value.page.complete !== true || !Array.isArray(value.page.items)) throw new Error("released public SDK session.metadata returned an incomplete or unsuccessful response");
	if (value.page.items.length !== 1 || !isRecord(value.page.items[0])) throw new Error("released public SDK session.metadata response must contain exactly one metadata item");
	return value.page.items[0];
}

function assertLifecycleAcknowledgement(operation: string, value: unknown): void {
	if (!isRecord(value) || !isRecord(value.result)) throw new Error(`released public SDK ${operation} returned a non-object acknowledgement${isRecord(value) ? " result" : ""}`);
	const field = operation === "session.new" ? "created" : operation === "session.resume" ? "resumed" : "switched";
	if (value.result[field] !== true) throw new Error(`released public SDK ${operation} acknowledgement omitted ${field}: true`);
}

function awaitLifecycleDeadline<T>(promise: Promise<T>, remaining: () => number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("released public SDK lifecycle deadline exhausted")), remaining());
		timeout.unref?.();
		void promise.then(value => { clearTimeout(timeout); resolve(value); }, error => { clearTimeout(timeout); reject(error); });
	});
}

async function discoverSuccessorEndpoint(directory: string, before: ReadonlyMap<string, PublishedEndpoint>, operation: "session.new" | "session.resume" | "session.switch", targetSessionId: string | undefined, remaining: () => number): Promise<PublishedEndpoint> {
	for (;;) {
		remaining();
		const after = await snapshotPublicEndpoints(directory);
		if (operation !== "session.new") {
			if (targetSessionId === undefined) throw new Error(`${operation} requires a target id`);
			const endpoint = after.get(targetSessionId);
			if (endpoint !== undefined) return endpoint;
		} else {
			const candidates = [...after.values()].filter(endpoint => {
				const previous = before.get(endpoint.sessionId);
				return previous === undefined || endpointFingerprint(previous) !== endpointFingerprint(endpoint);
			});
			if (candidates.length === 1) return candidates[0]!;
			if (candidates.length > 1) throw new Error(`public SDK successor discovery is ambiguous (${candidates.length} endpoints)`);
		}
		await Bun.sleep(Math.min(100, remaining()));
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
