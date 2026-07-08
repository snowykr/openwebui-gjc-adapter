export interface OpenWebUIHttpRequest {
	readonly method: "GET" | "POST";
	readonly path: string;
	readonly body?: unknown;
}

interface OpenWebUIHttpErrorInput extends OpenWebUIHttpRequest {
	readonly status: number;
	readonly responseBody: string;
}

interface OpenWebUITransportErrorInput extends OpenWebUIHttpRequest {
	readonly detail: string;
}

export class OpenWebUIHttpConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OpenWebUIHttpConfigurationError";
	}
}

export class OpenWebUIHttpError extends Error {
	readonly method: string;
	readonly path: string;
	readonly status: number;
	readonly responseBody: string;

	constructor(input: OpenWebUIHttpErrorInput) {
		super(`OpenWebUI HTTP ${input.method} ${input.path} failed with ${input.status}: ${input.responseBody}`);
		this.name = "OpenWebUIHttpError";
		this.method = input.method;
		this.path = input.path;
		this.status = input.status;
		this.responseBody = input.responseBody;
	}
}

export class OpenWebUITransportError extends Error {
	readonly method: string;
	readonly path: string;
	readonly detail: string;

	constructor(input: OpenWebUITransportErrorInput) {
		super(`OpenWebUI HTTP ${input.method} ${input.path} could not be delivered: ${input.detail}`);
		this.name = "OpenWebUITransportError";
		this.method = input.method;
		this.path = input.path;
		this.detail = input.detail;
	}
}
