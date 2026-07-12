import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BootstrapState, PendingRecoveryRecord } from "./bootstrap-state";
import { buildPendingRecoveryLinkage } from "./pending-recovery";

type PendingRecoveryPatch = Partial<
	Pick<
		PendingRecoveryRecord,
		"controllerRecoveryRequired" | "controllerQuiesced" | "priorControllerEnabled" | "priorControllerActive"
	>
>;

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export class PendingRecoveryStore {
	readonly #path: string;
	readonly #parseState: (value: unknown) => BootstrapState;

	public constructor(path: string, parseState: (value: unknown) => BootstrapState) {
		this.#path = path;
		this.#parseState = parseState;
	}

	public read(): PendingRecoveryRecord | undefined {
		return readPendingRecovery(this);
	}

	public write(pendingRecovery: PendingRecoveryRecord): void {
		writePendingRecovery(this, pendingRecovery);
	}

	public update(patch: PendingRecoveryPatch): void {
		updatePendingRecovery(this, patch);
	}

	public remove(): void {
		try {
			const state = this.#parseState(JSON.parse(readFileSync(`${this.#path}.bootstrap.json`, "utf8")));
			const { pendingRecovery: _pendingRecovery, ...withoutPending } = state;
			this.#writeState(withoutPending);
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
	}

	public readState(): BootstrapState | undefined {
		try {
			return this.#parseState(JSON.parse(readFileSync(`${this.#path}.bootstrap.json`, "utf8")));
		} catch (error) {
			if (isMissingFile(error)) return undefined;
			throw error;
		}
	}

	public writeState(state: BootstrapState): void {
		this.#writeState(state);
	}

	#writeState(state: BootstrapState): void {
		const directory = dirname(this.#path);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const target = `${this.#path}.bootstrap.json`,
			temporary = `${target}.${process.pid}.tmp`;
		const fd = openSync(temporary, "w", 0o600);
		try {
			writeFileSync(fd, `${JSON.stringify(state)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, target);
		const directoryFd = openSync(directory, "r");
		try {
			fsyncSync(directoryFd);
		} finally {
			closeSync(directoryFd);
		}
	}
}

export function readPendingRecovery(store: PendingRecoveryStore): PendingRecoveryRecord | undefined {
	try {
		return store.readState()?.pendingRecovery;
	} catch (error) {
		throw new Error(`Malformed bootstrap state: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export function writePendingRecovery(store: PendingRecoveryStore, pendingRecovery: PendingRecoveryRecord): void {
	const state = store.readState() ?? {
		version: 1,
		phase: "preflight",
		bootstrapComplete: false,
		apiKeyCreated: false,
		openAIConfigured: false,
		routeVerified: false,
		ownershipVerified: false,
		openAIConnectionIds: [],
	};
	store.writeState({ ...state, pendingRecovery });
}

export function updatePendingRecovery(store: PendingRecoveryStore, patch: PendingRecoveryPatch): void {
	const pending = readPendingRecovery(store);
	if (pending === undefined) return;
	const controllerQuiesced = pending.controllerQuiesced || patch.controllerQuiesced === true;
	const updated = { ...pending, ...patch, controllerQuiesced };
	writePendingRecovery(store, { ...updated, linkage: buildPendingRecoveryLinkage(updated) });
}
