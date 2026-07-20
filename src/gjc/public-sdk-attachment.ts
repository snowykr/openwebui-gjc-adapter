import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { basename, resolve } from "node:path";
import { listSdkSessionEndpoints, type readSdkSessionEndpoint } from "@gajae-code/coding-agent/sdk";
import type { PublicSdkSessionAttachment } from "./public-sdk-contract";
import { parsePublishedSdkEndpointDescriptor, SdkV3OperationError } from "./sdk-v3-protocol";

const MAX_PUBLISHED_SDK_ENDPOINT_DESCRIPTOR_BYTES = 16 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
type DescriptorStat = Readonly<{ dev: number; ino: number; size: number; mtimeMs: number }>;
export type PublishedSdkEndpointGenerations = ReadonlyMap<string, PublicSdkSessionAttachment>;

export function openPublishedDescriptor(path: string): number {
	try {
		return openSync(
			path,
			constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
		);
	} catch {
		throw new SdkV3OperationError(
			"endpoint_stale",
			"Published session endpoint descriptor cannot be opened without following links",
		);
	}
}
export function assertAttachmentAuthority(attachment: PublicSdkSessionAttachment): asserts attachment is PublicSdkSessionAttachment & { readonly authority: NonNullable<PublicSdkSessionAttachment["authority"]> } {
	const authority = attachment.authority;
	if (authority === undefined) throw new SdkV3OperationError("endpoint_stale", "Session attachment has no descriptor authority proof");
	if (!SHA256_HEX.test(authority.payloadDigest)) throw new SdkV3OperationError("endpoint_stale", "Session attachment has an invalid descriptor payload digest");
}
export function readHeldDescriptor(descriptor: number, expectedSize: number): Buffer {
	if (!Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > MAX_PUBLISHED_SDK_ENDPOINT_DESCRIPTOR_BYTES)
		throw new SdkV3OperationError("endpoint_stale", `Published session endpoint descriptor size must be between 0 and ${MAX_PUBLISHED_SDK_ENDPOINT_DESCRIPTOR_BYTES} bytes`);
	const bytes = Buffer.alloc(expectedSize);
	let offset = 0;
	while (offset < bytes.length) {
		const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
		if (read === 0) throw new SdkV3OperationError("endpoint_stale", "Published session endpoint descriptor ended before its validated size");
		offset += read;
	}
	if (fstatSync(descriptor).size !== expectedSize) throw new SdkV3OperationError("endpoint_stale", "Published session endpoint descriptor size changed while it was read");
	return bytes;
}
export function descriptorPayloadDigest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
export function sameDescriptorStat(left: DescriptorStat, right: DescriptorStat): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}
export function assertPublishedSdkAttachmentCurrent(attachment: PublicSdkSessionAttachment): void {
	assertAttachmentAuthority(attachment);
	const authority = attachment.authority;
	const descriptor = openPublishedDescriptor(authority.descriptorPath);
	try {
		const stat = fstatSync(descriptor);
		if (!sameDescriptorStat(stat, authority.descriptorStat) || authority.generation !== authority.descriptorStat.mtimeMs) throw new SdkV3OperationError("endpoint_stale", "Session endpoint descriptor changed after attachment");
		if (descriptorPayloadDigest(readHeldDescriptor(descriptor, authority.descriptorStat.size)) !== authority.payloadDigest) throw new SdkV3OperationError("endpoint_stale", "Session endpoint descriptor payload changed after attachment");
		const named = lstatSync(authority.descriptorPath);
		if (!named.isFile() || !sameDescriptorStat(named, authority.descriptorStat)) throw new SdkV3OperationError("endpoint_stale", "Session endpoint descriptor changed after attachment");
	} finally {
		closeSync(descriptor);
	}
}
export function attachmentFromPublishedSdkEndpoint(cwd: string, sessionId: string, endpoint: NonNullable<Awaited<ReturnType<typeof readSdkSessionEndpoint>>>): PublicSdkSessionAttachment {
	const canonicalCwd = resolve(cwd);
	if (endpoint.sessionId !== sessionId) throw new SdkV3OperationError("endpoint_stale", `Published endpoint identity ${endpoint.sessionId} does not match ${sessionId}`);
	if (basename(endpoint.path) !== `${sessionId}.json`) throw new SdkV3OperationError("endpoint_stale", "Published session endpoint path does not match the expected session");
	const descriptor = openPublishedDescriptor(endpoint.path);
	try {
		try {
			const opened = fstatSync(descriptor);
			if (!opened.isFile()) throw new SdkV3OperationError("endpoint_stale", "Published session endpoint descriptor is not a regular file");
			const bytes = readHeldDescriptor(descriptor, opened.size);
			const descriptorStat = fstatSync(descriptor);
			if (!sameDescriptorStat(opened, descriptorStat)) throw new SdkV3OperationError("endpoint_stale", "Published session endpoint descriptor changed while it was read");
			const named = lstatSync(endpoint.path);
			if (!named.isFile() || !sameDescriptorStat(named, descriptorStat)) throw new SdkV3OperationError("endpoint_stale", "Published session endpoint descriptor changed during discovery");
			const attachment = createPublishedSdkAttachment(
				canonicalCwd,
				sessionId,
				endpoint.path,
				descriptorStat,
				bytes,
			);
			return attachment;
		} catch (error) {
			throwPublishedDescriptorValidationError(error);
		}
	} finally {
		closeSync(descriptor);
	}
}
export async function snapshotPublishedSdkEndpointGenerations(cwd: string): Promise<PublishedSdkEndpointGenerations> {
	const published = await listSdkSessionEndpoints(cwd);
	if (published.warnings.length !== 0) throw new SdkV3OperationError("endpoint_stale", "Published session endpoint discovery returned warnings");
	const generations = new Map<string, PublicSdkSessionAttachment>();
	for (const endpoint of published.endpoints) {
		if (generations.has(endpoint.sessionId)) throw new SdkV3OperationError("endpoint_stale", "Published session endpoint discovery contains duplicate session identities");
		generations.set(endpoint.sessionId, attachmentFromPublishedSdkEndpoint(cwd, endpoint.sessionId, endpoint));
	}
	return generations;
}
export function samePublishedSdkEndpoint(left: PublicSdkSessionAttachment, right: PublicSdkSessionAttachment): boolean {
	const a = left.authority;
	const b = right.authority;
	return a !== undefined && b !== undefined && left.sessionId === right.sessionId && left.cwd === right.cwd && left.endpoint.url === right.endpoint.url && left.endpoint.token === right.endpoint.token && a.descriptorPath === b.descriptorPath && sameDescriptorStat(a.descriptorStat, b.descriptorStat) && a.payloadDigest === b.payloadDigest && a.expectedSessionId === b.expectedSessionId && a.expectedCwd === b.expectedCwd;
}
function createPublishedSdkAttachment(
	cwd: string,
	sessionId: string,
	descriptorPath: string,
	descriptorStat: DescriptorStat,
	bytes: Buffer,
): PublicSdkSessionAttachment {
	const endpoint = parsePublishedSdkEndpointDescriptor(
		bytes.toString("utf8"),
		"published session endpoint descriptor",
	);
	return {
		sessionId,
		cwd,
		endpoint,
		authority: {
			descriptorPath,
			descriptorStat: {
				dev: descriptorStat.dev,
				ino: descriptorStat.ino,
				size: descriptorStat.size,
				mtimeMs: descriptorStat.mtimeMs,
			},
			payloadDigest: descriptorPayloadDigest(bytes),
			generation: descriptorStat.mtimeMs,
			expectedSessionId: sessionId,
			expectedCwd: cwd,
		},
	};
}
function throwPublishedDescriptorValidationError(error: unknown): never {
	if (error instanceof SdkV3OperationError) throw error;
	throw new SdkV3OperationError(
		"endpoint_stale",
		"Published session endpoint descriptor cannot be stably validated",
	);
}
