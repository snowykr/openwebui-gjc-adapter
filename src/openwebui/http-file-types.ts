export interface OpenWebUIFileContent {
	readonly id: string;
	readonly filename?: string;
	readonly content?: string;
}

export interface OpenWebUIFileBytes {
	readonly id: string;
	readonly bytes: Uint8Array;
	readonly contentType?: string;
}
