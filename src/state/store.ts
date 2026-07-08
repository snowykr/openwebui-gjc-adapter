export const ADAPTER_STATE_SCHEMA_VERSION = 0;

export interface AdapterStateMigration {
	readonly fromVersion: number;
	readonly toVersion: number;
	readonly description: string;
	migrate(state: unknown): unknown;
}

export interface AdapterStateStoreDefinition {
	readonly schemaVersion: typeof ADAPTER_STATE_SCHEMA_VERSION;
	readonly migrations: readonly AdapterStateMigration[];
}

export function buildInitialStateStoreDefinition(): AdapterStateStoreDefinition {
	return {
		schemaVersion: ADAPTER_STATE_SCHEMA_VERSION,
		migrations: [],
	};
}
