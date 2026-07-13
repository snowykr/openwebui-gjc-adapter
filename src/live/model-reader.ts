import type { GjcRuntimeLocations } from "../contracts";
import type { GjcRpcRunnerClientOptions, GjcRpcSelectionTransport } from "../gjc/rpc-runner";

export interface ModelReader {
	getAvailableModels(): Promise<readonly unknown[]>;
	getState(): Promise<unknown>;
	stop(): void | Promise<void>;
}

export type ModelReaderFactory = () => Promise<ModelReader>;
export type ModelReaderTransportFactory = (options: GjcRpcRunnerClientOptions) => GjcRpcSelectionTransport;

export interface CreateModelReaderFactoryInput {
	readonly cliPath: string;
	readonly runtimeLocations: GjcRuntimeLocations;
	readonly transportFactory?: ModelReaderTransportFactory;
}

export function createModelReaderFactory(input: CreateModelReaderFactoryInput): ModelReaderFactory {
	const options: GjcRpcRunnerClientOptions = Object.freeze({
		cwd: input.runtimeLocations.readerWorkspace,
		sessionRoot: input.runtimeLocations.readerSessionRoot,
		cliPath: input.cliPath,
		runtimeLocations: input.runtimeLocations,
	});
	return async (): Promise<ModelReader> => {
		const createTransport =
			input.transportFactory ?? (await import("../gjc/rpc-client-transport")).createDefaultRpcTransport;
		return startReader(createTransport(options));
	};
}

export function resolveGjcCliPath(gjcCommand: string): string {
	return gjcCommand;
}

async function startReader(transport: GjcRpcSelectionTransport): Promise<ModelReader> {
	try {
		await transport.start();
		await transport.newEphemeralSession?.();
		return transport;
	} catch (error) {
		try {
			await transport.stop();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "GJC model reader startup and cleanup failed");
		}
		throw error;
	}
}
