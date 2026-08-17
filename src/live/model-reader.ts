import { resolve } from "node:path";
import type { GjcRuntimeLocations } from "../contracts";
import { snapshotPublishedSdkEndpointGenerations } from "../gjc/public-sdk-attachment";
import type { PublicSdkSessionAttachment, PublicSdkSessionPort } from "../gjc/public-sdk-contract";
import { PublicSdkSessionClient } from "../gjc/public-sdk-session-port";
import { GjcTurnCancelledError } from "../gjc/turn-runner";
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
	/** Request cancellation propagated through model preparation. */
	readonly signal?: AbortSignal;
}

/** Alias used by callers that refer to the reader's scope rather than its context. */
export type ModelReaderScope = ModelReaderContext;

export type ModelReaderFactory = (context?: ModelReaderContext, signal?: AbortSignal) => Promise<ModelReader>;
export type PublicSdkAttachmentResolver = (
	context?: ModelReaderContext,
	signal?: AbortSignal,
) => Promise<PublicSdkSessionAttachment>;
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
		input.resolveAttachment ??
		((context, signal) => resolvePublicSdkAttachment(input.runtimeLocations, context, signal));
	return async (context?: ModelReaderContext, signal?: AbortSignal): Promise<ModelReader> => {
		const effectiveSignal = signal ?? context?.signal;
		const scopedContext =
			context === undefined || effectiveSignal === undefined ? context : { ...context, signal: effectiveSignal };
		throwIfAborted(effectiveSignal);
		await awaitWithAbort(assertScopedModelReaderContext(scopedContext, effectiveSignal), effectiveSignal);
		const port = (input.sessionPortFactory ?? (() => new PublicSdkSessionClient()))();
		let attachment: PublicSdkSessionAttachment | undefined;
		try {
			const attachmentPromise = Promise.resolve(resolveAttachment(scopedContext, effectiveSignal));
			void attachmentPromise.then(
				lateAttachment => {
					if (!effectiveSignal?.aborted) return;
					const cleanup = temporaryModelAttachmentCleanups.get(lateAttachment);
					if (cleanup !== undefined) void cleanup(port).catch(() => undefined);
				},
				() => undefined,
			);
			attachment = await awaitWithAbort(attachmentPromise, effectiveSignal);
			await awaitWithAbort(assertScopedModelReaderContext(scopedContext, effectiveSignal), effectiveSignal);
			assertAttachmentScope(scopedContext, attachment);
			const attachPromise = Promise.resolve(port.attach(attachment));
			void attachPromise.then(
				() => {
					if (effectiveSignal?.aborted) port.detach();
				},
				() => undefined,
			);
			await awaitWithAbort(attachPromise, effectiveSignal);
			await awaitWithAbort(assertScopedModelReaderContext(scopedContext, effectiveSignal), effectiveSignal);
			return new PublicSdkModelReader(port, temporaryModelAttachmentCleanups.get(attachment));
		} catch (error) {
			try {
				if (attachment !== undefined) await temporaryModelAttachmentCleanups.get(attachment)?.(port);
			} catch (cleanupError) {
				if (!(error instanceof GjcTurnCancelledError)) throw cleanupError;
			} finally {
				port.detach();
			}
			if (effectiveSignal?.aborted && !(error instanceof GjcTurnCancelledError)) throw new GjcTurnCancelledError();
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
	signal?: AbortSignal,
): Promise<PublicSdkSessionAttachment> {
	const workspace = context?.principal.role === "user" ? context.workspace?.root : runtimeLocations.readerWorkspace;
	if (workspace === undefined)
		throw new ModelReaderUnavailableError("A normal-user model reader requires a workspace.");
	const attachments = await awaitWithAbort(snapshotPublishedSdkEndpointGenerations(workspace), signal);
	const attachment = [...attachments.values()].sort((left, right) => left.sessionId.localeCompare(right.sessionId))[0];
	if (attachment === undefined) throw new ModelReaderUnavailableError();
	return attachment;
}

async function assertScopedModelReaderContext(
	context: ModelReaderContext | undefined,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
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
		await awaitWithAbort(context.lease.assertFence(), signal);
	} catch (error) {
		if (error instanceof GjcTurnCancelledError) throw error;
		throw new ModelReaderUnavailableError("The normal-user workspace lease is no longer valid.", { cause: error });
	}
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
