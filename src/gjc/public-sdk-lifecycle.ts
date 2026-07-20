import { resolve } from "node:path";
import type { PublicSdkSessionAttachment } from "./public-sdk-contract";
import { assertPublishedSdkAttachmentCurrent, samePublishedSdkEndpoint, snapshotPublishedSdkEndpointGenerations, type PublishedSdkEndpointGenerations } from "./public-sdk-attachment";
import { parseRecord, requiredString, type SdkRecord, SdkV3OperationError, SdkV3ProtocolError } from "./sdk-v3-protocol";

export interface LifecycleHost {
	connected(): { readonly attachment: PublicSdkSessionAttachment };
	mutate(operation: string, input: SdkRecord, idempotencyKey?: string, timeoutMs?: number): Promise<unknown>;
	withAuthority<T>(timeoutMs: number | undefined, effect: () => Promise<T>, post?: "strict" | "allow_missing" | "skip"): Promise<T>;
	discover(predecessor: PublicSdkSessionAttachment, baseline: PublishedSdkEndpointGenerations, operation: string, target: string | undefined): Promise<PublicSdkSessionAttachment | undefined>;
	attach(attachment: PublicSdkSessionAttachment, timeoutMs?: number): Promise<void>;
	detach(): void;
	metadata(timeoutMs?: number): Promise<unknown>;
}
export async function sessionOperation(host: LifecycleHost, operation: string, input: SdkRecord, idempotencyKey?: string, timeoutMs?: number): Promise<PublicSdkSessionAttachment> {
	const predecessor = host.connected().attachment;
	const canonicalCwd = resolve(predecessor.cwd);
	const target = lifecycleTargetSessionId(operation, input);
	const control = lifecycleControlInput(operation, input, target);
	const remaining = createRemainingDeadline(operation, timeoutMs);
	const baseline = await snapshotPublishedSdkEndpointGenerations(canonicalCwd);
	const result = await host.withAuthority(
		remaining(),
		() => host.mutate(operation, control, idempotencyKey, remaining()),
		"skip",
	);
	assertLifecycleOperationResult(operation, result);
	host.detach();
	for (;;) {
		const discoveryPredecessor = {
			...predecessor,
			cwd: canonicalCwd,
		};
		const successor = await host.discover(
			discoveryPredecessor,
			baseline,
			operation,
			target,
		);
		if (successor !== undefined) {
			try {
				await host.attach(successor, remaining());
				const metadata = parseRecord(
					await host.metadata(remaining()),
					"session.metadata result",
				);
				assertSuccessorMetadata(metadata, successor, canonicalCwd);
				assertPublishedSdkAttachmentCurrent(successor);
				return successor;
			} catch (error) {
				host.detach();
				throw error;
			}
		}
		await sleep(remaining());
	}
}
export async function discoverLifecycleSuccessor(predecessor: PublicSdkSessionAttachment, baseline: PublishedSdkEndpointGenerations, operation: string, target: string | undefined): Promise<PublicSdkSessionAttachment | undefined> {
	const published = await snapshotPublishedSdkEndpointGenerations(predecessor.cwd);
	const candidates: PublicSdkSessionAttachment[] = [];
	for (const [sessionId, candidate] of published) {
		const previous = baseline.get(sessionId);
		const changed = previous === undefined
			|| !samePublishedSdkEndpoint(candidate, previous);
		if (target !== undefined) {
			if (sessionId === target && changed) {
				candidates.push(candidate);
			}
		} else if (sessionId !== predecessor.sessionId && previous === undefined) {
			candidates.push(candidate);
		}
	}
	if (candidates.length > 1) {
		throw new SdkV3OperationError(
			"endpoint_stale",
			`${operation} successor discovery is ambiguous`,
		);
	}
	if (candidates.length === 0) return undefined;
	const successor = candidates[0];
	if (target !== undefined && successor.sessionId !== target) {
		throw new SdkV3OperationError(
			"endpoint_stale",
			"Published successor does not match the requested session",
		);
	}
	return successor;
}
function assertLifecycleOperationResult(operation: string, value: unknown): void {
	const result = parseRecord(value, `${operation} result`);
	const successField = lifecycleSuccessField(operation);
	if (successField !== undefined) {
		if (result[successField] !== true) {
			throw new SdkV3ProtocolError(
				`${operation} result`,
				`${successField} must be true`,
			);
		}
		return;
	}
	if (isSuccessfulBranchResult(operation, result)) return;
	const message = operation === "session.branch"
		? "must contain selectedText and cancelled: false"
		: "unsupported lifecycle operation";
	throw new SdkV3ProtocolError(`${operation} result`, message);
}
function assertSuccessorMetadata(
	metadata: SdkRecord,
	successor: PublicSdkSessionAttachment,
	canonicalCwd: string,
): void {
	const sessionId = requiredString(
		metadata,
		"sessionId",
		"session.metadata result",
	);
	const cwd = requiredString(metadata, "cwd", "session.metadata result");
	if (sessionId !== successor.sessionId || cwd !== canonicalCwd) {
		throw new SdkV3OperationError(
			"endpoint_stale",
			"Session successor metadata does not match its published identity",
		);
	}
}
function lifecycleTargetSessionId(operation: string, input: SdkRecord): string | undefined {
	if (operation === "session.new" || operation === "session.branch") return undefined;
	if (typeof input.sessionId !== "string" || input.sessionId.length === 0) throw new SdkV3ProtocolError(`${operation} input`, "sessionId must be a non-empty string");
	return input.sessionId;
}
function lifecycleControlInput(operation: string, input: SdkRecord, target: string | undefined): SdkRecord {
	if (operation !== "session.resume" && operation !== "session.switch") return input;
	if (target === undefined || typeof input.sessionPath !== "string" || input.sessionPath.length === 0) throw new SdkV3ProtocolError(`${operation} input`, target === undefined ? "sessionId must be a non-empty string" : "sessionPath must be a non-empty string");
	return { id: resolve(input.sessionPath) };
}
function createRemainingDeadline(
	operation: string,
	timeoutMs: number | undefined,
): () => number {
	const deadline = Date.now() + (timeoutMs ?? 60_000);
	return () => {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new SdkV3OperationError(
				"timeout",
				`${operation} successor discovery timed out`,
			);
		}
		return remaining;
	};
}
function lifecycleSuccessField(operation: string): string | undefined {
	switch (operation) {
		case "session.new":
			return "created";
		case "session.resume":
			return "resumed";
		case "session.switch":
			return "switched";
		default:
			return undefined;
	}
}
function isSuccessfulBranchResult(operation: string, result: SdkRecord): boolean {
	return operation === "session.branch"
		&& typeof result.selectedText === "string"
		&& result.cancelled === false;
}
function sleep(timeoutMs: number): Promise<void> {
	return new Promise(resolve => {
		const timer = setTimeout(resolve, Math.min(25, timeoutMs));
		timer.unref?.();
	});
}
