import { listSdkSessionEndpoints } from "@gajae-code/coding-agent/sdk";
import type { GjcRuntimeLocations } from "../contracts";
import { attachmentFromPublishedSdkEndpoint } from "../gjc/public-sdk-attachment";
import type { PublicSdkSessionAttachment, PublicSdkSessionPort } from "../gjc/public-sdk-contract";
import { PublicSdkSessionClient } from "../gjc/public-sdk-session-port";

export interface ModelReader {
	getAvailableModels(): Promise<readonly unknown[]>;
	getState(): Promise<unknown>;
	/** Detaches the SDK transport only; it never closes a remote session. */
	stop(): void | Promise<void>;
}

export type ModelReaderFactory = () => Promise<ModelReader>;
export type PublicSdkAttachmentResolver = () => Promise<PublicSdkSessionAttachment>;
export type PublicSdkSessionPortFactory = () => PublicSdkSessionPort;
export type TemporaryModelAttachmentCleanup = (port: PublicSdkSessionPort) => Promise<void>;

const temporaryModelAttachmentCleanups = new WeakMap<PublicSdkSessionAttachment, TemporaryModelAttachmentCleanup>();

/** Marks a one-shot catalog attachment so its reader closes the remote session before detaching. */
export function registerTemporaryModelAttachment(
	attachment: PublicSdkSessionAttachment,
	cleanup: TemporaryModelAttachmentCleanup,
): PublicSdkSessionAttachment {
	temporaryModelAttachmentCleanups.set(attachment, cleanup);
	return attachment;
}

export interface CreateModelReaderFactoryInput {
	readonly cliPath: string;
	readonly runtimeLocations: GjcRuntimeLocations;
	/** Resolves a validated, already-running public per-session SDK attachment. */
	readonly resolveAttachment?: PublicSdkAttachmentResolver;
	readonly sessionPortFactory?: PublicSdkSessionPortFactory;
}

export class ModelReaderUnavailableError extends Error {
	constructor(message = "GJC public SDK model reader is unavailable") {
		super(message);
		this.name = "ModelReaderUnavailableError";
	}
}

export function createModelReaderFactory(input: CreateModelReaderFactoryInput): ModelReaderFactory {
	const resolveAttachment = input.resolveAttachment ?? (() => resolvePublicSdkAttachment(input.runtimeLocations));
	return async (): Promise<ModelReader> => {
		const port = (input.sessionPortFactory ?? (() => new PublicSdkSessionClient()))();
		let attachment: PublicSdkSessionAttachment | undefined;
		try {
			attachment = await resolveAttachment();
			await port.attach(attachment);
			return new PublicSdkModelReader(port, temporaryModelAttachmentCleanups.get(attachment));
		} catch (error) {
			try {
				if (attachment !== undefined) await temporaryModelAttachmentCleanups.get(attachment)?.(port);
			} finally {
				port.detach();
			}
			throw error;
		}
	};
}

export function resolveGjcCliPath(gjcCommand: string): string {
	return gjcCommand;
}
async function resolvePublicSdkAttachment(runtimeLocations: GjcRuntimeLocations): Promise<PublicSdkSessionAttachment> {
	const { endpoints } = await listSdkSessionEndpoints(runtimeLocations.readerWorkspace);
	const endpoint = [...endpoints].sort((left, right) => left.sessionId.localeCompare(right.sessionId))[0];
	if (endpoint === undefined) throw new ModelReaderUnavailableError();
	return attachmentFromPublishedSdkEndpoint(runtimeLocations.readerWorkspace, endpoint.sessionId, endpoint);
}

class PublicSdkModelReader implements ModelReader {
	constructor(
		private readonly port: PublicSdkSessionPort,
		private readonly cleanup?: TemporaryModelAttachmentCleanup,
	) {}

	getAvailableModels(): Promise<readonly unknown[]> {
		return this.port.getAvailableModels();
	}

	getState(): Promise<unknown> {
		return this.port.getState();
	}

	async stop(): Promise<void> {
		try {
			await this.cleanup?.(this.port);
		} finally {
			this.port.detach();
		}
	}
}
