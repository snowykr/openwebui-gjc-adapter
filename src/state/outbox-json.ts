import { closeSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type CanonicalJsonValue =
	| null
	| boolean
	| number
	| string
	| readonly CanonicalJsonValue[]
	| { readonly [key: string]: CanonicalJsonValue };

export function buildProjectionPayloadHash(value: CanonicalJsonValue): string {
	// Stream the canonical serialization instead of materializing it as one
	// string: an oversized record-level event array must not allocate an
	// event-sized (or document-sized) canonical string. Pass 1 measures the
	// byte length (needed for the lineage hash prefix), pass 2 streams the
	// canonical bytes into the hash; the peak allocation is bounded by a single
	// leaf JSON string.
	const hasher = new Bun.CryptoHasher("sha256");
	let length = 0;
	streamCanonicalJson(value, chunk => {
		length += chunk.length;
	});
	hasher.update(`${length}:`);
	streamCanonicalJson(value, chunk => {
		hasher.update(chunk);
	});
	hasher.update(";");
	return hasher.digest("hex");
}

/** Emits the same canonical serialization as the previous `canonicalJson`
 * helper (sorted object keys, compact JSON), but chunk by chunk so the caller
 * never holds the whole serialization in memory at once. */
export function streamCanonicalJson(value: CanonicalJsonValue, emit: (chunk: string) => void): void {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		emit(JSON.stringify(value));
		return;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new Error("Projection payload hash requires finite numbers");
		}
		emit(JSON.stringify(value));
		return;
	}
	if (Array.isArray(value)) {
		emit("[");
		for (let index = 0; index < value.length; index += 1) {
			if (index > 0) emit(",");
			streamCanonicalJson(value[index]!, emit);
		}
		emit("]");
		return;
	}
	const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
	emit("{");
	for (let index = 0; index < entries.length; index += 1) {
		if (index > 0) emit(",");
		const [key, entry] = entries[index]!;
		emit(JSON.stringify(key));
		emit(":");
		streamCanonicalJson(entry, emit);
	}
	emit("}");
}

/** Emits the same escape sequence JSON.stringify uses for a string value's
 * interior (the fragment between the surrounding quotes): quotes, backslashes,
 * control characters, and lone surrogates are escaped; well-formed surrogate
 * pairs pass through verbatim. Peak allocation is bounded by the chunk buffer,
 * so a document-sized payload never materializes as one escaped string. */
export function streamEscapedJsonString(raw: string, emit: (chunk: string) => void): void {
	let buffer = "";
	const flush = () => {
		if (buffer.length > 0) {
			emit(buffer);
			buffer = "";
		}
	};
	for (let index = 0; index < raw.length; index += 1) {
		const code = raw.charCodeAt(index);
		switch (code) {
			case 0x22:
				buffer += '\\"';
				break;
			case 0x5c:
				buffer += "\\\\";
				break;
			case 0x08:
				buffer += "\\b";
				break;
			case 0x09:
				buffer += "\\t";
				break;
			case 0x0a:
				buffer += "\\n";
				break;
			case 0x0c:
				buffer += "\\f";
				break;
			case 0x0d:
				buffer += "\\r";
				break;
			default:
				if (code < 0x20) {
					buffer += `\\u${code.toString(16).padStart(4, "0")}`;
				} else if (code >= 0xd800 && code <= 0xdbff) {
					if (index + 1 < raw.length) {
						const next = raw.charCodeAt(index + 1);
						if (next >= 0xdc00 && next <= 0xdfff) {
							buffer += raw[index]!;
							buffer += raw[index + 1]!;
							index += 1;
						} else {
							buffer += `\\u${code.toString(16).padStart(4, "0")}`;
						}
					} else {
						// A terminal high surrogate is a lone surrogate: JSON.stringify
						// escapes it (\\ud800) instead of emitting the raw code unit,
						// which Bun would encode as the replacement character and
						// diverge from hashes stored by the previous implementation.
						buffer += `\\u${code.toString(16).padStart(4, "0")}`;
					}
				} else if (code >= 0xdc00 && code <= 0xdfff) {
					buffer += `\\u${code.toString(16).padStart(4, "0")}`;
				} else {
					buffer += raw[index]!;
				}
		}
		if (buffer.length >= 4096) flush();
	}
	flush();
}

/** Resolves a value the way JSON.stringify's SerializeJSONProperty does:
 * callable toJSON is invoked with the property key (the root uses ""), and
 * boxed Number/String/Boolean objects are unwrapped to their primitive
 * value. Non-object values pass through unchanged. Resolution happens at most
 * once per level, matching JSON.stringify (a toJSON result is serialized
 * directly without re-invoking its own toJSON). */
function resolveJsonValue(value: unknown, key: string): unknown {
	if (value !== null && typeof value === "object") {
		const toJSON = (value as { toJSON?: (k: string) => unknown }).toJSON;
		if (typeof toJSON === "function") return toJSON.call(value, key);
		if (value instanceof Number) return Number(value);
		if (value instanceof String) return String(value);
		if (value instanceof Boolean) return value.valueOf();
	}
	return value;
}

/** Emits an object's serialized head (the opening brace and every
 * "key":value entry, WITHOUT the closing brace) using the same
 * JSON.stringify semantics as streamPlainJson: toJSON is invoked per value
 * with its key, boxed primitives are unwrapped, undefined/function/symbol
 * values are skipped, and non-finite numbers become null. Values are emitted
 * incrementally, so an unbounded string field never materializes whole. The
 * caller appends the trailing "}" (plus any fields it interleaves). */
export function streamPlainObjectHead(value: Record<string, unknown>, emit: (chunk: string) => void): void {
	emit("{");
	let wrote = false;
	// Enumerate keys one at a time (for...in with an own-property check) instead
	// of Object.keys()/Object.entries(), which allocate and retain an array of
	// every key before any entry is emitted: a key-count-dominated oversized
	// payload must not incur document-proportional heap growth. Each value is
	// read and serialized immediately, preserving JSON.stringify()'s
	// per-property read-then-serialize order.
	const hasOwn = Object.prototype.hasOwnProperty;
	for (const key in value) {
		if (!hasOwn.call(value, key)) continue;
		const entry = resolveJsonValue(Reflect.get(value, key), key);
		if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
		if (wrote) emit(",");
		wrote = true;
		// A property name is unbounded like any other string; emit the quoted
		// and escaped key incrementally so a large key never materializes as an
		// additional string.
		emit('"');
		streamEscapedJsonString(key, emit);
		emit('"');
		emit(":");
		streamPlainJsonResolved(entry, emit);
	}
}

/** Emits the same serialization as JSON.stringify(value) (insertion-ordered
 * object keys, toJSON invoked with the property key, boxed primitives
 * unwrapped, undefined/function/symbol object values skipped, array holes and
 * NaN/Infinity as null), but chunk by chunk so the caller never holds the
 * whole serialization in memory at once. A value whose toJSON returns
 * undefined at the root emits "null" (JSON.stringify emits no output there;
 * projection payloads never hit that case). */
export function streamPlainJson(value: unknown, emit: (chunk: string) => void): void {
	streamPlainJsonResolved(resolveJsonValue(value, ""), emit);
}

/** Serializes an already-resolved value; see streamPlainJson. */
function streamPlainJsonResolved(value: unknown, emit: (chunk: string) => void): void {
	if (value === null) {
		emit("null");
		return;
	}
	if (typeof value === "string") {
		emit('"');
		streamEscapedJsonString(value, emit);
		emit('"');
		return;
	}
	if (typeof value === "number") {
		emit(Number.isFinite(value) ? JSON.stringify(value) : "null");
		return;
	}
	if (typeof value === "boolean") {
		emit(JSON.stringify(value));
		return;
	}
	if (typeof value === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
	if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
		emit("null");
		return;
	}
	if (Array.isArray(value)) {
		emit("[");
		for (let index = 0; index < value.length; index += 1) {
			if (index > 0) emit(",");
			const item = resolveJsonValue(value[index], String(index));
			if (item === undefined || typeof item === "function" || typeof item === "symbol") emit("null");
			else streamPlainJsonResolved(item, emit);
		}
		emit("]");
		return;
	}
	streamPlainObjectHead(value as Record<string, unknown>, emit);
	emit("}");
}

/** Hashes a canonical serialization produced by a caller-supplied streaming
 * emitter without ever materializing the whole serialization. Small payloads
 * stay in memory, avoiding filesystem work for ordinary startup records;
 * oversized payloads spill to a temporary file so a 1 GiB-class authority
 * cannot materialize a document-sized snapshot. The producer runs once, so
 * effectful JSON values are evaluated exactly once and the measured length
 * always describes the bytes that are hashed. */
export function hashCanonicalStream(produce: (emit: (chunk: string) => void) => void): string {
	const memoryThreshold = 64 * 1024;
	const memoryChunks: string[] = [];
	let memoryBytes = 0;
	let directory: string | undefined;
	let spoolPath: string | undefined;
	let descriptor: number | undefined;
	let length = 0;
	try {
		try {
			produce(chunk => {
				// The lineage prefix is the sum of chunk.length (UTF-16 code units,
				// matching the previous in-memory spool) so persisted hashes stay
				// byte-identical; the file stores the UTF-8 bytes for re-reading.
				length += chunk.length;
				const bytes = Buffer.byteLength(chunk, "utf8");
				if (descriptor === undefined && memoryBytes + bytes <= memoryThreshold) {
					memoryChunks.push(chunk);
					memoryBytes += bytes;
					return;
				}
				if (descriptor === undefined) {
					directory = mkdtempSync(join(tmpdir(), "gjc-hash-spool-"));
					spoolPath = join(directory, "spool");
					descriptor = openSync(spoolPath, "wx", 0o600);
					for (const memoryChunk of memoryChunks) writeSyncAll(descriptor, Buffer.from(memoryChunk, "utf8"));
					memoryChunks.length = 0;
				}
				writeSyncAll(descriptor, Buffer.from(chunk, "utf8"));
			});
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
		}
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(`${length}:`);
		if (spoolPath === undefined) {
			for (const chunk of memoryChunks) hasher.update(chunk);
		} else {
			const reader = openSync(spoolPath, "r");
			try {
				const buffer = Buffer.allocUnsafe(64 * 1024);
				for (;;) {
					const read = readSync(reader, buffer, 0, buffer.length, null);
					if (read <= 0) break;
					hasher.update(buffer.subarray(0, read));
				}
			} finally {
				closeSync(reader);
			}
		}
		hasher.update(";");
		return hasher.digest("hex");
	} finally {
		// Always remove the spool, including when the producer or a write
		// fails (e.g. /tmp fills while hashing an oversized mapping): a partial
		// file must not accumulate across repeated startup attempts.
		if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
	}
}

/**
 * Writes an entire buffer, looping over short writes (a filesystem quota or
 * other condition can return fewer bytes than requested). Ignoring the return
 * value would leave the spool shorter than the counted lineage length and the
 * digest would differ from the next startup's hash, rejecting a stored row.
 */
function writeSyncAll(descriptor: number, buffer: Buffer): void {
	let offset = 0;
	while (offset < buffer.length) {
		const written = writeSync(descriptor, buffer, offset, buffer.length - offset);
		if (written <= 0) throw new Error("Short write to the hash spool made no progress");
		offset += written;
	}
}
