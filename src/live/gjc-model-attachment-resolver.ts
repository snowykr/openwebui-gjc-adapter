import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GjcRuntimeLocations } from "../contracts";
import { CliLifecycleBackend, MAX_LIFECYCLE_CLOSE_PROOF_WINDOW_MS } from "../gjc/cli-lifecycle-backend";
import type { PublicSdkSessionAttachment } from "../gjc/public-sdk-contract";
import { GjcTurnCancelledError } from "../gjc/turn-runner";
import { requireLifecycleAttachment, waitForSdkEndpoint } from "./gjc-routing-endpoints";
import { type ModelReaderContext, registerTemporaryModelAttachment } from "./model-reader";

const MODEL_CATALOG_ENDPOINT_PUBLICATION_TIMEOUT_MS = 30_000;

export function createPublicSdkModelAttachmentResolver(input: {
	readonly cliPath: string;
	readonly cwd: string;
	readonly childEnvironment: GjcRuntimeLocations["childEnvironment"];
	/** Called only after the temporary session's close has been proven. */
	readonly onProvenClosed?: (cwd: string, sessionId: string) => void;
}): (context?: ModelReaderContext, signal?: AbortSignal) => Promise<PublicSdkSessionAttachment> {
	return async (context?: ModelReaderContext, signal?: AbortSignal) => {
		const effectiveSignal = signal ?? context?.signal;
		throwIfAborted(effectiveSignal);
		const cwd = context?.principal.role === "user" ? context.workspace?.root : input.cwd;
		if (cwd === undefined) throw new Error("Normal-user model attachment requires a durable workspace.");
		const sessionRoot = join(cwd, ".gjc", "sessions");
		await mkdir(sessionRoot, { recursive: true });
		const backend = new CliLifecycleBackend({
			cliPath: input.cliPath,
			cwd,
			childEnvironment: input.childEnvironment,
			endpointPublicationTimeoutMs: MODEL_CATALOG_ENDPOINT_PUBLICATION_TIMEOUT_MS,
		});
		const lifecyclePromise = backend.createEphemeral({ sessionRoot });
		void lifecyclePromise.then(result => {
			if (!effectiveSignal?.aborted || result.status !== "closed") return;
			void backend.fallbackBeforeCloseAcknowledgement(result.value).catch(() => undefined);
		});
		const lifecycle = requireLifecycleAttachment(await awaitWithAbort(lifecyclePromise, effectiveSignal));
		try {
			const attachment = await awaitWithAbort(
				waitForSdkEndpoint(cwd, lifecycle.sessionId, MODEL_CATALOG_ENDPOINT_PUBLICATION_TIMEOUT_MS),
				effectiveSignal,
			);
			return registerTemporaryModelAttachment(attachment, async port => {
				if (port === undefined) {
					const fallback = await backend.fallbackBeforeCloseAcknowledgement(lifecycle);
					if (fallback.status !== "closed")
						throw new Error(`temporary model session close is ${fallback.status}: ${fallback.message}`);
					input.onProvenClosed?.(resolve(cwd), lifecycle.sessionId);
					return;
				}
				let closePossiblyApplied = false;
				try {
					closePossiblyApplied = true;
					await port.closeSession(undefined, 1_000);
					const closed = await backend.requestExitAndProveClosedAfterAcknowledgement(
						lifecycle,
						MAX_LIFECYCLE_CLOSE_PROOF_WINDOW_MS,
					);
					if (closed.status !== "closed")
						throw new Error(`temporary model session close is ${closed.status}: ${closed.message}`);
					input.onProvenClosed?.(resolve(cwd), lifecycle.sessionId);
				} catch (error) {
					if (closePossiblyApplied) throw error;
					const fallback = await backend.fallbackBeforeCloseAcknowledgement(lifecycle);
					if (fallback.status !== "closed")
						throw new AggregateError(
							[error, new Error(fallback.message)],
							"temporary model session cleanup is uncertain",
						);
					input.onProvenClosed?.(resolve(cwd), lifecycle.sessionId);
				}
			});
		} catch (error) {
			const fallback = await backend.fallbackBeforeCloseAcknowledgement(lifecycle);
			if (fallback.status !== "closed") {
				if (error instanceof GjcTurnCancelledError) throw error;
				throw new AggregateError(
					[error, new Error(fallback.message)],
					"temporary model session endpoint cleanup is uncertain",
				);
			}
			input.onProvenClosed?.(resolve(cwd), lifecycle.sessionId);
			if (effectiveSignal?.aborted && !(error instanceof GjcTurnCancelledError)) throw new GjcTurnCancelledError();
			throw error;
		}
	};
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new GjcTurnCancelledError();
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return promise;
	if (signal.aborted) {
		void promise.catch(() => undefined);
		return Promise.reject(new GjcTurnCancelledError());
	}
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			cleanup();
			reject(new GjcTurnCancelledError());
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			value => {
				cleanup();
				resolve(value);
			},
			error => {
				cleanup();
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
	});
}
