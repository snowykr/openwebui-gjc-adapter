import { ModelSelectionError, modelSelectionError } from "./model-selection-errors";

export function jsonResponse(value: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(value), {
		...init,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...init?.headers,
		},
	});
}

export function asyncIterableBody(source: AsyncIterable<string>): ReadableStream<Uint8Array> {
	const iterator = source[Symbol.asyncIterator]();
	const encoder = new TextEncoder();
	const abandon = (): Promise<void> => {
		if (!("abandon" in source)) return Promise.resolve();
		return (source as { abandon?: () => Promise<void> }).abandon?.() ?? Promise.resolve();
	};
	const closeIterator = async (awaitAbandon: boolean) => {
		const abandoned = abandon();
		if (awaitAbandon) await abandoned;
		else void abandoned.catch(() => {});
		await iterator.return?.();
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const next = await iterator.next();
				if (next.done) controller.close();
				else controller.enqueue(encoder.encode(next.value));
			} catch (error) {
				await closeIterator(false);
				controller.error(error);
			}
		},
		async cancel() {
			await closeIterator(true);
		},
	});
}

export function modelSelectionErrorResponse(error: unknown): Response {
	const selectionError =
		error instanceof ModelSelectionError ? error : modelSelectionError("model_catalog_unavailable");
	return jsonResponse(
		{ error: { message: selectionError.message, type: selectionError.type, code: selectionError.code } },
		{ status: selectionError.status },
	);
}

export function sanitizeRunnerError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]");
}
