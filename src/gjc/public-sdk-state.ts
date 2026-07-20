import type { NormalizedModelSelection } from "../contracts";
import type { PublicSdkBranchCandidate, PublicSdkSessionAttachment, PublicSdkSessionState } from "./public-sdk-contract";
import { ensureCapabilityCatalog, parseRecord, parseSelection, parseState, requiredString, SdkV3OperationError, SdkV3ProtocolError } from "./sdk-v3-protocol";
import { queryOne } from "./public-sdk-authority";
import type { SdkV3Client } from "./sdk-v3-client";

export async function readSessionState(
	client: SdkV3Client,
	attachment: PublicSdkSessionAttachment,
	timeoutMs?: number,
): Promise<PublicSdkSessionState> {
	const [metadata, config] = await Promise.all([
		queryOne(client, "session.metadata", timeoutMs),
		queryOne(client, "config.list/get", timeoutMs),
	]);
	return parseState(metadata, config, attachment);
}

export async function readAvailableModels(client: SdkV3Client, timeoutMs?: number): Promise<readonly unknown[]> {
	return ensureCapabilityCatalog(await client.queryAll("models.list/current", {}, timeoutMs));
}

export async function readBranchCandidates(client: SdkV3Client, timeoutMs?: number): Promise<readonly PublicSdkBranchCandidate[]> {
	const candidates: PublicSdkBranchCandidate[] = [];
	const seen = new Set<string>();
	for (const root of await client.queryAll("session.branch_candidates", {}, timeoutMs)) {
		collectCandidates(root, candidates, seen);
	}
	return candidates;
}

export async function confirmSelection(
	client: SdkV3Client,
	expected: NormalizedModelSelection | undefined,
	timeoutMs?: number,
): Promise<NormalizedModelSelection> {
	const current = (await client.queryAll("models.list/current", {}, timeoutMs)).filter(item => {
		return parseRecord(item, "models.list/current result").current === true;
	});
	if (current.length !== 1) {
		throw new SdkV3OperationError("invalid_result", `models.list/current returned ${current.length} current models`);
	}
	const model = parseRecord(current[0], "models.list/current current result");
	const provider = requiredString(model, "provider", "models.list/current current result");
	if (provider.includes("/")) {
		throw new SdkV3OperationError("invalid_result", "models.list/current current provider contains /");
	}
	const modelId = requiredString(model, "id", "models.list/current current result");
	const selection = parseSelection({
		provider,
		modelId,
		thinkingLevel: requiredString(model, "currentThinkingLevel", "models.list/current current result"),
	});
	if (
		expected !== undefined &&
		(selection.provider !== expected.provider || selection.modelId !== expected.modelId || selection.thinkingLevel !== expected.thinkingLevel)
	) {
		throw new SdkV3OperationError("invalid_result", "models.list/current did not confirm the mutation result");
	}
	return selection;
}

export function parseMutationSelection(value: unknown): NormalizedModelSelection {
	return parseSelection(value);
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
