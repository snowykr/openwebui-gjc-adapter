import type { NormalizedModelSelection } from "../contracts";
import type { PublicSdkSessionAttachment } from "./public-sdk-contract";
import { createPublicSdkDeadline } from "./public-sdk-deadline";
import { parseMutationSelection } from "./public-sdk-state";
import { waitForReply } from "./public-sdk-turns";
import type { SdkV3Client } from "./sdk-v3-client";
import { parseRecord, type SdkRecord, SdkV3OperationError } from "./sdk-v3-protocol";

export interface PublicSdkActionHost {
	authority<T>(
		timeoutMs: number,
		effect: (client: SdkV3Client) => Promise<T>,
		post?: "strict" | "allow_missing",
	): Promise<T>;
	mutate(
		client: SdkV3Client,
		operation: string,
		input: SdkRecord,
		key: string | undefined,
		timeoutMs: number,
	): Promise<unknown>;
	selectedModel(): NormalizedModelSelection | undefined;
	setSelectedModel(selection: NormalizedModelSelection | undefined): void;
	detach(): void;
	connected(): { readonly client: SdkV3Client; readonly attachment: PublicSdkSessionAttachment };
}

export async function setModel(
	host: PublicSdkActionHost,
	selection: NormalizedModelSelection,
	key: string | undefined,
	timeoutMs: number | undefined,
): Promise<NormalizedModelSelection> {
	const deadline = createPublicSdkDeadline(timeoutMs, `model.set timed out after ${timeoutMs ?? 60_000}ms`);
	const accepted = modelMutationSelection(
		await host.authority(deadline.remaining(), client =>
			host.mutate(
				client,
				"model.set",
				{ id: `${selection.provider}/${selection.modelId}`, thinkingLevel: selection.thinkingLevel },
				key,
				deadline.remaining(),
			),
		),
		selection,
	);
	host.setSelectedModel(accepted);
	return accepted;
}

function modelMutationSelection(result: unknown, requested: NormalizedModelSelection): NormalizedModelSelection {
	const record = parseRecord(result, "model.set result");
	if (record.status !== undefined && record.status !== "accepted")
		throw new SdkV3OperationError("invalid_result", "model.set result was not accepted");
	const fields = [record.provider, record.modelId, record.thinkingLevel];
	if (fields.every(value => value === undefined || value === "")) return requested;
	if (fields.some(value => value === undefined || value === ""))
		throw new SdkV3OperationError("invalid_result", "model.set result contained a partial selection");
	const accepted = parseMutationSelection(record);
	if (
		accepted.provider !== requested.provider ||
		accepted.modelId !== requested.modelId ||
		accepted.thinkingLevel !== requested.thinkingLevel
	)
		throw new SdkV3OperationError("invalid_result", "model.set did not confirm the requested selection");
	return accepted;
}

export async function setThinking(
	host: PublicSdkActionHost,
	thinkingLevel: NormalizedModelSelection["thinkingLevel"],
	key: string | undefined,
	timeoutMs: number | undefined,
): Promise<NormalizedModelSelection> {
	const deadline = createPublicSdkDeadline(timeoutMs, `thinking.set timed out after ${timeoutMs ?? 60_000}ms`);
	const selected = host.selectedModel();
	if (selected === undefined)
		throw new SdkV3OperationError("invalid_result", "thinking.set requires a prior confirmed model.set result");
	const result = await host.authority(deadline.remaining(), client =>
		host.mutate(client, "thinking.set", { level: thinkingLevel }, key, deadline.remaining()),
	);
	const accepted = mutationThinkingSelection(result, selected, thinkingLevel);
	host.setSelectedModel(accepted);
	return accepted;
}

export async function closeSession(
	host: PublicSdkActionHost,
	key: string | undefined,
	timeoutMs: number | undefined,
): Promise<void> {
	const deadline = createPublicSdkDeadline(timeoutMs, `session.close timed out after ${timeoutMs ?? 60_000}ms`);
	const value = await host.authority(
		deadline.remaining(),
		client => host.mutate(client, "session.close", {}, key, deadline.remaining()),
		"allow_missing",
	);
	if (parseRecord(value, "session.close result").closed !== true)
		throw new SdkV3OperationError("invalid_result", "session.close result must be acknowledged with closed: true");
	host.detach();
}
export async function reply(
	host: PublicSdkActionHost,
	operation: string,
	input: SdkRecord,
	key: string | undefined,
	timeoutMs: number,
): Promise<unknown> {
	const deadline = createPublicSdkDeadline(timeoutMs, `${operation} timed out after ${timeoutMs}ms`);
	const { attachment, client } = host.connected();
	const actionId = typeof input.id === "string" ? input.id : undefined;
	const resolution =
		actionId === undefined ? undefined : waitForReply(client, attachment.sessionId, actionId, deadline.remaining());
	try {
		const value = await host.authority(deadline.remaining(), authorized =>
			host.mutate(authorized, operation, input, key, deadline.remaining()),
		);
		await resolution?.promise;
		await host.authority(deadline.remaining(), async () => undefined);
		return value;
	} finally {
		resolution?.cancel();
	}
}
function mutationThinkingSelection(
	result: unknown,
	selected: NormalizedModelSelection,
	thinkingLevel: NormalizedModelSelection["thinkingLevel"],
): NormalizedModelSelection {
	const record = parseRecord(result, "thinking.set result");
	if (record.status === "accepted") return { ...selected, thinkingLevel };
	const accepted = parseMutationSelection(record);
	if (accepted.thinkingLevel !== thinkingLevel)
		throw new SdkV3OperationError(
			"invalid_result",
			"thinking.set result thinking level did not match the requested level",
		);
	return accepted;
}
