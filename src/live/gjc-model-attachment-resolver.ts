import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GjcRuntimeLocations } from "../contracts";
import { CliLifecycleBackend, MAX_LIFECYCLE_CLOSE_PROOF_WINDOW_MS } from "../gjc/cli-lifecycle-backend";
import type { PublicSdkSessionAttachment } from "../gjc/public-sdk-contract";
import { requireLifecycleAttachment, waitForSdkEndpoint } from "./gjc-routing-endpoints";
import { registerTemporaryModelAttachment } from "./model-reader";

const MODEL_CATALOG_ENDPOINT_PUBLICATION_TIMEOUT_MS = 30_000;

export function createPublicSdkModelAttachmentResolver(input: {
	readonly cliPath: string;
	readonly cwd: string;
	readonly childEnvironment: GjcRuntimeLocations["childEnvironment"];
	/** Called only after the temporary session's close has been proven. */
	readonly onProvenClosed?: (cwd: string, sessionId: string) => void;
}): () => Promise<PublicSdkSessionAttachment> {
	return async () => {
		const sessionRoot = join(input.cwd, ".gjc", "sessions");
		await mkdir(sessionRoot, { recursive: true });
		const backend = new CliLifecycleBackend({
			cliPath: input.cliPath,
			cwd: input.cwd,
			childEnvironment: input.childEnvironment,
			endpointPublicationTimeoutMs: MODEL_CATALOG_ENDPOINT_PUBLICATION_TIMEOUT_MS,
		});
		const lifecycle = requireLifecycleAttachment(await backend.createEphemeral({ sessionRoot }));
		try {
			const attachment = await waitForSdkEndpoint(
				input.cwd,
				lifecycle.sessionId,
				MODEL_CATALOG_ENDPOINT_PUBLICATION_TIMEOUT_MS,
			);
			return registerTemporaryModelAttachment(attachment, async port => {
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
					input.onProvenClosed?.(resolve(input.cwd), lifecycle.sessionId);
				} catch (error) {
					if (closePossiblyApplied) throw error;
					const fallback = await backend.fallbackBeforeCloseAcknowledgement(lifecycle);
					if (fallback.status !== "closed")
						throw new AggregateError(
							[error, new Error(fallback.message)],
							"temporary model session cleanup is uncertain",
						);
					input.onProvenClosed?.(resolve(input.cwd), lifecycle.sessionId);
				}
			});
		} catch (error) {
			const fallback = await backend.fallbackBeforeCloseAcknowledgement(lifecycle);
			if (fallback.status !== "closed")
				throw new AggregateError(
					[error, new Error(fallback.message)],
					"temporary model session endpoint cleanup is uncertain",
				);
			input.onProvenClosed?.(resolve(input.cwd), lifecycle.sessionId);
			throw error;
		}
	};
}
