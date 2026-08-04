import { resolve } from "node:path";
import { listSdkSessionEndpoints } from "@gajae-code/coding-agent/sdk";
import type { GjcRuntimeLocations } from "../contracts";
import { attachmentFromPublishedSdkEndpoint } from "../gjc/public-sdk-attachment";
import type { PublicSdkSessionAttachment, PublicSdkSessionPort } from "../gjc/public-sdk-contract";
import { PublicSdkSessionClient } from "../gjc/public-sdk-session-port";
import type { OpenWebUIPrincipal } from "../openwebui/auth";
import type { UserWorkspace } from "../security/user-workspace";

export interface ModelReader {
	getAvailableModels(): Promise<readonly unknown[]>;
	getActiveProviders(): Promise<readonly unknown[]>;
	getState(): Promise<unknown>;
	/** Detaches the SDK transport only; it never closes a remote session. */
	stop(): void | Promise<void>;
}

/** Request scope used to bind normal-user model readers to one leased workspace. */
export interface ModelReaderContext {
	readonly principal: OpenWebUIPrincipal;
	/** Durable user workspace. Required for normal-user readers. */
	readonly workspace?: UserWorkspace;
	/** Lease fence proving exclusive access to the workspace. Required for normal-user readers. */
	readonly lease?: { readonly assertFence: () => Promise<unknown> };
	readonly correlationId?: string;
}

/** Alias used by callers that refer to the reader's scope rather than its context. */
export type ModelReaderScope = ModelReaderContext;

export type ModelReaderFactory = (context?: ModelReaderContext) => Promise<ModelReader>;
export type PublicSdkAttachmentResolver = (context?: ModelReaderContext) => Promise<PublicSdkSessionAttachment>;
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
	constructor(message = "GJC public SDK model reader is unavailable", options?: ErrorOptions) {
		super(message, options);
		this.name = "ModelReaderUnavailableError";
	}
}

export function createModelReaderFactory(input: CreateModelReaderFactoryInput): ModelReaderFactory {
	const resolveAttachment =
		input.resolveAttachment ?? (context => resolvePublicSdkAttachment(input.runtimeLocations, context));
	return async (context?: ModelReaderContext): Promise<ModelReader> => {
		await assertScopedModelReaderContext(context);
		const port = (input.sessionPortFactory ?? (() => new PublicSdkSessionClient()))();
		let attachment: PublicSdkSessionAttachment | undefined;
		try {
			attachment = await resolveAttachment(context);
			await assertScopedModelReaderContext(context);
			assertAttachmentScope(context, attachment);
			await port.attach(attachment);
			await assertScopedModelReaderContext(context);
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

async function resolvePublicSdkAttachment(
	runtimeLocations: GjcRuntimeLocations,
	context?: ModelReaderContext,
): Promise<PublicSdkSessionAttachment> {
	const workspace = context?.principal.role === "user" ? context.workspace?.root : runtimeLocations.readerWorkspace;
	if (workspace === undefined)
		throw new ModelReaderUnavailableError("A normal-user model reader requires a workspace.");
	const { endpoints } = await listSdkSessionEndpoints(workspace);
	const endpoint = [...endpoints].sort((left, right) => left.sessionId.localeCompare(right.sessionId))[0];
	if (endpoint === undefined) throw new ModelReaderUnavailableError();
	return attachmentFromPublishedSdkEndpoint(workspace, endpoint.sessionId, endpoint);
}

async function assertScopedModelReaderContext(context: ModelReaderContext | undefined): Promise<void> {
	if (context === undefined) return;
	const principal = context.principal;
	if (
		typeof principal !== "object" ||
		principal === null ||
		(principal.role !== "admin" && principal.role !== "user") ||
		typeof principal.userId !== "string" ||
		principal.userId.trim().length === 0 ||
		principal.userId.trim() !== principal.userId ||
		/\p{Cc}/u.test(principal.userId) ||
		/\{\{[^{}]*\}\}/u.test(principal.userId)
	)
		throw new ModelReaderUnavailableError("A valid OpenWebUI principal is required.");
	if (principal.role !== "user") return;
	if (context.workspace === undefined || context.lease === undefined)
		throw new ModelReaderUnavailableError("A normal-user model reader requires a workspace lease.");
	if (context.workspace.userId !== principal.userId)
		throw new ModelReaderUnavailableError("The normal-user model reader workspace is bound to another principal.");
	try {
		await context.lease.assertFence();
	} catch (error) {
		throw new ModelReaderUnavailableError("The normal-user workspace lease is no longer valid.", { cause: error });
	}
}

function assertAttachmentScope(context: ModelReaderContext | undefined, attachment: PublicSdkSessionAttachment): void {
	if (context?.principal.role !== "user") return;
	if (context.workspace === undefined || resolve(attachment.cwd) !== resolve(context.workspace.root))
		throw new ModelReaderUnavailableError("The normal-user model reader attachment escaped its workspace.");
}

class PublicSdkModelReader implements ModelReader {
	constructor(
		private readonly port: PublicSdkSessionPort,
		private readonly cleanup?: TemporaryModelAttachmentCleanup,
	) {}

	getAvailableModels(): Promise<readonly unknown[]> {
		return this.port.getAvailableModels();
	}
	getActiveProviders(): Promise<readonly unknown[]> {
		return this.port.getActiveProviders();
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
