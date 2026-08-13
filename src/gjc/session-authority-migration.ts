import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { AuthorityMutationLock } from "./session-authority-file";
import { compactAuthorityForRelocation, walBindingForBase } from "./session-authority-persistence";
import {
	type ProvisionalSessionOperation,
	SESSION_AUTHORITY_MIGRATION_VERSION,
	SESSION_AUTHORITY_VERSION,
	SESSION_MAPPING_SCOPE_OBSERVATION,
	type SessionAuthorityMigrationCheckpoint,
	type SessionAuthorityMigrationCounts,
	type SessionAuthorityMigrationItem,
	type SessionAuthorityMigrationOptions,
	type SessionAuthorityMigrationResult,
	type SessionAuthorityRecord,
	type SessionOperation,
} from "./session-authority-types";
import {
	isAuthorityDocumentRelationallyValid,
	isLegacyMappingDocument,
	isProvisionalOperation,
	isV2Record,
} from "./session-authority-validation";

const MIGRATION_KIND = "openwebui-gjc-session-authority-migration" as const;
const RECOVERY_KIND = "openwebui-gjc-session-authority-migration-recovery" as const;
const ZERO_TIME = "1970-01-01T00:00:00.000Z";
const RETRYABLE_ORPHANED_PROVISIONAL_REASON =
	/^legacy provisional operation \d+ is malformed or ambiguous: operation references unknown chat ID /u;

type MigrationClock = () => string;

export interface SessionAuthorityMigrationRequest extends SessionAuthorityMigrationOptions {
	/**
	 * Destination authority path. Legacy single-source calls default to sourcePath;
	 * candidate migrations retain the source bytes and write only this destination.
	 */
	readonly destinationPath?: string;
	readonly now?: MigrationClock;
}

export interface SessionAuthorityMigrationCandidatesRequest {
	readonly candidateSourcePaths: readonly string[];
	readonly destinationPath: string;
	readonly stateRoot: string;
	readonly adminPrincipalId: string;
	readonly now?: MigrationClock;
}

export class SessionAuthorityMigrationError extends Error {
	readonly result?: SessionAuthorityMigrationResult;

	constructor(message: string, result?: SessionAuthorityMigrationResult, cause?: unknown) {
		super(message, { cause });
		this.name = "SessionAuthorityMigrationError";
		this.result = result;
	}
}

interface RecoveryManifest {
	readonly kind: typeof RECOVERY_KIND;
	readonly version: typeof SESSION_AUTHORITY_MIGRATION_VERSION;
	readonly sourcePath: string;
	readonly sourceSha256: string;
	readonly adminPrincipalId: string;
	readonly sourceRecoveryPath: string;
	readonly destinationPath: string;
	readonly expectedDestinationSha256?: string;
	readonly status: "source-retained" | "destination-written" | "checkpointed" | "degraded";
	readonly updatedAt: string;
}

interface MigrationPaths {
	readonly destinationPath: string;
	readonly recoveryPath: string;
	readonly checkpointPath: string;
	readonly auditPath: string;
	readonly quarantineDirectory: string;
}
interface LegacyDocument {
	readonly mappings: readonly unknown[];
	readonly provisionalOperations: readonly unknown[];
}

interface ConversionResult {
	readonly mappings: readonly SessionAuthorityRecord[];
	readonly provisionalOperations: readonly ProvisionalSessionOperation[];
	readonly items: readonly SessionAuthorityMigrationItem[];
}

interface ParsedCheckpoint {
	readonly value?: SessionAuthorityMigrationCheckpoint;
	readonly invalid?: string;
}

type ParsedManifest =
	| { readonly status: "missing" }
	| { readonly status: "invalid"; readonly reason: string }
	| { readonly status: "valid"; readonly value: RecoveryManifest };
function nonDurableDegradedResult(
	sourcePath: string,
	_adminPrincipalId: string,
	paths: MigrationPaths,
	reason: string,
): SessionAuthorityMigrationResult {
	let sourceSha256: string | undefined;
	try {
		const sourceBytes = readFileIfPresent(sourcePath);
		sourceSha256 = sourceBytes === undefined ? undefined : digest(sourceBytes);
	} catch {
		// Preserve the original persistence failure as the sole bounded reason.
	}
	return {
		status: "degraded",
		sourcePath,
		sourceSha256,
		migrationRecoveryPath: paths.recoveryPath,
		recoveryPath: paths.recoveryPath,
		destinationPath: paths.destinationPath,
		checkpointPath: paths.checkpointPath,
		auditPath: paths.auditPath,
		counts: sourceSha256 === undefined ? emptyCounts() : { total: 1, migrated: 0, quarantined: 1, skipped: 0 },
		reason,
	};
}

/**
 * Converts a legacy single-owner authority before FileSessionAuthority is opened.
 *
 * The source is never cleared on a degraded result. A source-byte copy is durable
 * before conversion, and destination replacement is durable before its checkpoint.
 */
export function preflightSessionAuthorityMigration(
	options: SessionAuthorityMigrationRequest,
): SessionAuthorityMigrationResult {
	const sourcePath = requirePath(options.sourcePath, "sourcePath");
	const stateRoot = requirePath(options.stateRoot, "stateRoot");
	const adminPrincipalId = requirePrincipal(options.adminPrincipalId);
	const destinationPath = requirePath(options.destinationPath ?? sourcePath, "destinationPath");
	const paths = migrationPaths(sourcePath, stateRoot, destinationPath);
	const now = options.now ?? (() => new Date().toISOString());
	const locks: Array<ReturnType<typeof AuthorityMutationLock.acquire>> = [];
	try {
		for (const lockPath of migrationLockPaths(sourcePath, destinationPath, stateRoot)) {
			locks.push(AuthorityMutationLock.acquire(lockPath));
		}
		return runMigration(sourcePath, adminPrincipalId, paths, now);
	} catch (error) {
		return nonDurableDegradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			`migration preflight persistence failed: ${errorMessage(error)}`,
		);
	} finally {
		for (const lock of locks.reverse()) lock.release();
	}
}

export function preflightSessionAuthorityMigrationCandidates(
	options: SessionAuthorityMigrationCandidatesRequest,
): SessionAuthorityMigrationResult {
	const destinationPath = requirePath(options.destinationPath, "destinationPath");
	const stateRoot = requirePath(options.stateRoot, "stateRoot");
	const adminPrincipalId = requirePrincipal(options.adminPrincipalId);
	const now = options.now;
	const targetResult = preflightSessionAuthorityMigration({
		sourcePath: destinationPath,
		destinationPath,
		stateRoot,
		adminPrincipalId,
		...(now === undefined ? {} : { now }),
	});
	if (targetResult.status === "degraded") return targetResult;
	const committedCandidateResults: SessionAuthorityMigrationResult[] = [];
	const seen = new Set<string>();
	for (const candidate of options.candidateSourcePaths) {
		const sourcePath = requirePath(candidate, "candidateSourcePath");
		if (sourcePath === destinationPath || seen.has(sourcePath)) continue;
		seen.add(sourcePath);
		if (!existsSync(sourcePath)) continue;
		if (candidateMigrationAlreadyCommitted(sourcePath, adminPrincipalId, stateRoot, destinationPath)) continue;
		const candidateResult = preflightSessionAuthorityMigration({
			sourcePath,
			destinationPath,
			stateRoot,
			adminPrincipalId,
			...(now === undefined ? {} : { now }),
		});
		if (candidateResult.status === "degraded") return candidateResult;
		if (candidateResult.status === "committed") committedCandidateResults.push(candidateResult);
	}
	return committedCandidateResults.at(-1) ?? targetResult;
}
function candidateMigrationAlreadyCommitted(
	sourcePath: string,
	adminPrincipalId: string,
	stateRoot: string,
	destinationPath: string,
): boolean {
	let lock: ReturnType<typeof AuthorityMutationLock.acquire> | undefined;
	try {
		// Hold the source authority mutation lock through the WAL-existence and
		// digest checks: a concurrent mutation must not append its first WAL
		// between the check and the skip decision, or the candidate would be
		// skipped while the destination lacks the newly acknowledged mutation.
		lock = AuthorityMutationLock.acquire(sourcePath);
		const paths = migrationPaths(sourcePath, stateRoot, destinationPath);
		const checkpointState = readCheckpoint(paths.checkpointPath);
		const checkpoint = checkpointState.value;
		if (
			checkpointState.invalid !== undefined ||
			checkpoint === undefined ||
			checkpoint.status !== "committed" ||
			checkpoint.destinationSha256 === undefined ||
			!checkpointMatchesRequest(checkpoint, sourcePath, adminPrincipalId, paths)
		)
			return false;
		// A source WAL may carry acknowledged mutations that exist only beside
		// the retained old path; the candidate is not "already committed" until
		// those are merged into the destination. A stale WAL bound to a previous
		// base (e.g. left by a crash after base compaction) carries no applicable
		// mutations and must not force a rewrite, while a malformed header fails
		// closed.
		const walBinding = walBindingForBase(`${sourcePath}.wal`, sourcePath);
		if (walBinding === "malformed") throw new Error("authority WAL header is malformed");
		if (walBinding === "current") return false;
		const sourceBytes = readFileIfPresent(sourcePath);
		const recoveryBytes = readFileIfPresent(checkpoint.sourceRecoveryPath);
		const destinationBytes = readFileIfPresent(destinationPath);
		return (
			sourceBytes !== undefined &&
			recoveryBytes !== undefined &&
			destinationBytes !== undefined &&
			digest(sourceBytes) === checkpoint.sourceSha256 &&
			digest(recoveryBytes) === checkpoint.sourceSha256 &&
			recoveryBytes.equals(sourceBytes) &&
			digest(destinationBytes) === checkpoint.destinationSha256
		);
	} catch {
		return false;
	} finally {
		lock?.release();
	}
}
function runMigration(
	sourcePath: string,
	adminPrincipalId: string,
	paths: MigrationPaths,
	now: MigrationClock,
): SessionAuthorityMigrationResult {
	const checkpointState = readCheckpoint(paths.checkpointPath);
	if (checkpointState.invalid !== undefined) {
		return degradedWithoutCheckpoint(
			sourcePath,
			adminPrincipalId,
			paths,
			now,
			`migration checkpoint is invalid: ${checkpointState.invalid}`,
		);
	}
	const checkpoint = checkpointState.value;
	if (checkpoint !== undefined && !checkpointMatchesRequest(checkpoint, sourcePath, adminPrincipalId, paths)) {
		return degradedWithoutCheckpoint(
			sourcePath,
			adminPrincipalId,
			paths,
			now,
			"migration checkpoint belongs to a different source or principal",
		);
	}

	const sourceExists = existsSync(sourcePath);
	let sourceBytes: Buffer | undefined;
	if (sourceExists) {
		// A v2 authority whose latest acknowledged mutations exist only in its
		// WAL must be compacted (WAL replayed into the base, WAL truncated)
		// BEFORE the source is read, so relocation/migration copies the complete
		// committed state instead of silently losing WAL-only mutations. Only
		// fully valid v2 documents are compacted; anything else is left for the
		// migration flow's own classification (and an unreadable WAL fails the
		// preflight loudly instead of losing mutations silently). The source
		// authority mutation lock is held across the compaction AND the snapshot
		// read, so a concurrent mutation cannot append a delta that the copied
		// bytes would omit while the migration reports success.
		const probe = parseJson(readFileSync(sourcePath));
		if (probe.ok && isAuthorityDocument(probe.value)) {
			const lock = AuthorityMutationLock.acquire(sourcePath);
			try {
				// Compact only a CURRENT WAL: a stale WAL bound to a previous base
				// carries no applicable mutations and rewriting the base would only
				// churn its digest.
				const walBinding = walBindingForBase(`${sourcePath}.wal`, sourcePath);
				if (walBinding === "malformed") throw new Error("authority WAL header is malformed");
				if (walBinding === "current") compactAuthorityForRelocation(sourcePath, lock);
				sourceBytes = readFileSync(sourcePath);
			} finally {
				lock.release();
			}
		} else {
			sourceBytes = readFileSync(sourcePath);
		}
	}
	const sourceSha256 = sourceBytes === undefined ? undefined : digest(sourceBytes);
	const manifestState = readManifest(paths.auditPath);
	let retryingOrphanedProvisionalCheckpoint = false;
	if (checkpoint?.status === "degraded") {
		if (sourceBytes !== undefined && sourceSha256 !== checkpoint.sourceSha256) {
			const quarantinePath = quarantineBytes(sourceBytes, paths.quarantineDirectory, sourceSha256 as string);
			return degradedResult(
				sourcePath,
				adminPrincipalId,
				paths,
				checkpoint,
				now,
				"source bytes changed after a degraded migration checkpoint",
				quarantinePath,
				sourceSha256,
			);
		}
		if (
			!canRetryOrphanedProvisionalCheckpoint(checkpoint, sourceBytes) &&
			!canRetryV2NormalizationCheckpoint(checkpoint, sourceBytes)
		) {
			return resultFromCheckpoint(checkpoint, paths, sourceSha256);
		}
		retryingOrphanedProvisionalCheckpoint = true;
	}
	const manifestInvalidReason =
		manifestState.status === "invalid"
			? `migration recovery manifest is invalid: ${manifestState.reason}`
			: manifestState.status === "valid" &&
					!(retryingOrphanedProvisionalCheckpoint && manifestState.value.status === "degraded")
				? invalidManifestReason(manifestState.value, sourcePath, adminPrincipalId, paths)
				: undefined;
	const manifestRequestMismatch =
		manifestState.status === "valid" &&
		!manifestMatchesRequest(manifestState.value, sourcePath, adminPrincipalId, paths);
	if (
		manifestRequestMismatch ||
		(manifestInvalidReason !== undefined && !(sourceBytes === undefined && checkpoint?.status === "committed"))
	)
		return degradedForInvalidManifest(
			sourcePath,
			adminPrincipalId,
			paths,
			checkpoint,
			sourceBytes,
			sourceSha256,
			now,
			manifestInvalidReason ?? "migration recovery manifest belongs to a different source or principal",
		);

	if (sourceBytes === undefined) {
		if (manifestState.status === "valid") {
			if (
				checkpoint?.status === "committed" &&
				checkpoint.sourceSha256 !== manifestState.value.sourceSha256 &&
				manifestState.value.status !== "destination-written"
			)
				return recoverMissingDestination(sourcePath, adminPrincipalId, paths, checkpoint, now);
			const recovered = recoverMissingDestinationFromManifest(
				sourcePath,
				adminPrincipalId,
				paths,
				manifestState.value,
				now,
			);
			if (recovered !== undefined) return recovered;
		}
		if (checkpoint?.status === "committed")
			return recoverMissingDestination(sourcePath, adminPrincipalId, paths, checkpoint, now);
		return notNeededResult(sourcePath, paths);
	}

	const parsed = parseJson(sourceBytes);
	if (
		parsed.ok &&
		isV2AuthorityContainer(parsed.value) &&
		isV2ContainerFullyScoped(parsed.value) &&
		!isV2ContainerScopedForAdmin(parsed.value, adminPrincipalId)
	) {
		const currentSha256 = sourceSha256 as string;
		if (
			paths.destinationPath !== sourcePath &&
			checkpoint?.status === "committed" &&
			checkpoint.sourceSha256 !== currentSha256
		) {
			const quarantinePath = quarantineBytes(sourceBytes, paths.quarantineDirectory, currentSha256);
			return degradedResult(
				sourcePath,
				adminPrincipalId,
				paths,
				checkpoint,
				now,
				"source bytes do not match the committed migration checkpoint",
				quarantinePath,
				currentSha256,
				checkpoint.sourceRecoveryPath,
			);
		}
		if (
			checkpoint?.status === "committed" &&
			checkpoint.destinationSha256 === currentSha256 &&
			existsSync(paths.destinationPath)
		)
			return resultFromCheckpoint(checkpoint, paths, currentSha256);
		return commitScopedRuntimeDestination(
			sourcePath,
			adminPrincipalId,
			paths,
			parsed.value as {
				readonly mappings: readonly SessionAuthorityRecord[];
				readonly provisionalOperations?: readonly ProvisionalSessionOperation[];
			},
			sourceBytes,
			now,
		);
	}
	if (
		paths.destinationPath === sourcePath &&
		checkpoint?.status === "committed" &&
		manifestState.status === "valid" &&
		parsed.ok &&
		isV2AuthorityContainer(parsed.value) &&
		isV2ContainerScopedForAdmin(parsed.value, adminPrincipalId) &&
		checkpoint.destinationSha256 !== sourceSha256
	) {
		const recovered = recoverCheckpointAfterDestination(
			sourcePath,
			adminPrincipalId,
			paths,
			manifestState.value,
			sourceSha256 as string,
			now,
		);
		if (recovered?.status === "committed") return recovered;
		if (recovered?.reason?.includes("fully scoped v2 authority recovery source has unbound operation identity"))
			return recovered;
		if (isAuthorityDocument(parsed.value))
			return commitScopedRuntimeDestination(sourcePath, adminPrincipalId, paths, parsed.value, sourceBytes, now);
	}
	if (
		parsed.ok &&
		isV2AuthorityContainer(parsed.value) &&
		isV2ContainerScopedForAdmin(parsed.value, adminPrincipalId)
	) {
		const currentSha256 = sourceSha256 as string;
		if (
			paths.destinationPath !== sourcePath &&
			checkpoint?.status === "committed" &&
			checkpoint.sourceSha256 !== currentSha256
		) {
			const quarantinePath = quarantineBytes(sourceBytes, paths.quarantineDirectory, currentSha256);
			return degradedResult(
				sourcePath,
				adminPrincipalId,
				paths,
				checkpoint,
				now,
				"source bytes do not match the committed migration checkpoint",
				quarantinePath,
				currentSha256,
				checkpoint.sourceRecoveryPath,
			);
		}
		if (
			checkpoint?.status === "committed" &&
			checkpoint.destinationSha256 === currentSha256 &&
			existsSync(paths.destinationPath)
		)
			return resultFromCheckpoint(checkpoint, paths, currentSha256);
		if (paths.destinationPath !== sourcePath)
			return commitScopedRuntimeDestination(
				sourcePath,
				adminPrincipalId,
				paths,
				parsed.value as {
					readonly mappings: readonly SessionAuthorityRecord[];
					readonly provisionalOperations?: readonly ProvisionalSessionOperation[];
				},
				sourceBytes,
				now,
			);
		if (checkpoint?.status === "committed") {
			const quarantinePath = quarantineBytes(sourceBytes, paths.quarantineDirectory, currentSha256);
			return degradedResult(
				sourcePath,
				adminPrincipalId,
				paths,
				checkpoint,
				now,
				"destination bytes do not match the committed migration checkpoint",
				quarantinePath,
				currentSha256,
			);
		}
		const manifest = manifestState.status === "valid" ? manifestState.value : undefined;
		if (checkpoint === undefined && manifest !== undefined) {
			const recovered = recoverCheckpointAfterDestination(
				sourcePath,
				adminPrincipalId,
				paths,
				manifest,
				currentSha256,
				now,
			);
			if (recovered !== undefined) return recovered;
		}
		if (!isAuthorityDocument(parsed.value)) {
			const quarantinePath = quarantineBytes(sourceBytes, paths.quarantineDirectory, currentSha256);
			return degradedResult(
				sourcePath,
				adminPrincipalId,
				paths,
				checkpoint,
				now,
				"fully scoped v2 authority destination is malformed",
				quarantinePath,
				currentSha256,
			);
		}
		return notNeededResult(sourcePath, paths, currentSha256);
	}

	const sourceRecoveryPath = retainSourceBytes(
		sourceBytes,
		sourceSha256 as string,
		sourcePath,
		adminPrincipalId,
		paths,
		now,
	);
	if (
		parsed.ok &&
		isV2AuthorityContainer(parsed.value) &&
		hasScopedV2MappingsForAdmin(parsed.value, adminPrincipalId) &&
		!isV2ContainerScopedForAdmin(parsed.value, adminPrincipalId)
	) {
		return degradeInvalidScopedV2Source(
			sourcePath,
			adminPrincipalId,
			paths,
			sourceBytes,
			sourceSha256 as string,
			sourceRecoveryPath,
			now,
		);
	}
	const manifest = manifestState.status === "valid" ? manifestState.value : undefined;
	if (
		manifest !== undefined &&
		manifest.sourceSha256 !== sourceSha256 &&
		!(parsed.ok && isV2AuthorityContainer(parsed.value))
	) {
		return degradedForInvalidManifest(
			sourcePath,
			adminPrincipalId,
			paths,
			checkpoint,
			sourceBytes,
			sourceSha256,
			now,
			"legacy source bytes do not match the recovery manifest",
		);
	}
	if (manifest !== undefined && !manifestMatchesRequest(manifest, sourcePath, adminPrincipalId, paths)) {
		const quarantinePath = quarantineBytes(sourceBytes, paths.quarantineDirectory, sourceSha256 as string);
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			checkpoint,
			now,
			"migration recovery manifest belongs to a different source or principal",
			quarantinePath,
			sourceSha256,
			sourceRecoveryPath,
		);
	}

	if (
		checkpoint?.status === "committed" &&
		sourceSha256 !== checkpoint.sourceSha256 &&
		!(parsed.ok && isV2AuthorityContainer(parsed.value))
	) {
		const quarantinePath = quarantineBytes(sourceBytes, paths.quarantineDirectory, sourceSha256 as string);
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			checkpoint,
			now,
			"legacy source bytes do not match the committed migration checkpoint",
			quarantinePath,
			sourceSha256,
			sourceRecoveryPath,
		);
	}

	let conversion: ConversionResult;
	try {
		conversion = parsed.ok
			? convertParsedAuthoritySource(parsed.value, adminPrincipalId, now)
			: (() => {
					throw new Error(`authority source JSON is unreadable: ${parsed.error}`);
				})();
	} catch (error) {
		const reason = error instanceof Error ? error.message : "authority conversion failed";
		const failedDocument = parsed.ok ? parseLegacyDocument(parsed.value) : undefined;
		const failedMappings =
			failedDocument?.mappings ?? (parsed.ok && isV2AuthorityContainer(parsed.value) ? parsed.value.mappings : []);
		const failedProvisionalOperations =
			failedDocument?.provisionalOperations ??
			(parsed.ok && isV2AuthorityContainer(parsed.value)
				? v2ProvisionalOperationEntries(parsed.value.provisionalOperations)
				: []);
		const items = [
			...failedMappings.map((item, index) => quarantinedItem(item, index, reason)),
			...failedProvisionalOperations.map((item, index) => ({
				...quarantinedItem(item, failedMappings.length + index, reason),
				identity: `provisional:${index}:${isObject(item) && typeof item.chatId === "string" ? item.chatId : "unknown"}`,
			})),
		];
		const quarantinePath = quarantineBytes(sourceBytes, paths.quarantineDirectory, sourceSha256 as string);
		const degradedCheckpoint = writeDegradedCheckpoint(
			sourcePath,
			adminPrincipalId,
			paths,
			sourceRecoveryPath,
			sourceSha256 as string,
			items,
			reason,
			now,
			quarantinePath,
		);
		return resultFromCheckpoint(degradedCheckpoint, paths, sourceSha256, quarantinePath);
	}

	const destinationDocument = {
		kind: "openwebui-gjc-session-authority" as const,
		version: SESSION_AUTHORITY_VERSION,
		mappings: conversion.mappings,
		provisionalOperations: conversion.provisionalOperations,
	};
	const destinationBytes = Buffer.from(`${JSON.stringify(destinationDocument, null, 2)}\n`, "utf8");
	const destinationSha256 = digest(destinationBytes);
	if (paths.destinationPath !== sourcePath) {
		const existingDestination = readFileIfPresent(paths.destinationPath);
		if (existingDestination !== undefined && digest(existingDestination) !== destinationSha256) {
			const existingSha256 = digest(existingDestination);
			return degradedResult(
				sourcePath,
				adminPrincipalId,
				paths,
				undefined,
				now,
				"existing authority destination does not match the migration output",
				quarantineBytes(existingDestination, paths.quarantineDirectory, existingSha256),
				existingSha256,
				sourceRecoveryPath,
			);
		}
	}
	try {
		writeManifest(paths.auditPath, {
			kind: RECOVERY_KIND,
			version: SESSION_AUTHORITY_MIGRATION_VERSION,
			sourcePath,
			sourceSha256: sourceSha256 as string,
			adminPrincipalId,
			sourceRecoveryPath,
			destinationPath: paths.destinationPath,
			expectedDestinationSha256: destinationSha256,
			status: "source-retained",
			updatedAt: now(),
		});
	} catch (error) {
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			undefined,
			now,
			`cannot durably write migration recovery manifest: ${errorMessage(error)}`,
			undefined,
			sourceSha256,
			sourceRecoveryPath,
		);
	}

	try {
		writeDurableFile(paths.destinationPath, destinationBytes);
	} catch (error) {
		const reason = `cannot durably write migrated authority: ${errorMessage(error)}`;
		const currentBytes = readFileIfPresent(paths.destinationPath);
		const currentSha256 = currentBytes === undefined ? undefined : digest(currentBytes);
		const quarantinePath =
			currentBytes === undefined || currentSha256 === sourceSha256
				? undefined
				: quarantineBytes(currentBytes, paths.quarantineDirectory, currentSha256 as string);
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			undefined,
			now,
			reason,
			quarantinePath,
			currentSha256,
			sourceRecoveryPath,
		);
	}

	try {
		writeManifest(paths.auditPath, {
			kind: RECOVERY_KIND,
			version: SESSION_AUTHORITY_MIGRATION_VERSION,
			sourcePath,
			sourceSha256: sourceSha256 as string,
			adminPrincipalId,
			sourceRecoveryPath,
			destinationPath: paths.destinationPath,
			expectedDestinationSha256: destinationSha256,
			status: "destination-written",
			updatedAt: now(),
		});
	} catch (error) {
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			undefined,
			now,
			`cannot durably update migration recovery manifest: ${errorMessage(error)}`,
			undefined,
			sourceSha256,
			sourceRecoveryPath,
		);
	}

	let committedCheckpoint: SessionAuthorityMigrationCheckpoint;
	try {
		committedCheckpoint = writeCommittedCheckpoint(
			sourcePath,
			adminPrincipalId,
			paths,
			sourceRecoveryPath,
			sourceSha256 as string,
			destinationSha256,
			conversion.items,
			now,
		);
	} catch (error) {
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			undefined,
			now,
			`cannot durably write migration checkpoint: ${errorMessage(error)}`,
			undefined,
			digest(readFileSync(paths.destinationPath)),
			sourceRecoveryPath,
		);
	}
	try {
		writeManifest(paths.auditPath, {
			kind: RECOVERY_KIND,
			version: SESSION_AUTHORITY_MIGRATION_VERSION,
			sourcePath,
			sourceSha256: sourceSha256 as string,
			adminPrincipalId,
			sourceRecoveryPath,
			destinationPath: paths.destinationPath,
			expectedDestinationSha256: destinationSha256,
			status: "checkpointed",
			updatedAt: now(),
		});
	} catch {
		// The committed checkpoint is sufficient to resume safely; a later run may repair the audit marker.
	}
	return resultFromCheckpoint(committedCheckpoint, paths, digest(readFileSync(paths.destinationPath)));
}

function recoverMissingDestinationFromManifest(
	sourcePath: string,
	adminPrincipalId: string,
	paths: MigrationPaths,
	manifest: RecoveryManifest,
	now: MigrationClock,
): SessionAuthorityMigrationResult | undefined {
	if (!manifestMatchesRequest(manifest, sourcePath, adminPrincipalId, paths))
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			undefined,
			now,
			"migration recovery manifest belongs to a different source or principal",
			undefined,
			undefined,
			manifest.sourceRecoveryPath,
		);
	if (manifest.status === "degraded") return undefined;
	const sourceRecovery = readFileIfPresent(manifest.sourceRecoveryPath);
	if (sourceRecovery === undefined || digest(sourceRecovery) !== manifest.sourceSha256)
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			undefined,
			now,
			"migration source recovery bytes are missing or do not match the recovery manifest",
			undefined,
			undefined,
			manifest.sourceRecoveryPath,
		);
	let recovered: { readonly conversion: ConversionResult; readonly destinationBytes: Buffer };
	try {
		recovered = recoverConversion(sourceRecovery, adminPrincipalId, now);
	} catch (error) {
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			undefined,
			now,
			`migration source recovery conversion failed: ${errorMessage(error)}`,
			undefined,
			manifest.sourceSha256,
			manifest.sourceRecoveryPath,
		);
	}
	const { conversion, destinationBytes } = recovered;
	const destinationSha256 = digest(destinationBytes);
	if (manifest.expectedDestinationSha256 !== undefined && manifest.expectedDestinationSha256 !== destinationSha256)
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			undefined,
			now,
			"missing authority destination does not match recovered migration output",
			undefined,
			manifest.sourceSha256,
			manifest.sourceRecoveryPath,
		);
	try {
		writeDurableFile(paths.destinationPath, destinationBytes);
		const checkpoint = writeCommittedCheckpoint(
			sourcePath,
			adminPrincipalId,
			paths,
			manifest.sourceRecoveryPath,
			manifest.sourceSha256,
			destinationSha256,
			conversion.items,
			now,
		);
		return resultFromCheckpoint(checkpoint, paths, destinationSha256);
	} catch (error) {
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			undefined,
			now,
			`cannot restore migration destination: ${errorMessage(error)}`,
			undefined,
			manifest.sourceSha256,
			manifest.sourceRecoveryPath,
		);
	}
}
function recoverMissingDestination(
	sourcePath: string,
	adminPrincipalId: string,
	paths: MigrationPaths,
	checkpoint: SessionAuthorityMigrationCheckpoint,
	now: MigrationClock,
): SessionAuthorityMigrationResult {
	const sourceRecovery = readFileIfPresent(checkpoint.sourceRecoveryPath);
	if (sourceRecovery === undefined || digest(sourceRecovery) !== checkpoint.sourceSha256) {
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			checkpoint,
			now,
			"migration source recovery bytes are missing or do not match the checkpoint",
			undefined,
			undefined,
			checkpoint.sourceRecoveryPath,
		);
	}
	let recovered: { readonly conversion: ConversionResult; readonly destinationBytes: Buffer };
	try {
		recovered = recoverConversion(sourceRecovery, adminPrincipalId, now);
	} catch (error) {
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			checkpoint,
			now,
			errorMessage(error),
			undefined,
			undefined,
			checkpoint.sourceRecoveryPath,
		);
	}
	const { destinationBytes } = recovered;
	if (checkpoint.destinationSha256 !== digest(destinationBytes)) {
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			checkpoint,
			now,
			"migration checkpoint destination hash does not match recovered source conversion",
			undefined,
			undefined,
			checkpoint.sourceRecoveryPath,
		);
	}
	try {
		writeDurableFile(paths.destinationPath, destinationBytes);
	} catch (error) {
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			checkpoint,
			now,
			`cannot restore migration destination: ${errorMessage(error)}`,
			undefined,
			undefined,
			checkpoint.sourceRecoveryPath,
		);
	}
	return resultFromCheckpoint(checkpoint, paths, digest(destinationBytes));
}
function recoverCheckpointAfterDestination(
	sourcePath: string,
	adminPrincipalId: string,
	paths: MigrationPaths,
	manifest: RecoveryManifest,
	destinationSha256: string,
	now: MigrationClock,
): SessionAuthorityMigrationResult | undefined {
	if (manifest.status === "degraded")
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			undefined,
			now,
			"migration recovery manifest records a degraded write",
			undefined,
			destinationSha256,
			manifest.sourceRecoveryPath,
		);
	const sourceRecovery = readFileIfPresent(manifest.sourceRecoveryPath);
	if (sourceRecovery === undefined || digest(sourceRecovery) !== manifest.sourceSha256)
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			undefined,
			now,
			"migration source recovery bytes are missing or do not match the recovery manifest",
			undefined,
			destinationSha256,
			manifest.sourceRecoveryPath,
		);
	let recovered: { readonly conversion: ConversionResult; readonly destinationBytes: Buffer };
	try {
		recovered = recoverConversion(sourceRecovery, adminPrincipalId, now);
	} catch (error) {
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			undefined,
			now,
			`migration source recovery conversion failed: ${errorMessage(error)}`,
			undefined,
			manifest.sourceSha256,
			manifest.sourceRecoveryPath,
		);
	}
	const { conversion, destinationBytes } = recovered;
	const expectedDestinationSha256 = digest(destinationBytes);
	if (expectedDestinationSha256 !== destinationSha256)
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			undefined,
			now,
			"existing authority destination does not match recovered migration output",
			quarantineBytes(readFileSync(paths.destinationPath), paths.quarantineDirectory, destinationSha256),
			manifest.sourceSha256,
			manifest.sourceRecoveryPath,
		);
	let checkpoint: SessionAuthorityMigrationCheckpoint;
	try {
		checkpoint = writeCommittedCheckpoint(
			sourcePath,
			adminPrincipalId,
			paths,
			manifest.sourceRecoveryPath,
			manifest.sourceSha256,
			destinationSha256,
			conversion.items,
			now,
		);
	} catch (error) {
		return degradedResult(
			sourcePath,
			adminPrincipalId,
			paths,
			undefined,
			now,
			`cannot durably rebuild migration checkpoint: ${errorMessage(error)}`,
			undefined,
			manifest.sourceSha256,
			manifest.sourceRecoveryPath,
		);
	}
	try {
		writeManifest(paths.auditPath, {
			...manifest,
			expectedDestinationSha256: destinationSha256,
			status: "checkpointed",
			updatedAt: now(),
		});
	} catch {
		// The committed checkpoint is sufficient to resume safely; a later run may repair the audit marker.
	}
	return resultFromCheckpoint(checkpoint, paths);
}

function degradeInvalidScopedV2Source(
	sourcePath: string,
	adminPrincipalId: string,
	paths: MigrationPaths,
	sourceBytes: Buffer,
	sourceSha256: string,
	sourceRecoveryPath: string,
	now: MigrationClock,
): SessionAuthorityMigrationResult {
	const reason = "fully scoped v2 authority destination has unbound operation identity";
	const quarantinePath = quarantineBytes(sourceBytes, paths.quarantineDirectory, sourceSha256);
	const checkpoint = writeDegradedCheckpoint(
		sourcePath,
		adminPrincipalId,
		paths,
		sourceRecoveryPath,
		sourceSha256,
		[quarantinedDocumentItem(reason)],
		reason,
		now,
		quarantinePath,
	);
	try {
		writeManifest(paths.auditPath, {
			kind: RECOVERY_KIND,
			version: SESSION_AUTHORITY_MIGRATION_VERSION,
			sourcePath,
			sourceSha256,
			adminPrincipalId,
			sourceRecoveryPath,
			destinationPath: paths.destinationPath,
			status: "degraded",
			updatedAt: now(),
		});
	} catch {
		// The degraded checkpoint fences recovery even when an audit update cannot be persisted.
	}
	return resultFromCheckpoint(checkpoint, paths, sourceSha256, quarantinePath);
}
function commitScopedRuntimeDestination(
	sourcePath: string,
	adminPrincipalId: string,
	paths: MigrationPaths,
	document: {
		readonly mappings: readonly SessionAuthorityRecord[];
		readonly provisionalOperations?: readonly ProvisionalSessionOperation[];
	},
	sourceBytes: Buffer,
	now: MigrationClock,
): SessionAuthorityMigrationResult {
	const sourceSha256 = digest(sourceBytes);
	const sourceRecoveryPath = retainSourceBytes(sourceBytes, sourceSha256, sourcePath, adminPrincipalId, paths, now);
	if (paths.destinationPath !== sourcePath) {
		const existingDestination = readFileIfPresent(paths.destinationPath);
		if (existingDestination !== undefined && digest(existingDestination) !== sourceSha256) {
			return degradedResult(
				sourcePath,
				adminPrincipalId,
				paths,
				undefined,
				now,
				"existing authority destination does not match the scoped migration source",
				quarantineBytes(existingDestination, paths.quarantineDirectory, digest(existingDestination)),
				digest(existingDestination),
				sourceRecoveryPath,
			);
		}
		try {
			writeDurableFile(paths.destinationPath, sourceBytes);
		} catch (error) {
			return degradedResult(
				sourcePath,
				adminPrincipalId,
				paths,
				undefined,
				now,
				`cannot durably write migrated authority: ${errorMessage(error)}`,
				undefined,
				sourceSha256,
				sourceRecoveryPath,
			);
		}
	}
	const checkpoint = writeCommittedCheckpoint(
		sourcePath,
		adminPrincipalId,
		paths,
		sourceRecoveryPath,
		sourceSha256,
		sourceSha256,
		scopedDestinationItems(document),
		now,
	);
	try {
		writeManifest(paths.auditPath, {
			kind: RECOVERY_KIND,
			version: SESSION_AUTHORITY_MIGRATION_VERSION,
			sourcePath,
			sourceSha256,
			adminPrincipalId,
			sourceRecoveryPath,
			destinationPath: paths.destinationPath,
			expectedDestinationSha256: sourceSha256,
			status: "checkpointed",
			updatedAt: now(),
		});
	} catch {
		// The committed checkpoint is sufficient to resume safely.
	}
	return resultFromCheckpoint(checkpoint, paths, sourceSha256);
}

function scopedDestinationItems(document: {
	readonly mappings: readonly SessionAuthorityRecord[];
	readonly provisionalOperations?: readonly ProvisionalSessionOperation[];
}): readonly SessionAuthorityMigrationItem[] {
	return [
		...document.mappings.map((record, index) => {
			const scope = record.observations?.[SESSION_MAPPING_SCOPE_OBSERVATION] as { chatId: string };
			return {
				identity: `mapping:${index}:${scope.chatId}`,
				sourceIndex: index,
				legacyChatId: scope.chatId,
				destinationChatId: record.chatId,
				status: "migrated" as const,
			};
		}),
		...(document.provisionalOperations ?? []).map((operation, index) => {
			const parsed = parseCanonicalChatId(operation.chatId);
			return {
				identity: `provisional:${index}:${parsed?.chatId ?? operation.chatId}`,
				sourceIndex: document.mappings.length + index,
				legacyChatId: parsed?.chatId ?? operation.chatId,
				destinationChatId: operation.chatId,
				status: "migrated" as const,
			};
		}),
	];
}
function assertScopedV2RecoverySource(value: unknown, adminPrincipalId: string): void {
	if (
		isV2AuthorityContainer(value) &&
		hasScopedV2MappingsForAdmin(value, adminPrincipalId) &&
		!isV2ContainerScopedForAdmin(value, adminPrincipalId)
	)
		throw new Error("fully scoped v2 authority recovery source has unbound operation identity");
}
function recoverConversion(
	sourceBytes: Buffer,
	adminPrincipalId: string,
	now: MigrationClock,
): { readonly conversion: ConversionResult; readonly destinationBytes: Buffer } {
	const parsed = parseJson(sourceBytes);
	if (!parsed.ok) throw new Error(`migration source recovery JSON is unreadable: ${parsed.error}`);
	assertScopedV2RecoverySource(parsed.value, adminPrincipalId);
	if (isV2AuthorityContainer(parsed.value) && isV2ContainerFullyScoped(parsed.value)) {
		const document = parsed.value as {
			readonly mappings: readonly SessionAuthorityRecord[];
			readonly provisionalOperations?: readonly ProvisionalSessionOperation[];
		};
		return {
			conversion: {
				mappings: document.mappings,
				provisionalOperations: document.provisionalOperations ?? [],
				items: scopedDestinationItems(document),
			},
			destinationBytes: sourceBytes,
		};
	}
	const conversion = convertParsedAuthoritySource(parsed.value, adminPrincipalId, now);
	return { conversion, destinationBytes: destinationBytesForConversion(conversion) };
}
function destinationBytesForConversion(conversion: ConversionResult): Buffer {
	return Buffer.from(
		`${JSON.stringify(
			{
				kind: "openwebui-gjc-session-authority",
				version: SESSION_AUTHORITY_VERSION,
				mappings: conversion.mappings,
				provisionalOperations: conversion.provisionalOperations,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}
function convertParsedAuthoritySource(value: unknown, adminPrincipalId: string, now: MigrationClock): ConversionResult {
	if (isV2AuthorityContainer(value)) return normalizeV2AuthorityDocument(value, adminPrincipalId, now);
	const legacy = parseLegacyDocument(value);
	if (legacy === undefined)
		throw new Error("authority source is neither a supported legacy document nor a v2 authority");
	return convertLegacy(legacy, adminPrincipalId, now);
}
function convertLegacy(document: LegacyDocument, adminPrincipalId: string, now: MigrationClock): ConversionResult {
	const converted: SessionAuthorityRecord[] = [];
	const provisionalOperations: ProvisionalSessionOperation[] = [];
	const items: SessionAuthorityMigrationItem[] = [];
	const knownChats = new Map<string, SessionAuthorityRecord>();
	for (const [index, item] of document.mappings.entries()) {
		try {
			const migrated = convertRecord(item, adminPrincipalId, now);
			if (knownChats.has(migrated.legacyChatId))
				throw new Error(`ambiguous duplicate legacy chat ID ${migrated.legacyChatId}`);
			knownChats.set(migrated.legacyChatId, migrated.record);
			converted.push(migrated.record);
			items.push({
				identity: `mapping:${index}:${migrated.legacyChatId}`,
				sourceIndex: index,
				legacyChatId: migrated.legacyChatId,
				destinationChatId: migrated.record.chatId,
				status: "migrated",
			});
		} catch (error) {
			throw new Error(`legacy mapping ${index} is malformed or ambiguous: ${errorMessage(error)}`);
		}
	}
	for (const [index, item] of document.provisionalOperations.entries()) {
		try {
			const migrated = convertProvisional(item, adminPrincipalId, knownChats);
			provisionalOperations.push(migrated.operation);
			items.push({
				identity: `provisional:${index}:${migrated.chatId}`,
				sourceIndex: document.mappings.length + index,
				legacyChatId: migrated.legacyChatId,
				destinationChatId: migrated.chatId,
				status: "migrated",
			});
		} catch (error) {
			const legacyChatId = isObject(item) && typeof item.chatId === "string" ? item.chatId : undefined;
			items.push({
				identity: `provisional:${index}:${legacyChatId ?? "unknown"}`,
				sourceIndex: document.mappings.length + index,
				...(legacyChatId === undefined ? {} : { legacyChatId }),
				status: "quarantined",
				reason: `legacy provisional operation is malformed or references an unknown mapping: ${errorMessage(error)}`,
			});
		}
	}
	if (
		!converted.every(isV2Record) ||
		!provisionalOperations.every(isProvisionalOperation) ||
		!isAuthorityDocumentRelationallyValid(converted, provisionalOperations)
	)
		throw new Error("converted authority records fail relational validation");
	return { mappings: converted, provisionalOperations, items };
}
function normalizeV2AuthorityDocument(
	document: {
		readonly mappings: readonly unknown[];
		readonly provisionalOperations?: unknown;
	},
	adminPrincipalId: string,
	now: MigrationClock,
): ConversionResult {
	const candidates = new Map<
		string,
		{
			record: SessionAuthorityRecord;
			readonly legacyChatId: string;
			readonly sourceIndex: number;
			readonly itemIndex: number;
			item: SessionAuthorityMigrationItem;
		}
	>();
	const sourceChatIds = new Map<string, string>();
	const mappingItems: SessionAuthorityMigrationItem[] = [];

	for (const [index, sourceRecord] of document.mappings.entries()) {
		let originalChatId: string;
		let legacyChatId: string;
		let converted: ConvertedRecord;
		let preservedScopedRecord = false;
		if (!isV2Record(sourceRecord)) {
			const source = isObject(sourceRecord) ? sourceRecord : undefined;
			if (source?.principalId !== undefined && source.principalId !== adminPrincipalId)
				throw new Error("v2 mapping principal does not match configured admin");
			const rawChatId = typeof source?.chatId === "string" ? source.chatId : undefined;
			if (source === undefined || rawChatId === undefined || parseCanonicalChatId(rawChatId) !== undefined) {
				mappingItems.push({
					identity: `mapping:${index}:${rawChatId ?? "unknown"}`,
					sourceIndex: index,
					...(rawChatId === undefined ? {} : { legacyChatId: rawChatId }),
					status: "quarantined",
					reason: "v2 mapping is malformed",
				});
				continue;
			}
			try {
				converted = convertRecord(source, adminPrincipalId, now);
			} catch {
				mappingItems.push({
					identity: `mapping:${index}:${rawChatId}`,
					sourceIndex: index,
					legacyChatId: rawChatId,
					status: "quarantined",
					reason: "v2 mapping is malformed",
				});
				continue;
			}
			originalChatId = rawChatId;
			legacyChatId = converted.legacyChatId;
		} else {
			originalChatId = sourceRecord.chatId;
			const scope = sourceRecord.observations?.[SESSION_MAPPING_SCOPE_OBSERVATION];
			const source = sourceRecord as unknown as Record<string, unknown>;
			if (
				isObject(scope) &&
				typeof scope.principalId === "string" &&
				scope.principalId.length > 0 &&
				typeof scope.chatId === "string" &&
				scope.chatId.length > 0 &&
				(source.principalId === undefined || source.principalId === scope.principalId) &&
				canonicalChatId(scope.principalId, scope.chatId) === sourceRecord.chatId
			) {
				legacyChatId = scope.chatId;
				converted = { record: sourceRecord, legacyChatId };
				preservedScopedRecord = true;
			} else {
				legacyChatId = v2LegacyChatId(sourceRecord, adminPrincipalId);
				converted = convertRecord(
					{ ...cloneObject(sourceRecord as unknown as Record<string, unknown>), chatId: legacyChatId },
					adminPrincipalId,
					now,
				);
			}
		}
		registerV2SourceChatId(sourceChatIds, originalChatId, converted.record.chatId);
		registerV2SourceChatId(sourceChatIds, legacyChatId, converted.record.chatId);
		registerV2SourceChatId(sourceChatIds, converted.record.chatId, converted.record.chatId);
		const item: SessionAuthorityMigrationItem = {
			identity: `mapping:${index}:${legacyChatId}`,
			sourceIndex: index,
			legacyChatId,
			destinationChatId: converted.record.chatId,
			status: preservedScopedRecord ? "skipped" : "migrated",
		};
		const itemIndex = mappingItems.length;
		mappingItems.push(item);
		const prior = candidates.get(converted.record.chatId);
		if (prior === undefined) {
			candidates.set(converted.record.chatId, {
				record: converted.record,
				legacyChatId,
				sourceIndex: index,
				itemIndex,
				item,
			});
			continue;
		}
		if (
			prior.record.projectId !== converted.record.projectId ||
			prior.record.sessionId !== converted.record.sessionId
		)
			throw new Error(
				`v2 mappings ${prior.sourceIndex} and ${index} collide for ${legacyChatId} with incompatible project or session identity`,
			);
		const keepIncoming = converted.record.createdAt >= prior.record.createdAt;
		const preferred = keepIncoming ? converted.record : prior.record;
		const secondary = keepIncoming ? prior.record : converted.record;
		const mergedRecord = duplicateAuthorityRecordsAreEquivalent(preferred, secondary)
			? preferred
			: reconcileMigrationOwnedDuplicateHistory(preferred, secondary);
		if (mergedRecord === undefined)
			throw new Error(
				`v2 mappings ${prior.sourceIndex} and ${index} collide for ${legacyChatId} with divergent authority history`,
			);
		const discarded = keepIncoming
			? prior
			: { record: converted.record, legacyChatId, sourceIndex: index, itemIndex, item };
		const quarantinedItem: SessionAuthorityMigrationItem = {
			...discarded.item,
			status: "quarantined",
			reason: "duplicate v2 mapping with equivalent or migration-owned historical authority was deduplicated",
		};
		discarded.item = quarantinedItem;
		mappingItems[discarded.itemIndex] = quarantinedItem;
		if (keepIncoming)
			candidates.set(converted.record.chatId, {
				record: mergedRecord,
				legacyChatId,
				sourceIndex: index,
				itemIndex,
				item,
			});
		else prior.record = mergedRecord;
	}
	function duplicateAuthorityRecordsAreEquivalent(
		left: SessionAuthorityRecord,
		right: SessionAuthorityRecord,
	): boolean {
		return (
			JSON.stringify(left.journal ?? []) === JSON.stringify(right.journal ?? []) &&
			JSON.stringify(left.reassignment) === JSON.stringify(right.reassignment)
		);
	}
	function reconcileMigrationOwnedDuplicateHistory(
		preferred: SessionAuthorityRecord,
		secondary: SessionAuthorityRecord,
	): SessionAuthorityRecord | undefined {
		if (
			JSON.stringify(preferred.reassignment) !== JSON.stringify(secondary.reassignment) ||
			![...(preferred.journal ?? []), ...(secondary.journal ?? [])].every(isMigrationHistoricalOperation)
		)
			return undefined;
		const operations = new Map<string, SessionOperation>();
		for (const operation of [...(preferred.journal ?? []), ...(secondary.journal ?? [])]) {
			const priorOperation = operations.get(operation.id);
			if (priorOperation === undefined || JSON.stringify(priorOperation) === JSON.stringify(operation)) {
				operations.set(operation.id, operation);
				continue;
			}
			const renamed = renameMigrationHistoricalOperation(operation);
			if (operations.has(renamed.id)) return undefined;
			operations.set(renamed.id, renamed);
		}
		return { ...preferred, journal: [...operations.values()] };
	}
	function isMigrationHistoricalOperation(operation: SessionOperation): boolean {
		return (
			operation.kind === "prompt" &&
			operation.state === "complete" &&
			operation.result === undefined &&
			operation.acknowledgedSuccessor === undefined &&
			operation.ingressId === operation.id &&
			/^historical-import(?::migration-[a-f0-9]{16})?$/u.test(operation.id)
		);
	}
	function renameMigrationHistoricalOperation(operation: SessionOperation): SessionOperation {
		const id = `historical-import:migration-${digest(Buffer.from(JSON.stringify(operation), "utf8")).slice(0, 16)}`;
		return { ...operation, id, ingressId: id };
	}

	const provisionalOperations: ProvisionalSessionOperation[] = [];
	const provisionalItems: SessionAuthorityMigrationItem[] = [];
	if (document.provisionalOperations !== undefined && !Array.isArray(document.provisionalOperations)) {
		provisionalItems.push({
			identity: "provisional:collection",
			sourceIndex: document.mappings.length,
			status: "quarantined",
			reason: "v2 provisional operation collection is malformed",
		});
	}
	for (const [index, sourceOperation] of (Array.isArray(document.provisionalOperations)
		? document.provisionalOperations
		: []
	).entries()) {
		const sourceChatId =
			isObject(sourceOperation) && typeof sourceOperation.chatId === "string" ? sourceOperation.chatId : undefined;
		if (sourceChatId === undefined) {
			provisionalItems.push({
				identity: `provisional:${index}:unknown`,
				sourceIndex: document.mappings.length + index,
				status: "quarantined",
				reason: "v2 provisional operation is malformed",
			});
			continue;
		}
		const destinationChatId = sourceChatIds.get(sourceChatId);
		if (destinationChatId === undefined) {
			provisionalItems.push({
				identity: `provisional:${index}:${sourceChatId}`,
				sourceIndex: document.mappings.length + index,
				legacyChatId: sourceChatId,
				status: "quarantined",
				reason: "v2 provisional operation references an unknown normalized mapping",
			});
			continue;
		}
		try {
			const normalizedMapping = candidates.get(destinationChatId);
			if (normalizedMapping === undefined) throw new Error("operation normalized mapping is unavailable");
			const operationSource = cloneObject(sourceOperation as unknown as Record<string, unknown>);
			operationSource.chatId = destinationChatId;
			const operation = rewriteOperation(
				operationSource,
				normalizedMapping.legacyChatId,
				destinationChatId,
				normalizedMapping.record.projectId,
				normalizedMapping.record.sessionId,
				sourceChatIds,
			) as unknown as ProvisionalSessionOperation;
			if (!isProvisionalOperation(operation)) throw new Error("operation fields are not supported");
			provisionalOperations.push(operation);
			provisionalItems.push({
				identity: `provisional:${index}:${sourceChatId}`,
				sourceIndex: document.mappings.length + index,
				legacyChatId: sourceChatId,
				destinationChatId,
				status: "migrated",
			});
		} catch (error) {
			provisionalItems.push({
				identity: `provisional:${index}:${sourceChatId}`,
				sourceIndex: document.mappings.length + index,
				legacyChatId: sourceChatId,
				status: "quarantined",
				reason: `v2 provisional operation is malformed: ${errorMessage(error)}`,
			});
		}
	}

	const mappings = [...candidates.values()].map(candidate => candidate.record);
	if (
		!mappings.every(isV2Record) ||
		!provisionalOperations.every(isProvisionalOperation) ||
		!isAuthorityDocumentRelationallyValid(mappings, provisionalOperations)
	)
		throw new Error("normalized v2 authority records fail relational validation");
	return {
		mappings,
		provisionalOperations,
		items: mappingItems.concat(provisionalItems),
	};
}
function v2ProvisionalOperationEntries(value: unknown): readonly unknown[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}
function registerV2SourceChatId(aliases: Map<string, string>, sourceChatId: string, destinationChatId: string): void {
	const existing = aliases.get(sourceChatId);
	if (existing !== undefined && existing !== destinationChatId)
		throw new Error(`v2 source chat ID ${sourceChatId} resolves to multiple canonical mappings`);
	aliases.set(sourceChatId, destinationChatId);
}

function v2LegacyChatId(record: SessionAuthorityRecord, adminPrincipalId: string): string {
	const scope = record.observations?.[SESSION_MAPPING_SCOPE_OBSERVATION];
	if (scope !== undefined) {
		if (
			!isObject(scope) ||
			scope.principalId !== adminPrincipalId ||
			typeof scope.chatId !== "string" ||
			scope.chatId.length === 0 ||
			canonicalChatId(adminPrincipalId, scope.chatId) !== record.chatId
		)
			throw new Error("v2 mapping scope does not match configured admin principal");
		return scope.chatId;
	}
	const canonical = parseCanonicalChatId(record.chatId);
	if (canonical !== undefined) {
		if (canonical.principalId !== adminPrincipalId)
			throw new Error("unscoped canonical v2 mapping belongs to a different principal");
		return canonical.chatId;
	}
	return record.chatId;
}

function parseCanonicalChatId(value: string): { readonly principalId: string; readonly chatId: string } | undefined {
	try {
		const tuple: unknown = JSON.parse(value);
		if (Array.isArray(tuple) && tuple.length === 2 && typeof tuple[0] === "string" && typeof tuple[1] === "string")
			return { principalId: tuple[0], chatId: tuple[1] };
	} catch {
		// A raw legacy chat ID is not JSON tuple encoded.
	}
	return undefined;
}

interface ConvertedRecord {
	readonly record: SessionAuthorityRecord;
	readonly legacyChatId: string;
}

function convertRecord(value: unknown, adminPrincipalId: string, _now: MigrationClock): ConvertedRecord {
	if (!isObject(value)) throw new Error("record is not an object");
	const source = cloneObject(value);
	const legacyChatId = requireString(source.chatId, "chatId");
	if (source.principalId !== undefined && source.principalId !== adminPrincipalId)
		throw new Error(`record principal ${String(source.principalId)} does not match configured admin`);
	if (source.version !== undefined && source.version !== 1 && source.version !== SESSION_AUTHORITY_VERSION)
		throw new Error("record has an unknown authority version");
	const destinationChatId = canonicalChatId(adminPrincipalId, legacyChatId);
	const observations = scopeObservations(source.observations, adminPrincipalId, legacyChatId);
	if (source.journal !== undefined && !Array.isArray(source.journal)) throw new Error("record journal is malformed");
	const migrated: Record<string, unknown> = source;
	delete migrated.principalId;
	migrated.version = SESSION_AUTHORITY_VERSION;
	migrated.chatId = destinationChatId;
	migrated.createdAt = source.createdAt === undefined ? ZERO_TIME : source.createdAt;
	migrated.header = rewriteHeader(source.header, legacyChatId, destinationChatId, source.projectId, source.sessionId);
	migrated.observations = observations;
	migrated.journal = Array.isArray(source.journal)
		? source.journal.map(operation => rewriteOperation(operation, legacyChatId, destinationChatId, source.projectId))
		: [];
	if (source.reassignment !== undefined)
		migrated.reassignment = rewriteReassignment(source.reassignment, legacyChatId, destinationChatId);
	const record = migrated as unknown as SessionAuthorityRecord;
	if (!isV2Record(record)) throw new Error("record fields are not a supported authority mapping");
	return { record, legacyChatId };
}

interface ConvertedProvisional {
	readonly operation: ProvisionalSessionOperation;
	readonly chatId: string;
	readonly legacyChatId: string;
}

function convertProvisional(
	value: unknown,
	adminPrincipalId: string,
	knownChats: ReadonlyMap<string, SessionAuthorityRecord>,
): ConvertedProvisional {
	if (!isObject(value)) throw new Error("operation is not an object");
	const source = cloneObject(value);
	const legacyChatId = requireString(source.chatId, "chatId");
	const owner = knownChats.get(legacyChatId);
	const chatId = canonicalChatId(adminPrincipalId, legacyChatId);
	source.chatId = chatId;
	const operation = rewriteOperation(
		source,
		legacyChatId,
		chatId,
		owner?.projectId ?? source.projectId,
		owner?.sessionId,
	) as unknown as ProvisionalSessionOperation;
	if (!isProvisionalOperation(operation)) throw new Error("operation fields are not supported");
	return { operation, chatId, legacyChatId };
}

function rewriteOperation(
	value: unknown,
	legacyChatId: string,
	destinationChatId: string,
	ownerProjectId: unknown,
	ownerSessionId?: unknown,
	aliases?: ReadonlyMap<string, string>,
): Record<string, unknown> {
	if (!isObject(value)) throw new Error("nested operation is not an object");
	const operation = cloneObject(value);
	const operationId = requireString(operation.id, "operation id");
	const expectedProjectId = requireString(ownerProjectId, "projectId");
	const projectId = typeof operation.projectId === "string" ? operation.projectId : expectedProjectId;
	const ownerSession =
		ownerSessionId === undefined ? undefined : requireString(ownerSessionId, "owner mapping sessionId");
	const sessionId = typeof operation.sessionId === "string" ? operation.sessionId : undefined;
	if (
		(ownerSession !== undefined && projectId !== expectedProjectId) ||
		(ownerSession !== undefined && sessionId !== undefined && sessionId !== ownerSession)
	)
		throw new Error("provisional operation does not match its authority mapping");
	const expectedSessionId = sessionId ?? ownerSession;
	if (operation.result !== undefined) {
		if (!isObject(operation.result) || !isObject(operation.result.mapping))
			throw new Error("operation result mapping is malformed");
		const result = cloneObject(operation.result);
		const mapping = cloneObject(operation.result.mapping);
		mapping.chatId = resolveOperationChatId(mapping.chatId, legacyChatId, destinationChatId, aliases);
		if (
			mapping.projectId !== projectId ||
			(expectedSessionId !== undefined && mapping.sessionId !== expectedSessionId) ||
			mapping.operationId !== operationId
		)
			throw new Error("operation result mapping does not match its operation identity");
		result.mapping = mapping;
		if (result.correlation !== undefined) {
			if (!isObject(result.correlation)) throw new Error("operation result correlation is malformed");
			const correlation = cloneObject(result.correlation);
			if (correlation.chatId !== undefined)
				correlation.chatId = resolveOperationChatId(correlation.chatId, legacyChatId, destinationChatId, aliases);
			if (
				(correlation.projectId !== undefined && correlation.projectId !== projectId) ||
				(expectedSessionId !== undefined &&
					correlation.sessionId !== undefined &&
					correlation.sessionId !== expectedSessionId) ||
				(correlation.operationId !== undefined && correlation.operationId !== operationId)
			)
				throw new Error("operation result correlation does not match its operation identity");
			result.correlation = correlation;
		}
		operation.result = result;
	}
	return operation;
}

function resolveOperationChatId(
	value: unknown,
	legacyChatId: string,
	destinationChatId: string,
	aliases?: ReadonlyMap<string, string>,
): string {
	if (typeof value !== "string") throw new Error("operation result identity is malformed");
	const resolvedAlias = aliases?.get(value);
	if (resolvedAlias !== undefined) {
		if (resolvedAlias !== destinationChatId)
			throw new Error("operation result identity belongs to a different authority mapping");
		return destinationChatId;
	}
	if (value === legacyChatId || value === destinationChatId) return destinationChatId;
	const parsedValue = parseCanonicalChatId(value);
	const parsedDestination = parseCanonicalChatId(destinationChatId);
	if (
		parsedValue !== undefined &&
		parsedDestination !== undefined &&
		parsedValue.principalId === parsedDestination.principalId &&
		parsedValue.chatId === parsedDestination.chatId
	)
		return destinationChatId;
	throw new Error("operation result identity does not match its authority mapping");
}

function rewriteHeader(
	value: unknown,
	legacyChatId: string,
	destinationChatId: string,
	projectId: unknown,
	sessionId: unknown,
): Record<string, string> {
	if (value !== undefined) {
		if (!isObject(value) || Object.keys(value).some(key => !["chatId", "projectId", "sessionId"].includes(key)))
			throw new Error("record header is malformed");
		if (
			!matchesAuthorityChatId(value.chatId, legacyChatId, destinationChatId) ||
			value.projectId !== projectId ||
			value.sessionId !== sessionId
		)
			throw new Error("record header does not match its identity");
	}
	return {
		chatId: destinationChatId,
		projectId: requireString(projectId, "projectId"),
		sessionId: requireString(sessionId, "sessionId"),
	};
}
function matchesAuthorityChatId(value: unknown, legacyChatId: string, destinationChatId: string): boolean {
	if (value === legacyChatId || value === destinationChatId) return true;
	const parsedValue = typeof value === "string" ? parseCanonicalChatId(value) : undefined;
	const parsedDestination = parseCanonicalChatId(destinationChatId);
	return (
		parsedValue !== undefined &&
		parsedDestination !== undefined &&
		parsedValue.principalId === parsedDestination.principalId &&
		parsedValue.chatId === parsedDestination.chatId
	);
}

function rewriteReassignment(value: unknown, legacyChatId: string, destinationChatId: string): unknown {
	if (!isObject(value)) throw new Error("reassignment is malformed");
	const reassignment = cloneObject(value);
	if (reassignment.sourceTombstone !== undefined)
		reassignment.sourceTombstone = rewriteTombstone(reassignment.sourceTombstone, legacyChatId, destinationChatId);
	if (reassignment.priorTombstone !== undefined)
		reassignment.priorTombstone = rewriteTombstone(reassignment.priorTombstone, legacyChatId, destinationChatId);
	return reassignment;
}

function rewriteTombstone(value: unknown, legacyChatId: string, destinationChatId: string): unknown {
	if (!isObject(value)) throw new Error("reassignment tombstone is malformed");
	const tombstone = cloneObject(value);
	if (tombstone.chatId !== legacyChatId && tombstone.chatId !== destinationChatId)
		throw new Error("reassignment tombstone does not match its authority chat");
	tombstone.chatId = destinationChatId;
	tombstone.header = rewriteHeader(
		tombstone.header,
		legacyChatId,
		destinationChatId,
		tombstone.projectId,
		tombstone.sessionId,
	);
	if (!Array.isArray(tombstone.journal)) throw new Error("reassignment tombstone journal is malformed");
	tombstone.journal = tombstone.journal.map(operation =>
		rewriteOperation(operation, legacyChatId, destinationChatId, tombstone.projectId),
	);
	if (tombstone.prior !== undefined)
		tombstone.prior = rewriteTombstone(tombstone.prior, legacyChatId, destinationChatId);
	return tombstone;
}

function scopeObservations(value: unknown, adminPrincipalId: string, legacyChatId: string): Record<string, unknown> {
	if (value === undefined)
		return { [SESSION_MAPPING_SCOPE_OBSERVATION]: { principalId: adminPrincipalId, chatId: legacyChatId } };
	if (!isObject(value)) throw new Error("record observations are malformed");
	const observations = cloneObject(value);
	const prior = observations[SESSION_MAPPING_SCOPE_OBSERVATION];
	if (prior !== undefined) {
		if (
			!isObject(prior) ||
			prior.principalId !== adminPrincipalId ||
			(prior.chatId !== undefined && prior.chatId !== legacyChatId)
		)
			throw new Error("record scope metadata is ambiguous");
	}
	observations[SESSION_MAPPING_SCOPE_OBSERVATION] = { principalId: adminPrincipalId, chatId: legacyChatId };
	return observations;
}

function parseLegacyDocument(value: unknown): LegacyDocument | undefined {
	if (Array.isArray(value)) return { mappings: value, provisionalOperations: [] };
	if (!isObject(value)) return undefined;
	const legacyShape =
		isLegacyMappingDocument(value) ||
		(value.version === 1 &&
			(value.kind === undefined || value.kind === "openwebui-gjc-session-authority") &&
			Array.isArray(value.mappings)) ||
		(value.kind === "openwebui-gjc-session-authority" &&
			value.version === SESSION_AUTHORITY_VERSION &&
			Array.isArray(value.mappings) &&
			value.mappings.every(item => !hasScopeMetadata(item)));
	if (!legacyShape) return undefined;
	if (
		Object.keys(value).some(
			key => !["kind", "version", "generation", "mappings", "provisionalOperations"].includes(key),
		)
	)
		return undefined;
	if (!Array.isArray(value.mappings)) return undefined;
	if (value.provisionalOperations !== undefined && !Array.isArray(value.provisionalOperations)) return undefined;
	return { mappings: value.mappings, provisionalOperations: value.provisionalOperations ?? [] };
}
function hasScopeMetadata(value: unknown): boolean {
	if (!isObject(value) || value.observations === undefined) return false;
	if (!isObject(value.observations)) return true;
	return Object.hasOwn(value.observations, SESSION_MAPPING_SCOPE_OBSERVATION);
}

function isAuthorityDocument(value: unknown): value is {
	readonly kind: string;
	readonly version: number;
	readonly mappings: readonly SessionAuthorityRecord[];
	readonly provisionalOperations?: readonly ProvisionalSessionOperation[];
} {
	if (!isObject(value)) return false;
	return (
		value.kind === "openwebui-gjc-session-authority" &&
		value.version === SESSION_AUTHORITY_VERSION &&
		Object.keys(value).every(key =>
			["kind", "version", "generation", "mappings", "provisionalOperations"].includes(key),
		) &&
		(value.generation === undefined || (typeof value.generation === "string" && value.generation.length > 0)) &&
		Array.isArray(value.mappings) &&
		value.mappings.every(isV2Record) &&
		(value.provisionalOperations === undefined ||
			(Array.isArray(value.provisionalOperations) && value.provisionalOperations.every(isProvisionalOperation))) &&
		isAuthorityDocumentRelationallyValid(value.mappings, value.provisionalOperations ?? [])
	);
}
function isV2AuthorityContainer(value: unknown): value is {
	readonly kind: string;
	readonly version: number;
	readonly mappings: readonly unknown[];
	readonly provisionalOperations?: unknown;
} {
	return (
		isObject(value) &&
		value.kind === "openwebui-gjc-session-authority" &&
		value.version === SESSION_AUTHORITY_VERSION &&
		Object.keys(value).every(key =>
			["kind", "version", "generation", "mappings", "provisionalOperations"].includes(key),
		) &&
		(value.generation === undefined || (typeof value.generation === "string" && value.generation.length > 0)) &&
		Array.isArray(value.mappings)
	);
}
function isAuthorityDocumentScoped(document: { readonly mappings: readonly SessionAuthorityRecord[] }): boolean {
	return document.mappings.every(record => {
		const source = record as unknown as Record<string, unknown>;
		const scope = record.observations?.[SESSION_MAPPING_SCOPE_OBSERVATION];
		return (
			isObject(scope) &&
			typeof scope.principalId === "string" &&
			scope.principalId.length > 0 &&
			typeof scope.chatId === "string" &&
			scope.chatId.length > 0 &&
			(source.principalId === undefined || source.principalId === scope.principalId) &&
			canonicalChatId(scope.principalId, scope.chatId) === record.chatId
		);
	});
}
function hasScopedV2Mappings(document: { readonly mappings: readonly unknown[] }): boolean {
	return (
		document.mappings.every(isV2Record) &&
		isAuthorityDocumentScoped(document as { readonly mappings: readonly SessionAuthorityRecord[] })
	);
}
function isV2ContainerFullyScoped(document: {
	readonly mappings: readonly unknown[];
	readonly provisionalOperations?: unknown;
}): boolean {
	if (!hasScopedV2Mappings(document) || !isAuthorityDocument(document)) return false;
	return hasBoundProvisionalOperationResults(
		document.provisionalOperations ?? [],
		document.mappings as readonly SessionAuthorityRecord[],
	);
}
function isAuthorityDocumentScopedForAdmin(
	document: {
		readonly mappings: readonly SessionAuthorityRecord[];
	},
	adminPrincipalId: string,
): boolean {
	return (
		isAuthorityDocumentScoped(document) &&
		document.mappings.every(record => {
			const scope = record.observations?.[SESSION_MAPPING_SCOPE_OBSERVATION] as
				| { readonly principalId?: unknown }
				| undefined;
			return scope?.principalId === adminPrincipalId;
		})
	);
}
function hasScopedV2MappingsForAdmin(
	document: { readonly mappings: readonly unknown[] },
	adminPrincipalId: string,
): boolean {
	return (
		hasScopedV2Mappings(document) &&
		isAuthorityDocumentScopedForAdmin(
			document as { readonly mappings: readonly SessionAuthorityRecord[] },
			adminPrincipalId,
		)
	);
}
function isV2ContainerScopedForAdmin(
	document: { readonly mappings: readonly unknown[]; readonly provisionalOperations?: unknown },
	adminPrincipalId: string,
): boolean {
	return isV2ContainerFullyScoped(document) && hasScopedV2MappingsForAdmin(document, adminPrincipalId);
}
function hasBoundProvisionalOperationResults(
	operations: readonly ProvisionalSessionOperation[],
	mappings: readonly SessionAuthorityRecord[],
): boolean {
	const mappingByChatId = new Map(mappings.map(mapping => [mapping.chatId, mapping]));
	return operations.every(operation => {
		const owner = mappingByChatId.get(operation.chatId);
		if (owner === undefined) return operation.state === "uncertain" && operation.result === undefined;
		if (
			operation.projectId !== owner.projectId ||
			(operation.sessionId !== undefined && operation.sessionId !== owner.sessionId)
		)
			return false;
		if (operation.result === undefined) return true;
		const expectedSessionId = owner.sessionId;
		const mapping = operation.result.mapping;
		if (
			mapping.chatId !== operation.chatId ||
			mapping.projectId !== operation.projectId ||
			mapping.sessionId !== expectedSessionId ||
			mapping.operationId !== operation.id
		)
			return false;
		const correlation = operation.result.correlation;
		return (
			correlation === undefined ||
			((correlation.chatId === undefined || correlation.chatId === operation.chatId) &&
				(correlation.projectId === undefined || correlation.projectId === operation.projectId) &&
				(correlation.sessionId === undefined || correlation.sessionId === expectedSessionId) &&
				(correlation.operationId === undefined || correlation.operationId === operation.id))
		);
	});
}

function checkpointMatchesRequest(
	checkpoint: SessionAuthorityMigrationCheckpoint,
	sourcePath: string,
	adminPrincipalId: string,
	paths: MigrationPaths,
): boolean {
	return (
		checkpoint.sourcePath === sourcePath &&
		checkpoint.destinationPath === paths.destinationPath &&
		checkpoint.adminPrincipalId === adminPrincipalId &&
		resolve(checkpoint.sourceRecoveryPath).startsWith(`${paths.recoveryPath}/`)
	);
}

function manifestMatchesRequest(
	manifest: RecoveryManifest,
	sourcePath: string,
	adminPrincipalId: string,
	paths: MigrationPaths,
): boolean {
	return (
		manifest.sourcePath === sourcePath &&
		manifest.destinationPath === paths.destinationPath &&
		manifest.adminPrincipalId === adminPrincipalId &&
		resolve(manifest.sourceRecoveryPath).startsWith(`${paths.recoveryPath}/`)
	);
}
function invalidManifestReason(
	manifest: RecoveryManifest,
	sourcePath: string,
	adminPrincipalId: string,
	paths: MigrationPaths,
): string | undefined {
	if (!manifestMatchesRequest(manifest, sourcePath, adminPrincipalId, paths))
		return "migration recovery manifest belongs to a different source or principal";
	if (manifest.status === "degraded") return "migration recovery manifest records a degraded migration";
	let sourceRecovery: Buffer | undefined;
	try {
		sourceRecovery = readFileIfPresent(manifest.sourceRecoveryPath);
	} catch {
		return "migration source recovery bytes cannot be read";
	}
	if (sourceRecovery === undefined || digest(sourceRecovery) !== manifest.sourceSha256)
		return "migration source recovery bytes are missing or do not match the recovery manifest";
	return undefined;
}

function canRetryOrphanedProvisionalCheckpoint(
	checkpoint: SessionAuthorityMigrationCheckpoint,
	sourceBytes: Buffer | undefined,
): boolean {
	if (
		sourceBytes === undefined ||
		checkpoint.reason === undefined ||
		!RETRYABLE_ORPHANED_PROVISIONAL_REASON.test(checkpoint.reason)
	) {
		return false;
	}
	const sourceRecovery = readFileIfPresent(checkpoint.sourceRecoveryPath);
	return (
		sourceRecovery !== undefined &&
		digest(sourceRecovery) === checkpoint.sourceSha256 &&
		sourceRecovery.equals(sourceBytes)
	);
}
function canRetryV2NormalizationCheckpoint(
	checkpoint: SessionAuthorityMigrationCheckpoint,
	sourceBytes: Buffer | undefined,
): boolean {
	if (sourceBytes === undefined) return false;
	const sourceRecovery = readFileIfPresent(checkpoint.sourceRecoveryPath);
	if (
		sourceRecovery === undefined ||
		digest(sourceRecovery) !== checkpoint.sourceSha256 ||
		!sourceRecovery.equals(sourceBytes)
	)
		return false;
	const parsed = parseJson(sourceBytes);
	return parsed.ok && isV2AuthorityContainer(parsed.value);
}
function readCheckpoint(path: string): ParsedCheckpoint {
	if (!existsSync(path)) return {};
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch (error) {
		return { invalid: `cannot read checkpoint: ${errorMessage(error)}` };
	}
	const parsed = parseJson(bytes);
	if (!parsed.ok) return { invalid: parsed.error };
	if (!isCheckpoint(parsed.value)) return { invalid: "checkpoint shape is invalid" };
	return { value: parsed.value };
}

function isCheckpoint(value: unknown): value is SessionAuthorityMigrationCheckpoint {
	if (!isObject(value)) return false;
	if (
		value.kind !== MIGRATION_KIND ||
		value.version !== SESSION_AUTHORITY_MIGRATION_VERSION ||
		typeof value.sourcePath !== "string" ||
		typeof value.sourceSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.sourceSha256) ||
		typeof value.adminPrincipalId !== "string" ||
		typeof value.sourceRecoveryPath !== "string" ||
		typeof value.destinationPath !== "string" ||
		(value.destinationSha256 !== undefined &&
			(typeof value.destinationSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.destinationSha256))) ||
		(value.status === "committed" && value.destinationSha256 === undefined) ||
		!(["committed", "degraded", "not_needed"] as readonly unknown[]).includes(value.status) ||
		!Array.isArray(value.items) ||
		!isCounts(value.counts) ||
		typeof value.updatedAt !== "string"
	)
		return false;
	if (!value.items.every(isMigrationItem)) return false;
	const identities = new Set(value.items.map(item => item.identity));
	return (
		identities.size === value.items.length && JSON.stringify(countsFor(value.items)) === JSON.stringify(value.counts)
	);
}

function isMigrationItem(value: unknown): value is SessionAuthorityMigrationItem {
	return (
		isObject(value) &&
		typeof value.identity === "string" &&
		typeof value.sourceIndex === "number" &&
		Number.isSafeInteger(value.sourceIndex) &&
		value.sourceIndex >= 0 &&
		(value.legacyChatId === undefined || typeof value.legacyChatId === "string") &&
		(value.destinationChatId === undefined || typeof value.destinationChatId === "string") &&
		(["migrated", "quarantined", "skipped"] as readonly unknown[]).includes(value.status) &&
		(value.reason === undefined || typeof value.reason === "string")
	);
}

function isCounts(value: unknown): value is SessionAuthorityMigrationCounts {
	return (
		isObject(value) &&
		["total", "migrated", "quarantined", "skipped"].every(key => {
			const count = value[key];
			return typeof count === "number" && Number.isSafeInteger(count) && count >= 0;
		})
	);
}

function readManifest(path: string): ParsedManifest {
	if (!existsSync(path)) return { status: "missing" };
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch (error) {
		return { status: "invalid", reason: `cannot read manifest: ${errorMessage(error)}` };
	}
	const parsed = parseJson(bytes);
	if (!parsed.ok) return { status: "invalid", reason: `cannot parse manifest: ${parsed.error}` };
	if (!isObject(parsed.value)) return { status: "invalid", reason: "manifest shape is invalid" };
	const value = parsed.value;
	if (
		Object.keys(value).some(
			key =>
				!(
					[
						"kind",
						"version",
						"sourcePath",
						"sourceSha256",
						"adminPrincipalId",
						"sourceRecoveryPath",
						"destinationPath",
						"expectedDestinationSha256",
						"status",
						"updatedAt",
					] as readonly string[]
				).includes(key),
		) ||
		value.kind !== RECOVERY_KIND ||
		value.version !== SESSION_AUTHORITY_MIGRATION_VERSION ||
		typeof value.sourcePath !== "string" ||
		value.sourcePath.length === 0 ||
		typeof value.sourceSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.sourceSha256) ||
		typeof value.adminPrincipalId !== "string" ||
		value.adminPrincipalId.length === 0 ||
		typeof value.sourceRecoveryPath !== "string" ||
		value.sourceRecoveryPath.length === 0 ||
		typeof value.destinationPath !== "string" ||
		value.destinationPath.length === 0 ||
		(value.expectedDestinationSha256 !== undefined &&
			(typeof value.expectedDestinationSha256 !== "string" ||
				!/^[a-f0-9]{64}$/.test(value.expectedDestinationSha256))) ||
		((value.status === "destination-written" || value.status === "checkpointed") &&
			value.expectedDestinationSha256 === undefined) ||
		!(["source-retained", "destination-written", "checkpointed", "degraded"] as readonly unknown[]).includes(
			value.status,
		) ||
		typeof value.updatedAt !== "string" ||
		value.updatedAt.length === 0
	)
		return { status: "invalid", reason: "manifest shape is invalid" };
	return { status: "valid", value: value as unknown as RecoveryManifest };
}

function retainSourceBytes(
	bytes: Buffer,
	sourceSha256: string,
	sourcePath: string,
	adminPrincipalId: string,
	paths: MigrationPaths,
	now: MigrationClock,
): string {
	const sourceRecoveryPath = join(paths.recoveryPath, `source-${sourceSha256}.json`);
	if (existsSync(sourceRecoveryPath)) {
		const existing = readFileSync(sourceRecoveryPath);
		if (digest(existing) !== sourceSha256 || !existing.equals(bytes))
			throw new SessionAuthorityMigrationError("migration recovery source bytes changed unexpectedly");
	} else {
		writeDurableFile(sourceRecoveryPath, bytes);
	}
	const currentManifest = readManifest(paths.auditPath);
	if (currentManifest.status === "missing") {
		writeManifest(paths.auditPath, {
			kind: RECOVERY_KIND,
			version: SESSION_AUTHORITY_MIGRATION_VERSION,
			sourcePath,
			sourceSha256,
			adminPrincipalId,
			sourceRecoveryPath,
			destinationPath: paths.destinationPath,
			status: "source-retained",
			updatedAt: now(),
		});
	}
	return sourceRecoveryPath;
}

function writeCommittedCheckpoint(
	sourcePath: string,
	adminPrincipalId: string,
	paths: MigrationPaths,
	sourceRecoveryPath: string,
	sourceSha256: string,
	destinationSha256: string,
	items: readonly SessionAuthorityMigrationItem[],
	now: MigrationClock,
): SessionAuthorityMigrationCheckpoint {
	const checkpoint: SessionAuthorityMigrationCheckpoint = {
		kind: MIGRATION_KIND,
		version: SESSION_AUTHORITY_MIGRATION_VERSION,
		sourcePath,
		sourceSha256,
		adminPrincipalId,
		sourceRecoveryPath,
		destinationPath: paths.destinationPath,
		destinationSha256,
		status: "committed",
		items,
		counts: countsFor(items),
		updatedAt: now(),
		completedAt: now(),
	};
	writeDurableFile(paths.checkpointPath, Buffer.from(`${JSON.stringify(checkpoint, null, 2)}\n`, "utf8"));
	return checkpoint;
}

function writeDegradedCheckpoint(
	sourcePath: string,
	adminPrincipalId: string,
	paths: MigrationPaths,
	sourceRecoveryPath: string,
	sourceSha256: string,
	items: readonly SessionAuthorityMigrationItem[],
	reason: string,
	now: MigrationClock,
	quarantinePath?: string,
): SessionAuthorityMigrationCheckpoint {
	const checkpoint: SessionAuthorityMigrationCheckpoint = {
		kind: MIGRATION_KIND,
		version: SESSION_AUTHORITY_MIGRATION_VERSION,
		sourcePath,
		sourceSha256,
		adminPrincipalId,
		sourceRecoveryPath,
		destinationPath: paths.destinationPath,
		status: "degraded",
		items,
		counts: countsFor(items),
		updatedAt: now(),
		completedAt: now(),
		...(quarantinePath === undefined ? {} : { quarantinePath }),
		reason,
	};
	writeDurableFile(paths.checkpointPath, Buffer.from(`${JSON.stringify(checkpoint, null, 2)}\n`, "utf8"));
	return checkpoint;
}

function resultFromCheckpoint(
	checkpoint: SessionAuthorityMigrationCheckpoint,
	paths: MigrationPaths,
	_sourceSha256?: string,
	quarantinePath?: string,
): SessionAuthorityMigrationResult {
	return {
		status: checkpoint.status,
		sourcePath: checkpoint.sourcePath,
		sourceSha256: checkpoint.sourceSha256,
		sourceRecoveryPath: checkpoint.sourceRecoveryPath,
		originalSourcePath: checkpoint.sourceRecoveryPath,
		sourceBytesPath: checkpoint.sourceRecoveryPath,
		migrationRecoveryPath: paths.recoveryPath,
		recoveryPath: paths.recoveryPath,
		destinationPath: checkpoint.destinationPath,
		checkpointPath: paths.checkpointPath,
		auditPath: paths.auditPath,
		quarantinePath: quarantinePath ?? checkpoint.quarantinePath,
		checkpoint,
		counts: checkpoint.counts,
		reason: checkpoint.reason,
	};
}
function degradedForInvalidManifest(
	sourcePath: string,
	adminPrincipalId: string,
	paths: MigrationPaths,
	checkpoint: SessionAuthorityMigrationCheckpoint | undefined,
	sourceBytes: Buffer | undefined,
	sourceSha256: string | undefined,
	now: MigrationClock,
	reason: string,
): SessionAuthorityMigrationResult {
	let preservedSourceRecoveryPath = checkpoint?.sourceRecoveryPath;
	let preservedSourceSha256 = sourceSha256;
	if (sourceBytes !== undefined && sourceSha256 !== undefined) {
		preservedSourceRecoveryPath = retainSourceBytes(
			sourceBytes,
			sourceSha256,
			sourcePath,
			adminPrincipalId,
			paths,
			now,
		);
	} else if (preservedSourceRecoveryPath !== undefined && checkpoint !== undefined) {
		preservedSourceSha256 = checkpoint.sourceSha256;
		let recoveredSource: Buffer | undefined;
		try {
			recoveredSource = readFileIfPresent(preservedSourceRecoveryPath);
		} catch {
			recoveredSource = undefined;
		}
		if (recoveredSource !== undefined && digest(recoveredSource) === checkpoint.sourceSha256) {
			preservedSourceSha256 = checkpoint.sourceSha256;
			sourceBytes = recoveredSource;
		}
	}
	const quarantinePath =
		sourceBytes !== undefined && preservedSourceSha256 !== undefined
			? quarantineBytes(sourceBytes, paths.quarantineDirectory, preservedSourceSha256)
			: undefined;
	const items = [quarantinedDocumentItem(reason)];
	if (preservedSourceRecoveryPath !== undefined && preservedSourceSha256 !== undefined) {
		const degradedCheckpoint = writeDegradedCheckpoint(
			sourcePath,
			adminPrincipalId,
			paths,
			preservedSourceRecoveryPath,
			preservedSourceSha256,
			items,
			reason,
			now,
			quarantinePath,
		);
		return resultFromCheckpoint(degradedCheckpoint, paths, preservedSourceSha256, quarantinePath);
	}
	return degradedResult(
		sourcePath,
		adminPrincipalId,
		paths,
		undefined,
		now,
		reason,
		quarantinePath,
		preservedSourceSha256,
		preservedSourceRecoveryPath,
	);
}

function degradedWithoutCheckpoint(
	sourcePath: string,
	adminPrincipalId: string,
	paths: MigrationPaths,
	now: MigrationClock,
	reason: string,
): SessionAuthorityMigrationResult {
	const sourceBytes = readFileIfPresent(sourcePath);
	const sourceSha256 = sourceBytes === undefined ? undefined : digest(sourceBytes);
	let sourceRecoveryPath: string | undefined;
	let quarantinePath: string | undefined;
	if (sourceBytes !== undefined && sourceSha256 !== undefined) {
		sourceRecoveryPath = retainSourceBytes(sourceBytes, sourceSha256, sourcePath, adminPrincipalId, paths, now);
		quarantinePath = quarantineBytes(sourceBytes, paths.quarantineDirectory, sourceSha256);
	}
	return {
		status: "degraded",
		sourcePath,
		sourceSha256,
		sourceRecoveryPath,
		originalSourcePath: sourceRecoveryPath,
		sourceBytesPath: sourceRecoveryPath,
		migrationRecoveryPath: paths.recoveryPath,
		recoveryPath: paths.recoveryPath,
		destinationPath: paths.destinationPath,
		checkpointPath: paths.checkpointPath,
		auditPath: paths.auditPath,
		quarantinePath,
		counts: sourceBytes === undefined ? emptyCounts() : { total: 1, migrated: 0, quarantined: 1, skipped: 0 },
		reason,
	};
}

function degradedResult(
	sourcePath: string,
	adminPrincipalId: string,
	paths: MigrationPaths,
	checkpoint: SessionAuthorityMigrationCheckpoint | undefined,
	now: MigrationClock,
	reason: string,
	quarantinePath: string | undefined,
	sourceSha256: string | undefined,
	sourceRecoveryPath?: string,
): SessionAuthorityMigrationResult {
	if (sourceSha256 !== undefined && sourceRecoveryPath === undefined) {
		const bytes = readFileIfPresent(sourcePath);
		if (bytes !== undefined)
			sourceRecoveryPath = retainSourceBytes(bytes, sourceSha256, sourcePath, adminPrincipalId, paths, now);
	}
	return {
		status: "degraded",
		sourcePath,
		sourceSha256,
		sourceRecoveryPath,
		originalSourcePath: sourceRecoveryPath,
		sourceBytesPath: sourceRecoveryPath,
		migrationRecoveryPath: paths.recoveryPath,
		recoveryPath: paths.recoveryPath,
		destinationPath: paths.destinationPath,
		checkpointPath: paths.checkpointPath,
		auditPath: paths.auditPath,
		quarantinePath,
		checkpoint,
		counts: checkpoint?.counts ?? { total: 1, migrated: 0, quarantined: 1, skipped: 0 },
		reason,
	};
}

function notNeededResult(
	sourcePath: string,
	paths: MigrationPaths,
	sourceSha256?: string,
): SessionAuthorityMigrationResult {
	return {
		status: "not_needed",
		sourcePath,
		sourceSha256,
		migrationRecoveryPath: paths.recoveryPath,
		recoveryPath: paths.recoveryPath,
		destinationPath: paths.destinationPath,
		counts: emptyCounts(),
	};
}

function countsFor(items: readonly SessionAuthorityMigrationItem[]): SessionAuthorityMigrationCounts {
	return {
		total: items.length,
		migrated: items.filter(item => item.status === "migrated").length,
		quarantined: items.filter(item => item.status === "quarantined").length,
		skipped: items.filter(item => item.status === "skipped").length,
	};
}

function emptyCounts(): SessionAuthorityMigrationCounts {
	return { total: 0, migrated: 0, quarantined: 0, skipped: 0 };
}

function quarantinedDocumentItem(reason: string): SessionAuthorityMigrationItem {
	return { identity: "document", sourceIndex: 0, status: "quarantined", reason };
}

function quarantinedItem(value: unknown, sourceIndex: number, reason: string): SessionAuthorityMigrationItem {
	const legacyChatId = isObject(value) && typeof value.chatId === "string" ? value.chatId : undefined;
	return {
		identity: legacyChatId === undefined ? `mapping:${sourceIndex}` : `mapping:${sourceIndex}:${legacyChatId}`,
		sourceIndex,
		...(legacyChatId === undefined ? {} : { legacyChatId }),
		status: "quarantined",
		reason,
	};
}

function quarantineBytes(bytes: Buffer, directory: string, sourceSha256: string): string {
	const path = join(directory, `source-${sourceSha256}.json`);
	if (existsSync(path)) {
		if (digest(readFileSync(path)) !== sourceSha256)
			throw new SessionAuthorityMigrationError("quarantine bytes changed unexpectedly");
		return path;
	}
	writeDurableFile(path, bytes);
	return path;
}

function writeManifest(path: string, manifest: RecoveryManifest): void {
	writeDurableFile(path, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
}

function writeDurableFile(path: string, bytes: Buffer): void {
	mkdirSync(dirname(path), { recursive: true });
	if (existsSync(path)) {
		const existing = readFileSync(path);
		if (existing.equals(bytes)) return;
	}
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	let completed = false;
	try {
		writeFileSync(descriptor, bytes);
		fsyncSync(descriptor);
		completed = true;
	} finally {
		closeSync(descriptor);
		if (!completed) {
			try {
				unlinkSync(temporary);
			} catch {
				// A failed temporary write is recoverable on the next preflight.
			}
		}
	}
	renameSync(temporary, path);
	syncDirectory(dirname(path));
}

function syncDirectory(path: string): void {
	const descriptor = openSync(path, "r");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function migrationLockPaths(sourcePath: string, destinationPath: string, stateRoot: string): readonly string[] {
	const locks = new Map<string, string>();
	for (const authorityPath of [sourcePath, destinationPath]) {
		const lockPath = migrationLockPath(authorityPath, stateRoot);
		const priorPath = locks.get(lockPath);
		if (priorPath !== undefined && priorPath !== authorityPath)
			throw new Error(`migration lock path collision for ${priorPath} and ${authorityPath}`);
		locks.set(lockPath, authorityPath);
	}
	return [...locks.keys()].sort();
}

function migrationLockPath(authorityPath: string, stateRoot: string): string {
	return join(resolve(stateRoot), "session-authority-migration", "locks", `path-${digest(authorityPath)}`);
}

function migrationPaths(sourcePath: string, stateRoot: string, destinationPath: string): MigrationPaths {
	const sourceIdentity = digest(Buffer.from(sourcePath, "utf8")).slice(0, 24);
	const recoveryPath = join(
		resolve(stateRoot),
		"session-authority-migration",
		`${basename(sourcePath)}-${sourceIdentity}`,
	);
	return {
		destinationPath,
		recoveryPath,
		checkpointPath: join(recoveryPath, "checkpoint.json"),
		auditPath: join(recoveryPath, "audit.json"),
		quarantineDirectory: join(recoveryPath, "quarantine"),
	};
}

function canonicalChatId(adminPrincipalId: string, legacyChatId: string): string {
	return JSON.stringify([adminPrincipalId, legacyChatId]);
}

function readFileIfPresent(path: string): Buffer | undefined {
	return existsSync(path) ? readFileSync(path) : undefined;
}

function digest(value: Buffer | string): string {
	return createHash("sha256").update(value).digest("hex");
}

function cloneObject(value: Record<string, unknown>): Record<string, unknown> {
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${field} must be a non-empty string`);
	return value;
}

function requirePath(value: unknown, field: string): string {
	return resolve(requireString(value, field));
}

function requirePrincipal(value: unknown): string {
	return requireString(value, "adminPrincipalId");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type ParsedJson = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

function parseJson(bytes: Buffer): ParsedJson {
	try {
		return { ok: true, value: JSON.parse(bytes.toString("utf8")) };
	} catch (error) {
		return { ok: false, error: errorMessage(error) };
	}
}
