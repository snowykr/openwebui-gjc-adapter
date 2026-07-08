export const ADAPTER_PROJECTION_VERSION = 0;

export type AdapterOutboxState = "pending" | "applied" | "failed" | "reconcile";

export type AdapterMetadataContainer<TMetadata> = {
	gjc_adapter?: TMetadata;
};

export interface AdapterOperationMetadata {
	operationId: string;
	projectionVersion: number;
	lineageHash: string;
	outboxState: AdapterOutboxState;
	updatedAt: string;
}

export interface AdapterChatMetadata extends AdapterOperationMetadata {
	kind: "chat";
	chatId: string;
}

export interface AdapterMessageMetadata extends AdapterOperationMetadata {
	kind: "message";
	messageId: string;
	role?: string;
}

export interface AdapterChatMessageMetadata extends AdapterOperationMetadata {
	kind: "chat_message";
	chatId: string;
	messageId: string;
}

export interface AdapterChatMetadataContainer {
	gjc_adapter: AdapterChatMetadata;
}

export interface AdapterMessageMetadataContainer {
	gjc_adapter: AdapterMessageMetadata;
}

export interface AdapterChatMessageMetadataContainer {
	gjc_adapter: AdapterChatMessageMetadata;
}

export function createOperationId(prefix = "op", now?: Date): string {
	const timestamp = (now ?? new Date()).toISOString();
	const safePrefix =
		prefix
			.replaceAll(/[^A-Za-z0-9_-]/g, "-")
			.replaceAll(/-+/g, "-")
			.replace(/^-|-$/g, "") || "op";
	const suffix =
		now === undefined
			? crypto.randomUUID().replaceAll("-", "").slice(0, 16)
			: stableOperationSuffix(safePrefix, timestamp);
	return `${safePrefix}-${timestamp.replaceAll(/[^0-9A-Za-z]/g, "")}-${suffix}`;
}

export function buildLineageHash(parts: readonly string[]): string {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const part of parts) {
		hasher.update(`${part.length}:${part};`);
	}
	return hasher.digest("hex");
}

function stableOperationSuffix(prefix: string, timestamp: string): string {
	return buildLineageHash([prefix, timestamp]).slice(0, 16);
}
