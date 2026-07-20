import type { SessionEntry } from "@gajae-code/coding-agent";

export type SessionEntryGraphDiagnosticCode = "duplicate_entry_id" | "missing_parent";

export interface SessionEntryGraphDiagnostic {
	code: SessionEntryGraphDiagnosticCode;
	message: string;
	entryId: string;
	parentId?: string;
}

export interface SessionEntryGraphValidationResult {
	diagnostics: SessionEntryGraphDiagnostic[];
	entriesById: Map<string, SessionEntry>;
	childrenById: Map<string, string[]>;
	currentId: string | null;
}

export function validateSessionEntryGraph(entries: readonly SessionEntry[]): SessionEntryGraphValidationResult {
	const diagnostics: SessionEntryGraphDiagnostic[] = [];
	const entriesById = new Map<string, SessionEntry>();
	const childrenById = new Map<string, string[]>();

	for (const entry of entries) {
		if (entriesById.has(entry.id)) {
			diagnostics.push({
				code: "duplicate_entry_id",
				message: `Duplicate GJC session entry id: ${entry.id}`,
				entryId: entry.id,
			});
			continue;
		}
		entriesById.set(entry.id, entry);
		childrenById.set(entry.id, []);
	}

	for (const entry of entriesById.values()) {
		if (entry.parentId === null) continue;
		const siblings = childrenById.get(entry.parentId);
		if (siblings === undefined) {
			diagnostics.push({
				code: "missing_parent",
				message: `GJC session entry ${entry.id} references missing parent ${entry.parentId}`,
				entryId: entry.id,
				parentId: entry.parentId,
			});
			continue;
		}
		siblings.push(entry.id);
	}

	assertAcyclic(entriesById);
	return { diagnostics, entriesById, childrenById, currentId: findCurrentId(entriesById, childrenById) };
}

function assertAcyclic(entriesById: Map<string, SessionEntry>): void {
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (entry: SessionEntry): void => {
		if (visited.has(entry.id)) return;
		if (visiting.has(entry.id)) throw new Error(`GJC session entry parent cycle detected at ${entry.id}`);
		visiting.add(entry.id);
		if (entry.parentId !== null) {
			const parent = entriesById.get(entry.parentId);
			if (parent !== undefined) visit(parent);
		}
		visiting.delete(entry.id);
		visited.add(entry.id);
	};
	for (const entry of entriesById.values()) visit(entry);
}

function findCurrentId(entriesById: Map<string, SessionEntry>, childrenById: Map<string, string[]>): string | null {
	let currentId: string | null = null;
	for (const id of entriesById.keys()) {
		if ((childrenById.get(id) ?? []).length === 0) currentId = id;
	}
	return currentId;
}
