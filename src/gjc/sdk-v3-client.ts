import { SdkClient, SdkClientError } from "@gajae-code/bridge-client";
import {
	parseOperationResult,
	parseQueryPage,
	parseRecord,
	type SdkEndpoint,
	type SdkRecord,
	SdkV3OperationError,
	SdkV3ProtocolError,
} from "./sdk-v3-protocol";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_QUERY_PAGES = 256;
const MAX_QUERY_ITEMS = 100_000;

/** Thin adapter over the released public SDK transport. */
export class SdkV3Client {
	readonly #endpoint: SdkEndpoint;
	#client: SdkClient | undefined;
	#connecting: Promise<SdkClient> | undefined;
	#closed = false;

	constructor(endpoint: SdkEndpoint) {
		this.#endpoint = endpoint;
	}

	async connect(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
		if (this.#closed) throw new SdkV3OperationError("connection_closed", "SDK client is closed");
		if (this.#client !== undefined) return;
		this.#connecting ??= SdkClient.connect(this.#endpoint.url, this.#endpoint.token, { timeoutMs });
		try {
			const connected = await this.#connecting;
			if (this.#closed) {
				void connected.close();
				throw new SdkV3OperationError("connection_closed", "SDK client is closed");
			}
			this.#client = connected;
		} catch (error) {
			throw sdkError(error);
		} finally {
			this.#connecting = undefined;
		}
	}

	/** Disconnects the local transport only; it never closes the remote session. */
	detach(): void {
		if (this.#closed) return;
		this.#closed = true;
		const client = this.#client;
		this.#client = undefined;
		void client?.close();
	}

	onFrame(listener: (frame: SdkRecord) => void): () => void {
		const client = this.requireClient();
		return client.onFrame(frame => listener(asRecord(frame, "SDK frame")));
	}

	async control(operation: string, input: SdkRecord, timeoutMs?: number, idempotencyKey?: string): Promise<unknown> {
		try {
			const frame = await this.requireClient().control(operation, input, { timeoutMs, idempotencyKey });
			return parseOperationResult(asRecord(frame, `${operation} response`), `${operation} response`);
		} catch (error) {
			throw sdkError(error);
		}
	}

	async queryAll(query: string, input: SdkRecord = {}, timeoutMs?: number): Promise<readonly unknown[]> {
		const budgetMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const deadline = Date.now() + budgetMs;
		const items: unknown[] = [];
		const cursors = new Set<string>();
		let cursor: string | undefined;
		for (let pageCount = 1; pageCount <= MAX_QUERY_PAGES; pageCount += 1) {
			try {
				const frame = await this.requireClient().query(query, input, cursor, {
					timeoutMs: remainingTimeout(deadline, budgetMs),
				});
				const page = parseQueryPage(asRecord(frame, `${query} response`), `${query} response`);
				if (items.length + page.items.length > MAX_QUERY_ITEMS)
					throw new SdkV3ProtocolError(`${query} response`, `query exceeded ${MAX_QUERY_ITEMS} items`);
				items.push(...page.items);
				if (page.cursor === undefined) return items;
				if (cursors.has(page.cursor))
					throw new SdkV3ProtocolError(`${query} response`, "continuation cursor repeated");
				cursors.add(page.cursor);
				cursor = page.cursor;
			} catch (error) {
				throw sdkError(error);
			}
		}
		throw new SdkV3ProtocolError(`${query} response`, `query exceeded ${MAX_QUERY_PAGES} pages`);
	}

	private requireClient(): SdkClient {
		if (this.#client === undefined)
			throw new SdkV3OperationError("connection_closed", "SDK WebSocket is not connected");
		return this.#client;
	}
}

function asRecord(frame: unknown, boundary: string): SdkRecord {
	return parseRecord(frame, boundary);
}

function remainingTimeout(deadline: number, timeoutMs: number): number {
	const remainingMs = deadline - Date.now();
	if (remainingMs <= 0) throw new SdkV3OperationError("timeout", `SDK request timed out after ${timeoutMs}ms`);
	return remainingMs;
}

function sdkError(error: unknown): Error {
	if (error instanceof SdkV3ProtocolError || error instanceof SdkV3OperationError) return error;
	if (error instanceof SdkClientError) return new SdkV3OperationError(error.code, error.message);
	return error instanceof Error ? error : new SdkV3OperationError("unavailable", "SDK request failed");
}
