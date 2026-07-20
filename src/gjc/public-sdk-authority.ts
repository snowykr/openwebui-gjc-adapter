import { closeSync, fstatSync, lstatSync } from "node:fs";
import type { PublicSdkSessionAttachment } from "./public-sdk-contract";
import {
	assertAttachmentAuthority,
	descriptorPayloadDigest,
	openPublishedDescriptor,
	readHeldDescriptor,
} from "./public-sdk-attachment";
import type { SdkV3Client } from "./sdk-v3-client";
import { SdkV3OperationError } from "./sdk-v3-protocol";

export interface PublicSdkClientContext {
	readonly client: SdkV3Client;
	readonly attachment: PublicSdkSessionAttachment;
	readonly isCurrent: () => boolean;
}

export async function withPublicSdkAuthority<T>(
	context: PublicSdkClientContext,
	timeoutMs: number | undefined,
	effect: (client: SdkV3Client) => Promise<T>,
	post: "strict" | "allow_missing" | "skip" = "strict",
): Promise<T> {
	const { attachment, client } = context;
	assertAttachmentAuthority(attachment);
	const authority = attachment.authority;
	const descriptor = openPublishedDescriptor(authority.descriptorPath);
	try {
		assertDescriptorStat(fstatSync(descriptor), authority);
		assertDescriptorPayload(descriptor, authority);
		const metadata = await queryOne(client, "session.metadata", timeoutMs);
		assertIdentity(metadata, attachment, authority, context);
		assertDescriptorStat(fstatSync(descriptor), authority);
		assertDescriptorPayload(descriptor, authority);
		assertDescriptorStat(lstatSync(authority.descriptorPath), authority);
		const result = await effect(client);
		if (post === "skip") return result;
		assertDescriptorStat(fstatSync(descriptor), authority);
		assertDescriptorPayload(descriptor, authority);
		try {
			assertDescriptorStat(lstatSync(authority.descriptorPath), authority);
		} catch (error) {
			if (post !== "allow_missing" || !isMissing(error)) throw error;
		}
		return result;
	} finally {
		closeSync(descriptor);
	}
}

export async function queryOne(
	client: SdkV3Client,
	query: string,
	timeoutMs?: number,
): Promise<unknown> {
	const items = await client.queryAll(query, {}, timeoutMs);
	if (items.length !== 1) {
		throw new SdkV3OperationError("invalid_result", `${query} returned ${items.length} items`);
	}
	return items[0];
}

function assertIdentity(
	metadata: unknown,
	attachment: PublicSdkSessionAttachment,
	authority: NonNullable<PublicSdkSessionAttachment["authority"]>,
	context: PublicSdkClientContext,
): void {
	if (
		typeof metadata !== "object" || metadata === null ||
		Reflect.get(metadata, "sessionId") !== authority.expectedSessionId ||
		Reflect.get(metadata, "cwd") !== authority.expectedCwd ||
		authority.expectedSessionId !== attachment.sessionId ||
		authority.expectedCwd !== attachment.cwd || !context.isCurrent()
	) {
		throw new SdkV3OperationError("endpoint_stale", "Session endpoint identity changed after attachment");
	}
}

function assertDescriptorPayload(
	descriptor: number,
	authority: NonNullable<PublicSdkSessionAttachment["authority"]>,
): void {
	if (descriptorPayloadDigest(readHeldDescriptor(descriptor, authority.descriptorStat.size)) !== authority.payloadDigest) {
		throw new SdkV3OperationError("endpoint_stale", "Session endpoint descriptor payload changed after attachment");
	}
}

function assertDescriptorStat(
	current: Readonly<{ dev: number; ino: number; size: number; mtimeMs: number }>,
	authority: NonNullable<PublicSdkSessionAttachment["authority"]>,
): void {
	if (
		current.dev !== authority.descriptorStat.dev ||
		current.ino !== authority.descriptorStat.ino ||
		current.size !== authority.descriptorStat.size ||
		current.mtimeMs !== authority.descriptorStat.mtimeMs ||
		authority.generation !== authority.descriptorStat.mtimeMs
	) {
		throw new SdkV3OperationError("endpoint_stale", "Session endpoint descriptor changed after attachment");
	}
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT";
}
