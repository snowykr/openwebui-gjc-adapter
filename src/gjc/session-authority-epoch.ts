import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

import {
	isSessionAuthorityV3Document,
	SESSION_AUTHORITY_V3_EPOCH,
	SESSION_AUTHORITY_V3_VERSION,
} from "./session-authority-v3";

const MAX_AUTHORITY_HEADER_BYTES = 16 * 1024 * 1024;

export type SessionAuthorityEpochStatus = "absent" | "v2" | "v3" | "blocked";
export type SessionAuthorityStoreSelection = "managed-bootstrap" | "managed-store" | "blocked";

export interface SessionAuthorityEpochProbe {
	readonly status: SessionAuthorityEpochStatus;
	readonly selection: SessionAuthorityStoreSelection;
}

/**
 * Reads and strictly parses the canonical authority through a held no-follow
 * descriptor. It neither opens a mapping store nor reads session transcripts or
 * artifacts. Active-marker validation is a separate caller responsibility.
 */
export function probeSessionAuthorityEpoch(canonicalAuthorityPath: string): SessionAuthorityEpochProbe {
	const named = lstatSync(canonicalAuthorityPath, { throwIfNoEntry: false });
	if (named === undefined) return absent();
	if (named.isSymbolicLink() || !named.isFile()) return blocked();

	let descriptor: number | undefined;
	try {
		descriptor = openSync(canonicalAuthorityPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const held = fstatSync(descriptor);
		if (!held.isFile() || held.size > MAX_AUTHORITY_HEADER_BYTES) return blocked();
		const bytes = Buffer.alloc(held.size);
		for (let offset = 0; offset < bytes.length; ) {
			const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
			if (read === 0) return blocked();
			offset += read;
		}
		const final = fstatSync(descriptor);
		if (!sameIdentity(held, final) || final.size !== bytes.length) return blocked();
		if (!currentPathHasIdentity(canonicalAuthorityPath, held)) return blocked();
		return classify(bytes);
	} catch {
		return blocked();
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

/** This decision intentionally prevents a v3 document reaching the legacy store. */
export function selectSessionAuthorityStore(probe: SessionAuthorityEpochProbe): SessionAuthorityStoreSelection {
	return probe.status === "v3" ? "managed-store" : probe.status === "blocked" ? "blocked" : "managed-bootstrap";
}

function classify(bytes: Buffer): SessionAuthorityEpochProbe {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		return blocked();
	}
	if (!isRecord(value) || value.kind !== "openwebui-gjc-session-authority") return blocked();
	if (value.version === 2) return { status: "v2", selection: "managed-bootstrap" };
	if (
		value.version !== SESSION_AUTHORITY_V3_VERSION ||
		value.authorityEpoch !== SESSION_AUTHORITY_V3_EPOCH ||
		!isSessionAuthorityV3Document(value)
	)
		return blocked();
	return { status: "v3", selection: "managed-store" };
}

function currentPathHasIdentity(path: string, held: ReturnType<typeof fstatSync>): boolean {
	let current: number | undefined;
	try {
		current = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stat = fstatSync(current);
		return stat.isFile() && sameIdentity(held, stat);
	} catch {
		return false;
	} finally {
		if (current !== undefined) closeSync(current);
	}
}

function sameIdentity(left: ReturnType<typeof fstatSync>, right: ReturnType<typeof fstatSync>): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absent(): SessionAuthorityEpochProbe {
	return { status: "absent", selection: "managed-bootstrap" };
}

function blocked(): SessionAuthorityEpochProbe {
	return { status: "blocked", selection: "blocked" };
}
