import { queryOne } from "./public-sdk-authority";
import type {
	PublicSdkBranchCandidate,
	PublicSdkSessionAttachment,
	PublicSdkSessionState,
} from "./public-sdk-contract";
import type { SdkV3Client } from "./sdk-v3-client";
import {
	ensureCapabilityCatalog,
	parseRecord,
	parseState,
	requiredString,
	SdkV3ProtocolError,
} from "./sdk-v3-protocol";

export async function readSessionState(
	client: SdkV3Client,
	attachment: PublicSdkSessionAttachment,
	timeoutMs?: number,
): Promise<PublicSdkSessionState> {
	const [metadata, config, currentModels] = await Promise.all([
		queryOne(client, "session.metadata", timeoutMs),
		queryOne(client, "config.list/get", timeoutMs),
		client.queryAll("models.list/current", {}, timeoutMs),
	]);
	return parseState(metadata, config, currentModels, attachment);
}

export async function readAvailableModels(client: SdkV3Client, timeoutMs?: number): Promise<readonly unknown[]> {
	return ensureCapabilityCatalog(await client.queryAll("models.list/current", {}, timeoutMs));
}

export async function readBranchCandidates(
	client: SdkV3Client,
	timeoutMs?: number,
): Promise<readonly PublicSdkBranchCandidate[]> {
	const candidates: PublicSdkBranchCandidate[] = [];
	const seen = new Set<string>();
	for (const root of await client.queryAll("session.branch_candidates", {}, timeoutMs)) {
		collectCandidates(root, candidates, seen);
	}
	return candidates;
}

function collectCandidates(value: unknown, candidates: PublicSdkBranchCandidate[], seen: Set<string>): void {
	const node = parseRecord(value, "session.branch_candidates node");
	const entry = parseRecord(node.entry, "session.branch_candidates node.entry");
	const entryId = requiredString(entry, "id", "session.branch_candidates node.entry");
	if (seen.has(entryId)) {
		throw new SdkV3ProtocolError("session.branch_candidates response", `duplicate entry id: ${entryId}`);
	}
	seen.add(entryId);
	candidates.push({ entryId, source: entry });
	if (!Array.isArray(node.children)) {
		throw new SdkV3ProtocolError("session.branch_candidates node", "children must be an array");
	}
	for (const child of node.children) collectCandidates(child, candidates, seen);
}
