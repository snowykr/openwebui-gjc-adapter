export const OPENWEBUI_DB_FALLBACK_TABLES = ["folder", "chat", "chat_message"] as const;
export type OpenWebUIDbFallbackTable = (typeof OPENWEBUI_DB_FALLBACK_TABLES)[number];

export const OPENWEBUI_METADATA_NAMESPACE = "gjc_adapter";
export type OpenWebUIMetadataNamespace = typeof OPENWEBUI_METADATA_NAMESPACE;

export const OPENWEBUI_SUPPORTED_ENDPOINTS = [
	"health",
	"version",
	"user",
	"folder",
	"chat",
	"chat_message",
	"message-event",
] as const;
export type OpenWebUISupportedEndpoint = (typeof OPENWEBUI_SUPPORTED_ENDPOINTS)[number];

export const OPENWEBUI_OWNERSHIP_PRESERVATION_FIELDS = [
	"user_id",
	"owner_user_id",
	"created_by",
	"updated_by",
] as const;
export type OpenWebUIOwnershipPreservationField = (typeof OPENWEBUI_OWNERSHIP_PRESERVATION_FIELDS)[number];

export interface OpenWebUIPersistenceContract {
	fallbackTables: readonly OpenWebUIDbFallbackTable[];
	metadataNamespace: OpenWebUIMetadataNamespace;
	supportedEndpoints: readonly OpenWebUISupportedEndpoint[];
	ownershipPreservationFields: readonly OpenWebUIOwnershipPreservationField[];
}

export const OPENWEBUI_PERSISTENCE_CONTRACT: OpenWebUIPersistenceContract = {
	fallbackTables: OPENWEBUI_DB_FALLBACK_TABLES,
	metadataNamespace: OPENWEBUI_METADATA_NAMESPACE,
	supportedEndpoints: OPENWEBUI_SUPPORTED_ENDPOINTS,
	ownershipPreservationFields: OPENWEBUI_OWNERSHIP_PRESERVATION_FIELDS,
};
