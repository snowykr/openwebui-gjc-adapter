import { resolve } from "node:path";
import { readSdkSessionEndpoint } from "@gajae-code/coding-agent/sdk";
import type { PublicSdkSessionAttachment } from "../gjc/public-sdk-contract";
import { attachmentFromPublishedSdkEndpoint, samePublishedSdkEndpoint } from "../gjc/public-sdk-session-port";
import { SdkV3OperationError } from "../gjc/sdk-v3-protocol";
import { loadAbsoluteGjcSessionFile, validateGjcSessionPathWithinRoot } from "../gjc/session-loader";
import type { GjcSessionAddress } from "../gjc/turn-runner";
import type { SessionAttachment } from "./gjc-routing-proof";
export const DEFAULT_SDK_ENDPOINT_PUBLICATION_TIMEOUT_MS = 10_000;
export const SDK_ENDPOINT_PUBLICATION_POLL_INTERVAL_MS = 100;

export function requireLifecycleAttachment(
	result: Awaited<ReturnType<import("../gjc/cli-lifecycle-backend").CliLifecycleBackend["create"]>>,
): import("../gjc/cli-lifecycle-backend").CliLifecycleAttachment {
	if (result.status === "closed") return result.value;
	throw new Error(`GJC CLI lifecycle is ${result.status}: ${result.message}`);
}

export function addressFor(
	input: import("../gjc/turn-runner").GjcStartNewSessionInput,
	sessionId: string,
): GjcSessionAddress {
	return {
		cwd: input.cwd,
		sessionRoot: input.sessionRoot,
		projectId: input.projectId,
		chatId: input.chatId,
		sessionId,
	};
}
export async function waitForSdkEndpoint(
	cwd: string,
	sessionId: string,
	timeoutMs = DEFAULT_SDK_ENDPOINT_PUBLICATION_TIMEOUT_MS,
): Promise<PublicSdkSessionAttachment> {
	const endpoint = await discoverPublishedSdkEndpoint(cwd, sessionId, timeoutMs);
	if (endpoint !== undefined) return endpoint;
	throw new Error(`GJC public SDK endpoint was not published for session ${sessionId} within ${timeoutMs}ms.`);
}

export async function readPublishedSdkEndpoint(
	cwd: string,
	sessionId: string,
): Promise<PublicSdkSessionAttachment | undefined> {
	const endpoint = await readSdkSessionEndpoint(cwd, sessionId);
	return endpoint === null ? undefined : attachmentFromPublishedSdkEndpoint(cwd, sessionId, endpoint);
}
export async function requireCurrentPublishedSdkEndpoint(
	cwd: string,
	expected: PublicSdkSessionAttachment,
): Promise<PublicSdkSessionAttachment> {
	const current = await readPublishedSdkEndpoint(cwd, expected.sessionId);
	if (current === undefined || !samePublishedSdkEndpoint(expected, current))
		throw new SdkV3OperationError(
			"endpoint_stale",
			"GJC public SDK endpoint descriptor disappeared or changed during lifecycle transaction",
		);
	return current;
}
export async function discoverPublishedSdkEndpoint(
	cwd: string,
	sessionId: string,
	timeoutMs = DEFAULT_SDK_ENDPOINT_PUBLICATION_TIMEOUT_MS,
): Promise<PublicSdkSessionAttachment | undefined> {
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
		throw new RangeError("SDK endpoint publication timeout must be a non-negative safe integer");
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const endpoint = await readPublishedSdkEndpoint(cwd, sessionId);
		if (endpoint !== undefined) return endpoint;
		const remaining = deadline - Date.now();
		if (remaining <= 0) return undefined;
		await Bun.sleep(Math.min(SDK_ENDPOINT_PUBLICATION_POLL_INTERVAL_MS, remaining));
	}
}

export async function validatePersistedSessionIdentity(
	input: GjcSessionAddress & { readonly sessionFile: string },
): Promise<void> {
	const sessionFile = validateGjcSessionPathWithinRoot(input.sessionRoot, input.sessionFile);
	const loaded = await loadAbsoluteGjcSessionFile(sessionFile);
	if (loaded.filePath !== sessionFile || loaded.header.id !== input.sessionId || loaded.header.cwd !== input.cwd)
		throw new SdkV3OperationError(
			"endpoint_stale",
			"Persisted GJC JSONL session identity does not match the requested attachment",
		);
}

export function attachmentKey<T extends { readonly cwd: string; readonly sessionId: string }>(input: T): string {
	return `${resolve(input.cwd)}\u0000${input.sessionId}`;
}

export function attachmentFor(
	input: GjcSessionAddress,
	attachment: Omit<SessionAttachment, "projectId">,
): SessionAttachment {
	const cwd = resolve(input.cwd);
	const sessionRoot = resolve(input.sessionRoot);
	if (attachment.cwd !== cwd || attachment.sessionRoot !== sessionRoot || attachment.sessionId !== input.sessionId)
		throw new SdkV3OperationError(
			"endpoint_stale",
			"CLI lifecycle attachment does not match the requested session address",
		);
	return { ...attachment, projectId: input.projectId };
}

export async function validateCachedAttachment(
	attachment: SessionAttachment,
	input: GjcSessionAddress & { readonly sessionFile?: string },
): Promise<void> {
	if (
		attachment.cwd !== resolve(input.cwd) ||
		attachment.sessionRoot !== resolve(input.sessionRoot) ||
		attachment.projectId !== input.projectId ||
		attachment.sessionId !== input.sessionId ||
		input.sessionFile === undefined
	)
		throw new SdkV3OperationError(
			"endpoint_stale",
			"Cached GJC attachment does not match the requested session address",
		);
	const cachedPath = validateGjcSessionPathWithinRoot(input.sessionRoot, attachment.sessionPath);
	const requestedPath = validateGjcSessionPathWithinRoot(input.sessionRoot, input.sessionFile);
	if (cachedPath !== requestedPath)
		throw new SdkV3OperationError(
			"endpoint_stale",
			"Cached GJC attachment session path does not match the persisted mapping",
		);
	await validatePersistedSessionIdentity({ ...input, sessionFile: cachedPath });
}
