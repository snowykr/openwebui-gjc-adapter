import { randomUUID } from "node:crypto";
import {
	parseJsonRecord,
	parseOperationResult,
	parseQueryPage,
	type SdkEndpoint,
	type SdkRecord,
	SdkV3OperationError,
	SdkV3ProtocolError,
} from "./sdk-v3-protocol";

interface PendingRequest {
	readonly resolve: (frame: SdkRecord) => void;
	readonly reject: (error: Error) => void;
	readonly timeout: ReturnType<typeof setTimeout>;
	readonly socket: WebSocket;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_QUERY_PAGES = 256;
const MAX_QUERY_ITEMS = 100_000;

export class SdkV3Client {
	readonly #endpoint: SdkEndpoint;
	readonly #pending = new Map<string, PendingRequest>();
	readonly #listeners = new Set<(frame: SdkRecord) => void>();
	#socket: WebSocket | undefined;
	#openingSocket: WebSocket | undefined;
	#opening: Promise<void> | undefined;
	#closed = false;

	constructor(endpoint: SdkEndpoint) {
		this.#endpoint = endpoint;
	}

	async connect(timeoutMs = 10_000): Promise<void> {
		if (this.#closed) throw new SdkV3OperationError("connection_closed", "SDK client is closed");
		if (this.#socket?.readyState === WebSocket.OPEN) return;
		if (this.#opening !== undefined) return this.#opening;
		this.#opening = this.open(timeoutMs);
		try {
			await this.#opening;
		} finally {
			this.#opening = undefined;
		}
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#openingSocket?.close();
		this.#socket?.close();
		this.#openingSocket = undefined;
		this.#socket = undefined;
		this.rejectPending(new SdkV3OperationError("connection_closed", "SDK client is closed"));
		this.#listeners.clear();
	}

	onFrame(listener: (frame: SdkRecord) => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async control(operation: string, input: SdkRecord, timeoutMs?: number, idempotencyKey?: string): Promise<unknown> {
		const frame = await this.request(
			{ type: "control_request", operation, input, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) },
			timeoutMs,
		);
		return parseOperationResult(frame, `${operation} response`);
	}

	async queryAll(query: string, input: SdkRecord = {}, timeoutMs?: number): Promise<readonly unknown[]> {
		const budgetMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const deadline = Date.now() + budgetMs;
		const items: unknown[] = [];
		const cursors = new Set<string>();
		let cursor: string | undefined;
		for (let pageCount = 1; pageCount <= MAX_QUERY_PAGES; pageCount += 1) {
			const frame = await this.request(
				{ type: "query_request", query, input, ...(cursor === undefined ? {} : { cursor }) },
				budgetMs,
				deadline,
			);
			const page = parseQueryPage(frame, `${query} response`);
			if (items.length + page.items.length > MAX_QUERY_ITEMS) {
				throw new SdkV3ProtocolError(`${query} response`, `query exceeded ${MAX_QUERY_ITEMS} items`);
			}
			items.push(...page.items);
			if (page.cursor === undefined) return items;
			if (cursors.has(page.cursor)) {
				throw new SdkV3ProtocolError(`${query} response`, "continuation cursor repeated");
			}
			cursors.add(page.cursor);
			cursor = page.cursor;
		}
		throw new SdkV3ProtocolError(`${query} response`, `query exceeded ${MAX_QUERY_PAGES} pages`);
	}

	private async request(
		frame: SdkRecord,
		timeoutMs = DEFAULT_TIMEOUT_MS,
		deadline = Date.now() + timeoutMs,
	): Promise<SdkRecord> {
		await this.connect(this.remainingTimeout(deadline, timeoutMs));
		const socket = this.#socket;
		if (socket?.readyState !== WebSocket.OPEN) {
			throw new SdkV3OperationError("connection_closed", "SDK WebSocket is not connected");
		}
		const id = randomUUID();
		return new Promise<SdkRecord>((resolve, reject) => {
			const remainingMs = this.remainingTimeout(deadline, timeoutMs);
			const timeout = setTimeout(() => {
				this.#pending.delete(id);
				reject(new SdkV3OperationError("timeout", `SDK request timed out after ${timeoutMs}ms`));
			}, remainingMs);
			timeout.unref?.();
			this.#pending.set(id, { resolve, reject, timeout, socket });
			try {
				socket.send(JSON.stringify({ ...frame, id }));
			} catch (error) {
				clearTimeout(timeout);
				this.#pending.delete(id);
				reject(
					new SdkV3OperationError(
						"unavailable",
						error instanceof Error ? error.message : "SDK WebSocket send failed",
					),
				);
			}
		});
	}

	private open(timeoutMs: number): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const url = new URL(this.#endpoint.url);
			url.searchParams.set("token", this.#endpoint.token);
			const socket = new WebSocket(url);
			this.#openingSocket = socket;
			let opened = false;
			let ready = false;
			let settled = false;
			const timeout = setTimeout(() => {
				failOpen(new SdkV3OperationError("timeout", `SDK hello timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			timeout.unref?.();
			const failOpen = (error: Error): void => {
				if (ready || settled) return;
				settled = true;
				clearTimeout(timeout);
				if (this.#openingSocket === socket) this.#openingSocket = undefined;
				socket.close();
				reject(error);
			};
			socket.addEventListener("open", () => {
				opened = true;
			});
			socket.addEventListener("message", event => {
				if (ready && this.#socket !== socket) return;
				let frame: SdkRecord;
				try {
					frame = parseJsonRecord(String(event.data), "WebSocket frame");
				} catch (error) {
					const protocolError =
						error instanceof Error ? error : new SdkV3ProtocolError("WebSocket frame", "invalid value");
					if (ready) this.failConnection(socket, protocolError);
					else failOpen(protocolError);
					return;
				}
				if (!ready) {
					if (!isHello(frame) || !opened || frame.protocolVersion !== 3) {
						failOpen(new SdkV3ProtocolError("hello", "expected protocolVersion 3 after open"));
						return;
					}
					ready = true;
					settled = true;
					clearTimeout(timeout);
					if (this.#openingSocket === socket) this.#openingSocket = undefined;
					this.#socket = socket;
					resolve();
				}
				this.dispatch(frame, socket);
			});
			socket.addEventListener("error", () => {
				const error = new SdkV3OperationError("unavailable", "SDK WebSocket connection failed");
				if (ready) this.failConnection(socket, error);
				else failOpen(error);
			});
			socket.addEventListener("close", () => {
				if (this.#openingSocket === socket) this.#openingSocket = undefined;
				const error = new SdkV3OperationError("connection_closed", "SDK WebSocket connection closed");
				if (!ready) failOpen(error);
				else this.failConnection(socket, error);
			});
		});
	}

	private dispatch(frame: SdkRecord, socket: WebSocket): void {
		for (const listener of this.#listeners) listener(frame);
		const id = typeof frame.id === "string" ? frame.id : undefined;
		if (id === undefined) return;
		const pending = this.#pending.get(id);
		if (pending === undefined || pending.socket !== socket) return;
		this.#pending.delete(id);
		clearTimeout(pending.timeout);
		pending.resolve(frame);
	}

	private failConnection(socket: WebSocket, error: Error): void {
		if (this.#socket !== socket) return;
		this.#socket = undefined;
		socket.close();
		this.rejectPending(error, socket);
	}

	private rejectPending(error: Error, socket?: WebSocket): void {
		for (const [id, pending] of this.#pending) {
			if (socket !== undefined && pending.socket !== socket) continue;
			clearTimeout(pending.timeout);
			pending.reject(error);
			this.#pending.delete(id);
		}
	}

	private remainingTimeout(deadline: number, timeoutMs: number): number {
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			throw new SdkV3OperationError("timeout", `SDK request timed out after ${timeoutMs}ms`);
		}
		return remainingMs;
	}
}

function isHello(frame: SdkRecord): boolean {
	return frame.type === "hello" || frame.type === "server_hello" || frame.type === "broker_hello";
}
