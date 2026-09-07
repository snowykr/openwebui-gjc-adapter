import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { RuntimeSingletonLock } from "../runtime-singleton-lock";
import type { ManagedLifecycleEvidence } from "./managed-lifecycle-evidence";
import { ManagedOperationDeadline } from "./managed-operation-deadline";
import { AuthorityMutationLock } from "./session-authority-file";
import { FileSessionAuthority } from "./session-authority-persistence";
import {
	encodeSessionAuthorityV3Document,
	hasUnboundServingAuthority,
	parseSessionAuthorityV3Document,
	SESSION_AUTHORITY_V3_EPOCH,
} from "./session-authority-v3";
import {
	type ManagedTurnAuthorityBinding,
	type SessionAuthorityV2Document,
	stageSessionAuthorityV3Migration,
} from "./session-authority-v3-migration";
import {
	type SessionAuthorityV3BootstrapStage,
	V3FileBackedSessionMappingStore,
} from "./session-v3-file-backed-mapping-store";

const MAX_AUTHORITY_BYTES = 128 * 1024 * 1024;
const MAX_WAL_BYTES = 128 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

export type SessionAuthorityV3ActivationBoundary =
	| "snapshot"
	| "backup"
	| "manifest"
	| "working"
	| "replay"
	| "historical-stage"
	| "stage"
	| "committing"
	| "base"
	| "wal"
	| "swap"
	| "marker";

export interface SessionAuthorityV3ActivationOptions {
	/** The V2 canonical authority. Its mutation and runtime locks are held by the caller. */
	readonly canonicalPath: string;
	readonly runtimeLock: RuntimeSingletonLock;
	readonly mutationLock: AuthorityMutationLock;
	readonly timeoutMs?: number;
	/** Exact, managed authority identities; no runtime-derived authority is consulted. */
	readonly bindings?: readonly ManagedTurnAuthorityBinding[];
	/** Restricted coordinator mutates the retained ordinary stage, never supplies replacement bytes. */
	readonly bootstrap?: (context: SessionAuthorityV3BootstrapContext) => Promise<void>;
	/** Revalidates resolved tenant/workspace and the current attempt lease; never rewrites receipt provenance. */
	readonly bootstrapTenantFence?: (evidence: ManagedLifecycleEvidence) => boolean | Promise<boolean>;
	/** Fresh public attachment/lease proof immediately before canonical replacement. */
	readonly beforeBootstrapCommit?: () => Promise<() => void>;
	/** Resolves occurrence-specific identities only after ordinary historical V3 reopen. */
	readonly resolveBindings?: (
		decodedDocument: SessionAuthorityV2Document,
		context: SessionAuthorityV3ActivationContext,
	) =>
		| readonly ManagedTurnAuthorityBinding[]
		| undefined
		| Promise<readonly ManagedTurnAuthorityBinding[] | undefined>;
	/** Private adapter-owned directory. It must not be the canonical authority directory. */
	readonly stagingRoot: string;
	/** Test-only crash seam, called only after the named boundary is durable. */
	readonly afterBoundary?: (boundary: SessionAuthorityV3ActivationBoundary) => void;
}

export interface SessionAuthorityV3ActivationContext {
	readonly stagedPath: string;
	readonly manifestDigest: string;
	assertCurrent(): Promise<void>;
	remaining(): number;
}

export interface SessionAuthorityV3BootstrapContext extends SessionAuthorityV3ActivationContext {
	readonly stage: SessionAuthorityV3BootstrapStage;
}

declare const bootstrapAccessBrand: unique symbol;
export interface SessionAuthorityV3BootstrapAccess {
	readonly [bootstrapAccessBrand]: true;
}
const bootstrapAccess = new WeakMap<
	SessionAuthorityV3BootstrapAccess,
	{
		readonly path: string;
		readonly manifestDigest: string;
		readonly check: () => Promise<void>;
		readonly checkSync: () => void;
		readonly tenantFence: NonNullable<SessionAuthorityV3ActivationOptions["bootstrapTenantFence"]>;
	}
>();

/** Only the activator can issue this capability after immutable capture and ordinary stage reopen. */
export function assertBootstrapAccessCurrent(access: SessionAuthorityV3BootstrapAccess, path: string): string {
	const owner = bootstrapAccess.get(access);
	if (owner === undefined || owner.path !== resolve(path))
		throw new Error("Historical bootstrap activation ownership is unavailable.");
	owner.checkSync();
	return owner.manifestDigest;
}

export async function assertBootstrapAccess(access: SessionAuthorityV3BootstrapAccess, path: string): Promise<void> {
	assertBootstrapAccessCurrent(access, path);
	await bootstrapAccess.get(access)!.check();
	assertBootstrapAccessCurrent(access, path);
}

export async function assertBootstrapOperation(
	access: SessionAuthorityV3BootstrapAccess,
	path: string,
	evidence: ManagedLifecycleEvidence,
): Promise<void> {
	await assertBootstrapAccess(access, path);
	const owner = bootstrapAccess.get(access)!;
	if (!(await owner.tenantFence(structuredClone(evidence))))
		throw new Error("Historical bootstrap operation lease or tenant fence was lost.");
	await assertBootstrapAccess(access, path);
}

export interface SessionAuthorityV3ActiveMarker {
	readonly kind: "openwebui-gjc-session-authority-active";
	readonly version: 1;
	readonly authorityEpoch: typeof SESSION_AUTHORITY_V3_EPOCH;
	/** Digest of the deterministic V3 document produced at activation time. */
	readonly activationV3Digest: string;
	readonly source: Readonly<{
		baseDigest: string;
		walDigest: string;
		walPresent: boolean;
	}>;
}

export interface SessionAuthorityV3ActivationResult {
	readonly status: "activated" | "blocked";
	readonly canonicalPath: string;
	readonly markerPath: string;
	readonly activationV3Digest?: string;
	readonly reasons?: readonly string[];
}

export function readSessionAuthorityV3ActiveMarker(canonicalPath: string): SessionAuthorityV3ActiveMarker | undefined {
	return readMarker(`${resolve(canonicalPath)}.v3-active.json`);
}

/**
 * Converts the canonical V2 authority while its runtime and authority-mutation
 * locks are already held. The only files it opens are the authority, its WAL,
 * and private activation files; it never inspects user workspaces, transcripts,
 * or artifacts.
 */
export function startSessionAuthorityV3Activation(options: SessionAuthorityV3ActivationOptions): {
	readonly result: Promise<SessionAuthorityV3ActivationResult>;
	readonly settled: Promise<void>;
} {
	const deadline = new ManagedOperationDeadline(options.timeoutMs, "authority activation");
	const producers = new Set<Promise<unknown>>();
	const track = <T>(promise: Promise<T>): Promise<T> => {
		producers.add(promise);
		void promise.then(
			() => producers.delete(promise),
			() => producers.delete(promise),
		);
		return promise;
	};
	const wait = <T>(promise: Promise<T>): Promise<T> => deadline.wait(track(promise));
	const work = track(activateUnderDeadline(options, deadline, wait));
	const result = deadline.wait(work).finally(() => deadline.close());
	const settled = result
		.catch(() => undefined)
		.then(async () => {
			while (producers.size > 0) await Promise.allSettled([...producers]);
		});
	void result.catch(() => undefined);
	return Object.freeze({ result, settled });
}

async function activateUnderDeadline(
	options: SessionAuthorityV3ActivationOptions,
	deadline: ManagedOperationDeadline,
	wait: <T>(promise: Promise<T>) => Promise<T>,
): Promise<SessionAuthorityV3ActivationResult> {
	const canonicalPath = resolve(options.canonicalPath);
	if (options.bootstrap !== undefined && (options.bindings !== undefined || options.resolveBindings !== undefined))
		throw new Error("Historical bootstrap cannot be combined with binding replacement.");
	if (options.bootstrap !== undefined && typeof options.bootstrapTenantFence !== "function")
		throw new Error("Historical bootstrap requires a live operation tenant fence.");
	if (options.bootstrap !== undefined && typeof options.beforeBootstrapCommit !== "function")
		throw new Error("Historical bootstrap requires public commit revalidation.");
	if (
		!(options.runtimeLock instanceof RuntimeSingletonLock) ||
		!(options.mutationLock instanceof AuthorityMutationLock)
	)
		throw new Error("Canonical activation requires held runtime and mutation lock capabilities.");
	const assertLocks = async () => {
		deadline.remaining();
		await wait(options.runtimeLock.assertOwnsPath(canonicalPath));
		options.mutationLock.assertHeld(canonicalPath);
	};
	await assertLocks();
	const root = privateRoot(options.stagingRoot, canonicalPath);
	const markerPath = `${canonicalPath}.v3-active.json`;
	const journalPath = join(root, "activation.json");

	const recovered = recover(canonicalPath, markerPath, root, journalPath, options.mutationLock);
	if (recovered !== undefined) return recovered;

	const snapshot = await wait(captureImmutableSnapshot(canonicalPath, root, assertLocks, options.afterBoundary));
	await assertLocks();

	const privateV2 = join(root, "replay.v2.json");
	writePrivate(root, "replay.v2.json", snapshot.base);
	if (snapshot.walPresent) writePrivate(root, "replay.v2.json.wal", snapshot.wal);
	else {
		const staleReplayWal = lstatSync(join(root, "replay.v2.json.wal"), { throwIfNoEntry: false });
		if (staleReplayWal !== undefined) {
			if (staleReplayWal.isSymbolicLink() || !staleReplayWal.isFile())
				throw new Error("Private V2 replay WAL is not a regular file.");
			unlinkSync(join(root, "replay.v2.json.wal"));
		}
	}
	fsyncDirectory(root);
	options.afterBoundary?.("working");
	await assertLocks();
	const replayed = new FileSessionAuthority(privateV2, undefined, {
		sourcePath: canonicalPath,
		baseDigest: snapshot.baseDigest,
		baseMtimeMs: snapshot.baseIdentity.mtimeMs,
		reconciliationTimeMs: Math.max(snapshot.baseIdentity.mtimeMs, snapshot.walIdentity?.mtimeMs ?? 0),
		walDigest: snapshot.walPresent ? snapshot.walDigest : null,
	});
	fsyncRegular(privateV2, "private replayed V2 authority");
	const replayWal = join(root, "replay.v2.json.wal");
	const replayWalPresent = lstatSync(replayWal, { throwIfNoEntry: false }) !== undefined;
	if (replayWalPresent) fsyncRegular(replayWal, "private replayed V2 WAL");
	writePrivate(
		root,
		"replay-evidence.json",
		encode({
			kind: "openwebui-gjc-v3-private-replay",
			version: 1,
			manifestDigest: digest(
				readRegular(join(root, "source-manifest.json"), 16 * 1024, "immutable source manifest"),
			),
			baseDigest: digest(readRegular(privateV2, MAX_AUTHORITY_BYTES, "private replayed V2 authority")),
			baseGeneration: baseGeneration(readRegular(privateV2, MAX_AUTHORITY_BYTES, "private replayed V2 authority")),
			walDigest: replayWalPresent ? digest(readRegular(replayWal, MAX_WAL_BYTES, "private replayed V2 WAL")) : null,
		}),
	);
	fsyncDirectory(root);
	options.afterBoundary?.("replay");
	await assertLocks();
	const decodedDocument: SessionAuthorityV2Document = {
		mappings: replayed.entries(),
		provisionalOperations: replayed.provisionalEntries(),
	};
	const historical = stageSessionAuthorityV3Migration({
		snapshot: {
			originalBaseBytes: snapshot.base,
			originalBaseDigest: snapshot.baseDigest,
			originalWalBytes: snapshot.wal,
			originalWalDigest: snapshot.walDigest,
		},
		decodedDocument,
	});
	if (historical.status === "blocked")
		return { status: "blocked", canonicalPath, markerPath, reasons: historical.reasons };
	const historicalPath = join(root, "historical.v3.json");
	const initialHistoricalBytes = Buffer.from(historical.v3Bytes);
	const manifestDigest = digest(
		readRegular(join(root, "source-manifest.json"), 16 * 1024, "immutable source manifest"),
	);
	retainHistoricalStage(root, historicalPath, initialHistoricalBytes, manifestDigest);
	const retainedHistoricalBytes = readRegular(historicalPath, MAX_AUTHORITY_BYTES, "retained historical V3 stage");
	const historicalStore = new V3FileBackedSessionMappingStore(historicalPath);
	historicalStore.close();
	fsyncDirectory(root);
	options.afterBoundary?.("historical-stage");
	await assertLocks();
	const assertBootstrapCurrent = async () => {
		await assertLocks();
		const retainedManifest = readRegular(join(root, "source-manifest.json"), 16 * 1024, "immutable source manifest");
		if (digest(retainedManifest) !== manifestDigest) throw new Error("Historical bootstrap source manifest changed.");
		if (!canonicalSnapshotMatches(canonicalPath, snapshot))
			throw new Error("Canonical V2 authority changed during binding resolution.");
		retainHistoricalStage(root, historicalPath, initialHistoricalBytes, manifestDigest);
		if (options.bootstrap !== undefined)
			assertBootstrapGraph(
				initialHistoricalBytes,
				readRegular(historicalPath, MAX_AUTHORITY_BYTES, "retained bootstrap graph"),
				manifestDigest,
			);
	};
	await assertBootstrapCurrent();
	if (options.bootstrap !== undefined)
		assertBootstrapGraph(
			initialHistoricalBytes,
			readRegular(historicalPath, MAX_AUTHORITY_BYTES, "retained bootstrap graph"),
			manifestDigest,
		);
	// A changed stage may contain prepared or acknowledged lifecycle work. Until
	// its journal is reconciled, never replace it by converting the original V2
	// graph again, even when an earlier resolver returned no bindings or threw.
	if (
		options.bootstrap === undefined &&
		(!retainedHistoricalBytes.equals(initialHistoricalBytes) ||
			!readRegular(historicalPath, MAX_AUTHORITY_BYTES, "historical V3 stage").equals(initialHistoricalBytes))
	)
		return {
			status: "blocked",
			canonicalPath,
			markerPath,
			reasons: ["Retained historical stage requires journal reconciliation before binding resolution."],
		};
	const historicalIdentity = fileIdentity(historicalPath);
	const bootstrapStore = new V3FileBackedSessionMappingStore(historicalPath);
	const access = Object.freeze({}) as SessionAuthorityV3BootstrapAccess;
	bootstrapAccess.set(access, {
		path: historicalPath,
		manifestDigest,
		check: assertBootstrapCurrent,
		tenantFence: options.bootstrapTenantFence ?? (() => false),
		checkSync: () => {
			deadline.remaining();
			options.mutationLock.assertHeld(canonicalPath);
			if (
				!canonicalSnapshotMatches(canonicalPath, snapshot) ||
				digest(readRegular(join(root, "source-manifest.json"), 16 * 1024, "immutable source manifest")) !==
					manifestDigest
			)
				throw new Error("Historical bootstrap source ownership changed before mutation.");
			retainHistoricalStage(root, historicalPath, initialHistoricalBytes, manifestDigest);
		},
	});
	let bindings: readonly ManagedTurnAuthorityBinding[] | undefined;
	try {
		const context: SessionAuthorityV3ActivationContext = {
			stagedPath: historicalPath,
			manifestDigest,
			assertCurrent: assertBootstrapCurrent,
			remaining: () => deadline.remaining(),
		};
		if (options.bootstrap !== undefined)
			await wait(options.bootstrap({ ...context, stage: bootstrapStore.bootstrapStage(access) }));
		else
			bindings =
				options.resolveBindings === undefined
					? (options.bindings ?? [])
					: await wait(Promise.resolve(options.resolveBindings(decodedDocument, context)));
	} finally {
		bootstrapAccess.delete(access);
		bootstrapStore.close();
	}
	await assertLocks();
	if (
		options.bootstrap === undefined &&
		(!matchesFileIdentity(historicalPath, historicalIdentity) ||
			!readRegular(historicalPath, MAX_AUTHORITY_BYTES, "historical V3 stage").equals(initialHistoricalBytes))
	)
		return {
			status: "blocked",
			canonicalPath,
			markerPath,
			reasons: ["Binding resolution changed the historical stage; retained journal cannot be discarded."],
		};
	if (options.bootstrap === undefined && bindings === undefined)
		return {
			status: "blocked",
			canonicalPath,
			markerPath,
			reasons: ["A complete managed authority could not be derived for the replayed V2 authority graph."],
		};
	if (!canonicalSnapshotMatches(canonicalPath, snapshot))
		return {
			status: "blocked",
			canonicalPath,
			markerPath,
			reasons: ["Canonical V2 authority changed during private replay or binding resolution."],
		};
	const bootstrapBytes =
		options.bootstrap === undefined
			? undefined
			: readRegular(historicalPath, MAX_AUTHORITY_BYTES, "bootstrapped V3 stage");
	if (bootstrapBytes !== undefined) assertBootstrapGraph(initialHistoricalBytes, bootstrapBytes, manifestDigest);
	const staged =
		bootstrapBytes === undefined
			? stageSessionAuthorityV3Migration({
					snapshot: {
						originalBaseBytes: snapshot.base,
						originalBaseDigest: snapshot.baseDigest,
						originalWalBytes: snapshot.wal,
						originalWalDigest: snapshot.walDigest,
					},
					decodedDocument: {
						mappings: decodedDocument.mappings,
						provisionalOperations: decodedDocument.provisionalOperations,
					},
					bindings,
				})
			: { status: "staged" as const, v3Bytes: bootstrapBytes, v3Digest: digest(bootstrapBytes) };
	if (staged.status === "blocked") {
		return { status: "blocked", canonicalPath, markerPath, reasons: staged.reasons };
	}
	const parsed = parseSessionAuthorityV3Document(staged.v3Bytes);
	if (parsed === undefined) throw new Error("V3 transformer produced an invalid authority document.");
	const canonicalBytes = Buffer.from(staged.v3Bytes);
	if (!Buffer.from(encodeSessionAuthorityV3Document(parsed)).equals(canonicalBytes))
		throw new Error("V3 transformer did not produce deterministic canonical bytes.");
	if (hasUnboundServingAuthority(parsed))
		return {
			status: "blocked",
			canonicalPath,
			markerPath,
			reasons: ["Staged historical authority requires restricted bootstrap generation proof before activation."],
		};
	const stagePath = join(root, "canonical.v3.json");
	writePrivate(root, "canonical.v3.json", canonicalBytes);
	// Reopening is deliberately against the private copy. It proves the strict V3
	// mapping store accepts the deterministic bytes before the canonical swap.
	const store = new V3FileBackedSessionMappingStore(stagePath);
	store.close();
	const reopened = readRegular(stagePath, MAX_AUTHORITY_BYTES, "staged V3 authority");
	if (!reopened.equals(canonicalBytes)) throw new Error("Reopening the V3 authority changed its deterministic bytes.");
	const journal: ActivationJournal = {
		kind: "openwebui-gjc-session-authority-v3-activation",
		version: 1,
		bootstrap: options.bootstrap !== undefined,
		phase: "prepared",
		activationV3Digest: staged.v3Digest,
		source: { baseDigest: snapshot.baseDigest, walDigest: snapshot.walDigest, walPresent: snapshot.walPresent },
		identities: {
			sourceBase: snapshot.baseIdentity,
			sourceWal: snapshot.walIdentity,
			stagedBase: fileIdentity(stagePath),
		},
		manifestDigest: digest(readRegular(join(root, "source-manifest.json"), 16 * 1024, "immutable snapshot manifest")),
	};
	writePrivate(root, "activation.json", encode(journal));
	fsyncDirectory(root);
	options.afterBoundary?.("stage");
	await assertLocks();
	if (!canonicalSnapshotMatches(canonicalPath, snapshot))
		return {
			status: "blocked",
			canonicalPath,
			markerPath,
			reasons: ["Canonical V2 authority changed before the activation swap."],
		};

	let finalBootstrapCheck: (() => void) | undefined;
	if (options.bootstrap !== undefined) {
		deadline.remaining();
		finalBootstrapCheck = await wait(options.beforeBootstrapCommit!());
		if (typeof finalBootstrapCheck !== "function")
			throw new Error("Bootstrap commit requires a synchronous final proof check.");
	}
	writePrivate(root, "activation.json", encode({ ...journal, phase: "committing" }));
	fsyncDirectory(root);
	options.afterBoundary?.("committing");
	await assertLocks();
	if (!canonicalSnapshotMatches(canonicalPath, snapshot))
		throw new Error("Canonical V2 authority changed at the activation commit boundary.");
	assertRetainedManifest(root, canonicalPath, journal);
	if (
		!matchesFileIdentity(stagePath, journal.identities.stagedBase) ||
		digest(readRegular(stagePath, MAX_AUTHORITY_BYTES, "committing staged V3")) !== journal.activationV3Digest
	)
		throw new Error("Staged V3 authority changed at the activation commit boundary.");
	if (lstatSync(markerPath, { throwIfNoEntry: false }) !== undefined)
		throw new Error("Active V3 marker appeared before the activation commit boundary.");
	options.mutationLock.assertHeld(canonicalPath);
	finalBootstrapCheck?.();
	renameSync(stagePath, canonicalPath);
	fsyncDirectory(dirname(canonicalPath));
	options.afterBoundary?.("base");
	await assertLocks();
	assertCommittedBase(canonicalPath, journal);
	removeOriginalWal(canonicalPath, journal);
	fsyncDirectory(dirname(canonicalPath));
	options.afterBoundary?.("wal");
	await assertLocks();
	writePrivate(root, "activation.json", encode({ ...journal, phase: "swapped" }));
	fsyncDirectory(root);
	options.afterBoundary?.("swap");
	await assertLocks();
	assertCommittedBase(canonicalPath, journal);
	assertWalAbsent(canonicalPath);
	new V3FileBackedSessionMappingStore(canonicalPath, options.mutationLock).close();

	// This is the sole marker creation point. The canonical V3 store never
	// rewrites this activation identity when mutable authority state changes.
	const marker: SessionAuthorityV3ActiveMarker = {
		kind: "openwebui-gjc-session-authority-active",
		version: 1,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		activationV3Digest: staged.v3Digest,
		source: journal.source,
	};
	options.mutationLock.assertHeld(canonicalPath);
	writeImmutable(markerPath, encode(marker));
	writePrivate(root, "activation.json", encode({ ...journal, phase: "marked" }));
	fsyncDirectory(root);
	options.afterBoundary?.("marker");
	return activated(canonicalPath, markerPath, marker);
}

function assertBootstrapGraph(initialBytes: Buffer, retainedBytes: Buffer, manifestDigest: string): void {
	const initial = parseSessionAuthorityV3Document(initialBytes);
	const retained = parseSessionAuthorityV3Document(retainedBytes);
	if (
		initial === undefined ||
		retained === undefined ||
		initial.mappings.length !== retained.mappings.length ||
		!isDeepStrictEqual(initial.provisionalOperations, retained.provisionalOperations)
	)
		throw new Error("Historical bootstrap changed the retained source graph.");
	for (let index = 0; index < initial.mappings.length; index++) {
		const original = initial.mappings[index]!;
		const current = retained.mappings[index]!;
		if (original.historicalBinding === undefined) {
			if (!isDeepStrictEqual(original, current))
				throw new Error("Bootstrap changed an already managed source occurrence.");
			continue;
		}
		const { historicalBinding: _history, managedAuthority: _managed, journal, ...fields } = current;
		const promoted = current.managedAuthority !== undefined;
		if (
			!isDeepStrictEqual(
				{
					...fields,
					...(promoted ? { chatId: original.chatId, header: { ...fields.header, chatId: original.chatId } } : {}),
					historicalBinding: original.historicalBinding,
					journal: journal.slice(0, original.journal.length),
				},
				original,
			)
		)
			throw new Error("Historical bootstrap changed immutable source history or projections.");
		const appended = journal.slice(original.journal.length);
		if (appended.length > 1) throw new Error("Historical bootstrap contains competing migration operations.");
		const operation = appended[0];
		if (
			operation !== undefined &&
			(!operation.id.startsWith("migration:resume:") ||
				operation.lifecycle?.historicalSource?.manifestDigest !== manifestDigest ||
				!isDeepStrictEqual(operation.lifecycle.historicalSource.historicalBinding, original.historicalBinding))
		)
			throw new Error("Historical bootstrap journal does not bind its exact source occurrence.");
		if (current.managedAuthority !== undefined) {
			const evidence = operation?.lifecycle;
			if (
				operation?.state !== "complete" ||
				evidence?.state !== "active_generation_proven" ||
				evidence.acknowledged === undefined ||
				current.chatId !==
					JSON.stringify([evidence.preparedAuthority.principalId, evidence.preparedAuthority.chatId]) ||
				!isDeepStrictEqual(current.managedAuthority, {
					...evidence.acknowledged,
					chatId: current.chatId,
					authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
				})
			)
				throw new Error("Historical bootstrap promotion lacks its completed exact generation receipt.");
		} else if (!isDeepStrictEqual(current.historicalBinding, original.historicalBinding))
			throw new Error("Historical bootstrap changed original occurrence provenance.");
	}
}

function retainHistoricalStage(root: string, stagePath: string, initialBytes: Buffer, manifestDigest: string): void {
	const checkpointPath = join(root, "historical-stage.json");
	const checkpoint = encode({
		kind: "openwebui-gjc-v3-historical-stage",
		version: 1,
		manifestDigest,
		initialGraphDigest: digest(initialBytes),
	});
	if (lstatSync(checkpointPath, { throwIfNoEntry: false }) !== undefined) {
		if (!readRegular(checkpointPath, 16 * 1024, "historical stage checkpoint").equals(checkpoint))
			throw new Error("Historical stage checkpoint conflicts with its immutable source manifest.");
		// A committed checkpoint makes absence/corruption evidence of loss, not
		// permission to recreate a stage and forget a possibly invoked operation.
		if (
			parseSessionAuthorityV3Document(
				readRegular(stagePath, MAX_AUTHORITY_BYTES, "retained historical V3 stage"),
			) === undefined
		)
			throw new Error("Retained historical stage is not a valid canonical V3 document.");
		return;
	}
	// No callback can have run before the immutable checkpoint. A crash in the
	// initial file/checkpoint window may reuse only the identical initial graph.
	writeImmutable(stagePath, initialBytes);
	fsyncDirectory(root);
	writeImmutable(checkpointPath, checkpoint);
	fsyncDirectory(root);
}

function recover(
	canonicalPath: string,
	markerPath: string,
	root: string,
	journalPath: string,
	mutationLock: AuthorityMutationLock,
): SessionAuthorityV3ActivationResult | undefined {
	const markerNamed = lstatSync(markerPath, { throwIfNoEntry: false });
	const marker = readMarker(markerPath);
	const journal = readJournal(journalPath);
	if (journal !== undefined) assertRetainedManifest(root, canonicalPath, journal);
	if (markerNamed !== undefined && (markerNamed.isSymbolicLink() || !markerNamed.isFile() || marker === undefined))
		throw new Error("Active V3 marker is invalid.");
	if (marker !== undefined) {
		if (journal !== undefined && !journalMatchesMarker(journal, marker))
			throw new Error("Active V3 marker does not match the activation journal.");
		if (canonicalV3Shape(canonicalPath) && sourceSnapshotMatches(root, marker.source)) {
			assertWalAbsent(canonicalPath);
			// The marker is the activation commit record. A crash after its fsync but
			// before the journal checkpoint is forward-only: never restore V2 or
			// compare against later mutable canonical bytes.
			if (journal !== undefined && journal.phase !== "marked") {
				mutationLock.assertHeld(canonicalPath);
				writePrivate(root, "activation.json", encode({ ...journal, phase: "marked" }));
				fsyncDirectory(root);
			}
			return activated(canonicalPath, markerPath, marker);
		}
		if (journal?.phase !== "committing" && journal?.phase !== "swapped")
			throw new Error("Active V3 marker does not bind a valid canonical V3 authority.");
	}
	if (journal === undefined) return undefined;
	if (journal.phase === "marked")
		throw new Error("Activation journal is marked but the active marker does not bind the canonical V3 authority.");
	if (journal.phase === "committing" || journal.phase === "swapped") {
		const stagePath = join(root, "canonical.v3.json");
		if (journal.phase === "committing" && matchesFileIdentity(canonicalPath, journal.identities.sourceBase)) {
			if (
				digest(readRegular(canonicalPath, MAX_AUTHORITY_BYTES, "committing original V2")) !==
					journal.source.baseDigest ||
				!matchesFileIdentity(stagePath, journal.identities.stagedBase) ||
				digest(readRegular(stagePath, MAX_AUTHORITY_BYTES, "committing staged V3")) !==
					journal.activationV3Digest ||
				!canonicalV3Shape(stagePath)
			)
				throw new Error("Committing activation cannot prove its original source and staged replacement.");
			const walPath = `${canonicalPath}.wal`;
			if (
				journal.identities.sourceWal === null
					? lstatSync(walPath, { throwIfNoEntry: false }) !== undefined
					: !matchesFileIdentity(walPath, journal.identities.sourceWal) ||
						digest(readRegular(walPath, MAX_WAL_BYTES, "committing original WAL")) !== journal.source.walDigest
			)
				throw new Error("Committing activation WAL identity changed; refusing recovery mutation.");
			if (journal.bootstrap)
				return {
					status: "blocked",
					canonicalPath,
					markerPath,
					reasons: ["Uncommitted bootstrap requires original-incarnation proof before replacing canonical V2."],
				};
			mutationLock.assertHeld(canonicalPath);
			renameSync(stagePath, canonicalPath);
		}
		if (
			!matchesFileIdentity(canonicalPath, journal.identities.stagedBase) ||
			digest(readRegular(canonicalPath, MAX_AUTHORITY_BYTES, "committing V3 authority")) !==
				journal.activationV3Digest ||
			!canonicalV3Shape(canonicalPath) ||
			!sourceSnapshotMatches(root, journal.source)
		)
			throw new Error(
				"Committing activation cannot prove its canonical V3 replacement; automatic V2 restoration is forbidden.",
			);
		mutationLock.assertHeld(canonicalPath);
		removeOriginalWal(canonicalPath, journal);
		fsyncDirectory(dirname(canonicalPath));
		new V3FileBackedSessionMappingStore(canonicalPath, mutationLock).close();
		const recoveredMarker: SessionAuthorityV3ActiveMarker = {
			kind: "openwebui-gjc-session-authority-active",
			version: 1,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			activationV3Digest: journal.activationV3Digest,
			source: journal.source,
		};
		mutationLock.assertHeld(canonicalPath);
		writeImmutable(markerPath, encode(recoveredMarker));
		writePrivate(root, "activation.json", encode({ ...journal, phase: "marked" }));
		fsyncDirectory(root);
		return activated(canonicalPath, markerPath, recoveredMarker);
	}
	if (
		!matchesFileIdentity(canonicalPath, journal.identities.sourceBase) ||
		digest(readRegular(canonicalPath, MAX_AUTHORITY_BYTES, "prepared V2 authority")) !== journal.source.baseDigest ||
		(journal.identities.sourceWal === null
			? lstatSync(`${canonicalPath}.wal`, { throwIfNoEntry: false }) !== undefined
			: !matchesFileIdentity(`${canonicalPath}.wal`, journal.identities.sourceWal) ||
				digest(readRegular(`${canonicalPath}.wal`, MAX_WAL_BYTES, "prepared V2 WAL")) !== journal.source.walDigest)
	)
		throw new Error("Prepared activation source changed; refusing to replace its snapshots.");
	return undefined;
}

function assertCommittedBase(canonicalPath: string, journal: ActivationJournal): void {
	if (
		!matchesFileIdentity(canonicalPath, journal.identities.stagedBase) ||
		digest(readRegular(canonicalPath, MAX_AUTHORITY_BYTES, "committing V3 authority")) !==
			journal.activationV3Digest ||
		!canonicalV3Shape(canonicalPath)
	)
		throw new Error("Committed V3 authority identity or content changed before activation.");
}

function removeOriginalWal(canonicalPath: string, journal: ActivationJournal): void {
	const walPath = `${canonicalPath}.wal`;
	if (lstatSync(walPath, { throwIfNoEntry: false }) === undefined) return;
	if (
		journal.identities.sourceWal === null ||
		!matchesFileIdentity(walPath, journal.identities.sourceWal) ||
		digest(readRegular(walPath, MAX_WAL_BYTES, "committing V2 WAL")) !== journal.source.walDigest
	)
		throw new Error("Committing activation WAL identity changed; refusing recovery mutation.");
	unlinkSync(walPath);
}

function assertWalAbsent(canonicalPath: string): void {
	if (lstatSync(`${canonicalPath}.wal`, { throwIfNoEntry: false }) !== undefined)
		throw new Error("Canonical V3 activation requires the committed WAL absence.");
}

function snapshotV2(canonicalPath: string): {
	base: Buffer;
	wal: Buffer;
	walPresent: boolean;
	baseDigest: string;
	walDigest: string;
	baseIdentity: ActivationFileIdentity;
	walIdentity: ActivationFileIdentity | null;
} {
	const baseIdentity = fileIdentity(canonicalPath);
	const base = readRegular(canonicalPath, MAX_AUTHORITY_BYTES, "canonical V2 authority");
	fsyncRegular(canonicalPath, "canonical V2 authority");
	const walPath = `${canonicalPath}.wal`;
	const walNamed = lstatSync(walPath, { throwIfNoEntry: false });
	if (walNamed?.isSymbolicLink() || (walNamed !== undefined && !walNamed.isFile()))
		throw new Error("Canonical V2 WAL is not a regular file.");
	const walPresent = walNamed !== undefined;
	const walIdentity = walPresent ? fileIdentity(walPath) : null;
	const wal = walPresent ? readRegular(walPath, MAX_WAL_BYTES, "canonical V2 WAL") : Buffer.alloc(0);
	if (walPresent) fsyncRegular(walPath, "canonical V2 WAL");
	fsyncDirectory(dirname(canonicalPath));
	if (
		!matchesFileIdentity(canonicalPath, baseIdentity) ||
		(walIdentity === null
			? lstatSync(walPath, { throwIfNoEntry: false }) !== undefined
			: !matchesFileIdentity(walPath, walIdentity))
	)
		throw new Error("Canonical V2 source identity changed during snapshot capture.");
	return { base, wal, walPresent, baseDigest: digest(base), walDigest: digest(wal), baseIdentity, walIdentity };
}

interface ImmutableSourceManifest {
	readonly kind: "openwebui-gjc-v3-source-snapshot";
	readonly version: 1;
	readonly canonicalPath: string;
	readonly authorityEpoch: typeof SESSION_AUTHORITY_V3_EPOCH;
	readonly canonicalReplaced: false;
	readonly originalBaseGeneration: string | null;
	readonly source: {
		readonly base: ActivationFileIdentity;
		readonly wal: ActivationFileIdentity | null;
		readonly baseDigest: string;
		readonly walDigest: string;
	};
	readonly snapshots: {
		readonly base: ActivationFileIdentity;
		readonly wal: ActivationFileIdentity | null;
		readonly absence: ActivationFileIdentity;
		readonly absenceDigest: string;
	};
}

async function captureImmutableSnapshot(
	canonicalPath: string,
	root: string,
	assertCurrent: () => Promise<void>,
	afterBoundary?: SessionAuthorityV3ActivationOptions["afterBoundary"],
): Promise<ReturnType<typeof snapshotV2>> {
	const manifestPath = join(root, "source-manifest.json");
	if (lstatSync(manifestPath, { throwIfNoEntry: false }) !== undefined) {
		const value: unknown = JSON.parse(
			readRegular(manifestPath, 16 * 1024, "immutable source manifest").toString("utf8"),
		);
		if (!isSourceManifest(value) || value.canonicalPath !== canonicalPath)
			throw new Error("Invalid immutable source manifest.");
		const basePath = join(root, "source.v2.json"),
			walPath = join(root, "source.v2.wal"),
			absencePath = join(root, "source.v2.absence.json");
		if (
			!matchesFileIdentity(basePath, value.snapshots.base) ||
			!matchesFileIdentity(absencePath, value.snapshots.absence) ||
			(value.snapshots.wal === null
				? lstatSync(walPath, { throwIfNoEntry: false }) !== undefined
				: !matchesFileIdentity(walPath, value.snapshots.wal))
		)
			throw new Error("Immutable source snapshot identity changed.");
		const base = readRegular(basePath, MAX_AUTHORITY_BYTES, "immutable source base");
		const wal =
			value.source.wal === null ? Buffer.alloc(0) : readRegular(walPath, MAX_WAL_BYTES, "immutable source WAL");
		const absence = readRegular(absencePath, 16 * 1024, "immutable WAL presence evidence");
		if (
			digest(base) !== value.source.baseDigest ||
			digest(wal) !== value.source.walDigest ||
			digest(absence) !== value.snapshots.absenceDigest ||
			baseGeneration(base) !== value.originalBaseGeneration ||
			!absence.equals(encode({ walPresent: value.source.wal !== null, baseIdentity: value.source.base }))
		)
			throw new Error("Immutable source snapshot content changed.");
		const snapshot = {
			base,
			wal,
			walPresent: value.source.wal !== null,
			baseDigest: value.source.baseDigest,
			walDigest: value.source.walDigest,
			baseIdentity: value.source.base,
			walIdentity: value.source.wal,
		};
		if (!canonicalSnapshotMatches(canonicalPath, snapshot))
			throw new Error("Canonical source changed from its immutable manifest.");
		return snapshot;
	}
	const snapshot = snapshotV2(canonicalPath);
	afterBoundary?.("snapshot");
	await assertCurrent();
	writeImmutable(join(root, "source.v2.json"), snapshot.base);
	if (snapshot.walPresent) writeImmutable(join(root, "source.v2.wal"), snapshot.wal);
	else if (lstatSync(join(root, "source.v2.wal"), { throwIfNoEntry: false }) !== undefined)
		throw new Error("Immutable source WAL conflicts with captured absence.");
	const absence = encode({ walPresent: snapshot.walPresent, baseIdentity: snapshot.baseIdentity });
	writeImmutable(join(root, "source.v2.absence.json"), absence);
	afterBoundary?.("backup");
	await assertCurrent();
	if (!canonicalSnapshotMatches(canonicalPath, snapshot))
		throw new Error("Canonical source changed before immutable manifest commit.");
	const manifest: ImmutableSourceManifest = {
		kind: "openwebui-gjc-v3-source-snapshot",
		version: 1,
		canonicalPath,
		authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
		canonicalReplaced: false,
		originalBaseGeneration: baseGeneration(snapshot.base),
		source: {
			base: snapshot.baseIdentity,
			wal: snapshot.walIdentity,
			baseDigest: snapshot.baseDigest,
			walDigest: snapshot.walDigest,
		},
		snapshots: {
			base: fileIdentity(join(root, "source.v2.json")),
			wal: snapshot.walPresent ? fileIdentity(join(root, "source.v2.wal")) : null,
			absence: fileIdentity(join(root, "source.v2.absence.json")),
			absenceDigest: digest(absence),
		},
	};
	writeImmutable(manifestPath, encode(manifest));
	afterBoundary?.("manifest");
	await assertCurrent();
	return snapshot;
}

function baseGeneration(bytes: Buffer): string | null {
	const value: unknown = JSON.parse(bytes.toString("utf8"));
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Invalid V2 source document.");
	const generation: unknown = Reflect.get(value, "generation");
	if (generation === undefined) return null;
	if (typeof generation !== "string" || generation.length === 0) throw new Error("Invalid V2 source base generation.");
	return generation;
}

function isSourceManifest(value: unknown): value is ImmutableSourceManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const manifest = value as Partial<ImmutableSourceManifest>;
	const source = manifest.source,
		snapshots = manifest.snapshots;
	return (
		Object.keys(value).length === 8 &&
		manifest.kind === "openwebui-gjc-v3-source-snapshot" &&
		manifest.version === 1 &&
		typeof manifest.canonicalPath === "string" &&
		manifest.canonicalPath === resolve(manifest.canonicalPath) &&
		manifest.authorityEpoch === SESSION_AUTHORITY_V3_EPOCH &&
		manifest.canonicalReplaced === false &&
		(manifest.originalBaseGeneration === null ||
			(typeof manifest.originalBaseGeneration === "string" && manifest.originalBaseGeneration.length > 0)) &&
		typeof source === "object" &&
		source !== null &&
		Object.keys(source).length === 4 &&
		isFileIdentity(source.base) &&
		(source.wal === null || isFileIdentity(source.wal)) &&
		SHA256.test(source.baseDigest) &&
		SHA256.test(source.walDigest) &&
		typeof snapshots === "object" &&
		snapshots !== null &&
		Object.keys(snapshots).length === 4 &&
		isFileIdentity(snapshots.base) &&
		isFileIdentity(snapshots.absence) &&
		SHA256.test(snapshots.absenceDigest) &&
		(source.wal === null ? snapshots.wal === null : isFileIdentity(snapshots.wal))
	);
}

function writeImmutable(path: string, bytes: Buffer): void {
	if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) {
		if (!readRegular(path, MAX_AUTHORITY_BYTES, "immutable snapshot").equals(bytes))
			throw new Error("Refusing to overwrite conflicting immutable snapshot evidence.");
		fsyncRegular(path, "immutable snapshot");
		fsyncDirectory(dirname(path));
		return;
	}
	const descriptor = openSync(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(descriptor, bytes);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	fsyncDirectory(dirname(path));
}

function canonicalSnapshotMatches(canonicalPath: string, snapshot: ReturnType<typeof snapshotV2>): boolean {
	try {
		if (!matchesFileIdentity(canonicalPath, snapshot.baseIdentity)) return false;
		if (digest(readRegular(canonicalPath, MAX_AUTHORITY_BYTES, "canonical V2 authority")) !== snapshot.baseDigest)
			return false;
		const walPath = `${canonicalPath}.wal`;
		const walNamed = lstatSync(walPath, { throwIfNoEntry: false });
		if (walNamed?.isSymbolicLink() || (walNamed !== undefined && !walNamed.isFile())) return false;
		if ((walNamed !== undefined) !== snapshot.walPresent) return false;
		if (snapshot.walIdentity !== null && !matchesFileIdentity(walPath, snapshot.walIdentity)) return false;
		return (
			!snapshot.walPresent || digest(readRegular(walPath, MAX_WAL_BYTES, "canonical V2 WAL")) === snapshot.walDigest
		);
	} catch {
		return false;
	}
}

function privateRoot(stagingRoot: string, canonicalPath: string): string {
	const root = resolve(stagingRoot, `session-authority-v3-${digest(canonicalPath).slice(0, 16)}`);
	if (root === dirname(canonicalPath) || canonicalPath.startsWith(`${root}/`))
		throw new Error("Activation staging root must be private and outside the canonical authority path.");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const named = lstatSync(root);
	if (!named.isDirectory() || named.isSymbolicLink())
		throw new Error("Activation staging root is not a private directory.");
	if (statSync(root).dev !== statSync(dirname(canonicalPath)).dev)
		throw new Error("Activation staging root must share a filesystem with the canonical authority.");
	return root;
}

function readRegular(path: string, maximum: number, label: string): Buffer {
	const named = lstatSync(path, { throwIfNoEntry: false });
	if (named === undefined || named.isSymbolicLink() || !named.isFile())
		throw new Error(`${label} is not a regular file.`);
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = statHeld(descriptor, label, maximum);
		const bytes = Buffer.alloc(before.size);
		for (let offset = 0; offset < bytes.length; ) {
			const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
			if (count === 0) throw new Error(`${label} changed while it was read.`);
			offset += count;
		}
		const after = statHeld(descriptor, label, maximum);
		const current = lstatSync(path, { throwIfNoEntry: false });
		if (
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs ||
			after.mode !== before.mode ||
			current === undefined ||
			current.dev !== before.dev ||
			current.ino !== before.ino ||
			current.mtimeMs !== before.mtimeMs ||
			current.ctimeMs !== before.ctimeMs ||
			current.mode !== before.mode
		)
			throw new Error(`${label} changed while it was read.`);
		return bytes;
	} finally {
		closeSync(descriptor);
	}
}

function statHeld(descriptor: number, label: string, maximum: number) {
	const stat = fstatSync(descriptor);
	if (!stat.isFile() || stat.size > maximum) throw new Error(`${label} is not a bounded regular file.`);
	return stat;
}

function writePrivate(root: string, name: string, bytes: Buffer): void {
	const path = join(root, name);
	if (dirname(path) !== root) throw new Error("Activation attempted to write outside its private staging root.");
	writeAtomic(path, bytes);
}

function writeAtomic(path: string, bytes: Buffer): void {
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		writeFileSync(descriptor, bytes);
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporary, path);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
		try {
			unlinkSync(temporary);
		} catch {
			// The temporary was renamed or was never created.
		}
	}
}

function fsyncRegular(path: string, label: string): void {
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if (!statHeld(descriptor, label, MAX_AUTHORITY_BYTES).isFile()) throw new Error(`${label} is not regular.`);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}
function fsyncDirectory(path: string): void {
	const descriptor = openSync(path, constants.O_RDONLY);
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}
function encode(value: unknown): Buffer {
	return Buffer.from(`${JSON.stringify(value)}\n`);
}
function digest(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}
function readMarker(path: string): SessionAuthorityV3ActiveMarker | undefined {
	try {
		const value: unknown = JSON.parse(readRegular(path, 16 * 1024, "active V3 marker").toString("utf8"));
		return isMarker(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function canonicalV3Shape(canonicalPath: string): boolean {
	try {
		const bytes = readRegular(canonicalPath, MAX_AUTHORITY_BYTES, "canonical V3 authority");
		return parseSessionAuthorityV3Document(bytes) !== undefined;
	} catch {
		return false;
	}
}

function sourceSnapshotMatches(root: string, source: SessionAuthorityV3ActiveMarker["source"]): boolean {
	try {
		readSourceBase(root, source);
		if (source.walPresent) readSourceWal(root, source);
		else if (lstatSync(join(root, "source.v2.wal"), { throwIfNoEntry: false }) !== undefined) return false;
		return true;
	} catch {
		return false;
	}
}

function assertRetainedManifest(root: string, canonicalPath: string, journal: ActivationJournal): void {
	const bytes = readRegular(join(root, "source-manifest.json"), 16 * 1024, "immutable snapshot manifest");
	const manifest: unknown = JSON.parse(bytes.toString("utf8"));
	if (
		digest(bytes) !== journal.manifestDigest ||
		!isSourceManifest(manifest) ||
		manifest.canonicalPath !== canonicalPath ||
		manifest.source.baseDigest !== journal.source.baseDigest ||
		manifest.source.walDigest !== journal.source.walDigest ||
		(manifest.source.wal !== null) !== journal.source.walPresent ||
		JSON.stringify(manifest.source.base) !== JSON.stringify(journal.identities.sourceBase) ||
		JSON.stringify(manifest.source.wal) !== JSON.stringify(journal.identities.sourceWal)
	)
		throw new Error("Activation journal does not match its immutable source manifest.");
	const walPath = join(root, "source.v2.wal"),
		absencePath = join(root, "source.v2.absence.json");
	if (
		!matchesFileIdentity(join(root, "source.v2.json"), manifest.snapshots.base) ||
		!matchesFileIdentity(absencePath, manifest.snapshots.absence) ||
		digest(readRegular(absencePath, 16 * 1024, "immutable WAL presence evidence")) !==
			manifest.snapshots.absenceDigest ||
		(manifest.snapshots.wal === null
			? lstatSync(walPath, { throwIfNoEntry: false }) !== undefined
			: !matchesFileIdentity(walPath, manifest.snapshots.wal)) ||
		!sourceSnapshotMatches(root, journal.source)
	)
		throw new Error("Immutable source snapshot identity or content changed during recovery.");
}

function readSourceBase(root: string, source: SessionAuthorityV3ActiveMarker["source"]): Buffer {
	const base = readRegular(join(root, "source.v2.json"), MAX_AUTHORITY_BYTES, "immutable V2 backup");
	if (digest(base) !== source.baseDigest)
		throw new Error("Immutable V2 backup digest does not match activation identity.");
	return base;
}

function readSourceWal(root: string, source: SessionAuthorityV3ActiveMarker["source"]): Buffer {
	const wal = readRegular(join(root, "source.v2.wal"), MAX_WAL_BYTES, "immutable V2 WAL backup");
	if (digest(wal) !== source.walDigest)
		throw new Error("Immutable V2 WAL backup digest does not match activation identity.");
	return wal;
}

function journalMatchesMarker(journal: ActivationJournal, marker: SessionAuthorityV3ActiveMarker): boolean {
	return (
		journal.activationV3Digest === marker.activationV3Digest &&
		journal.source.baseDigest === marker.source.baseDigest &&
		journal.source.walDigest === marker.source.walDigest &&
		journal.source.walPresent === marker.source.walPresent
	);
}

function activated(
	canonicalPath: string,
	markerPath: string,
	marker: SessionAuthorityV3ActiveMarker,
): SessionAuthorityV3ActivationResult {
	return {
		status: "activated",
		canonicalPath,
		markerPath,
		activationV3Digest: marker.activationV3Digest,
	};
}

type ActivationJournal = Readonly<{
	kind: "openwebui-gjc-session-authority-v3-activation";
	version: 1;
	bootstrap: boolean;
	phase: "prepared" | "committing" | "swapped" | "marked";
	activationV3Digest: string;
	source: SessionAuthorityV3ActiveMarker["source"];
	identities: Readonly<{
		sourceBase: ActivationFileIdentity;
		sourceWal: ActivationFileIdentity | null;
		stagedBase: ActivationFileIdentity;
	}>;
	manifestDigest: string;
}>;
function readJournal(path: string): ActivationJournal | undefined {
	if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return undefined;
	const value: unknown = JSON.parse(readRegular(path, 16 * 1024, "activation journal").toString("utf8"));
	if (!isJournal(value)) throw new Error("Invalid activation journal.");
	return value;
}
function isMarker(value: unknown): value is SessionAuthorityV3ActiveMarker {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const marker = value as Partial<SessionAuthorityV3ActiveMarker>;
	const source = marker.source;
	return (
		Object.keys(value).length === 5 &&
		marker.kind === "openwebui-gjc-session-authority-active" &&
		marker.version === 1 &&
		marker.authorityEpoch === SESSION_AUTHORITY_V3_EPOCH &&
		SHA256.test(marker.activationV3Digest ?? "") &&
		typeof source === "object" &&
		source !== null &&
		!Array.isArray(source) &&
		Object.keys(source).length === 3 &&
		SHA256.test(source.baseDigest ?? "") &&
		SHA256.test(source.walDigest ?? "") &&
		typeof source.walPresent === "boolean"
	);
}
function isJournal(value: unknown): value is ActivationJournal {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const journal = value as Partial<ActivationJournal>;
	return (
		Object.keys(value).length === 8 &&
		journal.kind === "openwebui-gjc-session-authority-v3-activation" &&
		journal.version === 1 &&
		typeof journal.bootstrap === "boolean" &&
		(journal.phase === "prepared" ||
			journal.phase === "committing" ||
			journal.phase === "swapped" ||
			journal.phase === "marked") &&
		SHA256.test(journal.activationV3Digest ?? "") &&
		SHA256.test(journal.manifestDigest ?? "") &&
		journal.identities !== undefined &&
		journal.identities !== null &&
		Object.keys(journal.identities).length === 3 &&
		isFileIdentity(journal.identities.sourceBase) &&
		isFileIdentity(journal.identities.stagedBase) &&
		(journal.identities.sourceWal === null
			? journal.source?.walPresent === false
			: isFileIdentity(journal.identities.sourceWal) && journal.source?.walPresent === true) &&
		isMarker({
			kind: "openwebui-gjc-session-authority-active",
			version: 1,
			authorityEpoch: SESSION_AUTHORITY_V3_EPOCH,
			activationV3Digest: journal.activationV3Digest,
			source: journal.source,
		})
	);
}

interface ActivationFileIdentity {
	readonly dev: string;
	readonly ino: string;
	readonly mode: string;
	readonly size: string;
	readonly mtimeNs: string;
	readonly mtimeMs: number;
}

function fileIdentity(path: string): ActivationFileIdentity {
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(descriptor, { bigint: true });
		if (!stat.isFile()) throw new Error("Activation identity is not a regular file.");
		return {
			dev: String(stat.dev),
			ino: String(stat.ino),
			mode: String(stat.mode),
			size: String(stat.size),
			mtimeNs: String(stat.mtimeNs),
			mtimeMs: fstatSync(descriptor).mtimeMs,
		};
	} finally {
		closeSync(descriptor);
	}
}

function isFileIdentity(value: unknown): value is ActivationFileIdentity {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === 6 &&
		typeof Reflect.get(value, "mtimeMs") === "number" &&
		Number.isFinite(Reflect.get(value, "mtimeMs")) &&
		Reflect.get(value, "mtimeMs") >= 0 &&
		["dev", "ino", "mode", "size", "mtimeNs"].every(
			key => typeof Reflect.get(value, key) === "string" && /^\d+$/.test(Reflect.get(value, key)),
		)
	);
}

function matchesFileIdentity(path: string, expected: ActivationFileIdentity): boolean {
	try {
		const current = fileIdentity(path);
		return (Object.keys(current) as (keyof ActivationFileIdentity)[]).every(key => current[key] === expected[key]);
	} catch {
		return false;
	}
}
