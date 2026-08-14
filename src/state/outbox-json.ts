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
	for (const [key, entry0] of Object.entries(value)) {
		const entry = resolveJsonValue(entry0, key);
		if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
		if (wrote) emit(",");
		wrote = true;
		emit(JSON.stringify(key));
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
 * emitter without ever materializing the whole serialization: the producer
 * runs once into a compact byte spool, whose length is hashed as the lineage
 * prefix and whose bytes are then hashed directly. Snapshotting the emitted
 * bytes means effectful JSON values (a stateful toJSON or getter) are
 * evaluated exactly once, so the measured length always describes exactly the
 * bytes that are hashed; the later WAL JSON.stringify round trip can then
 * never disagree with the stored hash. The spool holds the serialization in
 * memory, so callers must bound it (projection payloads do), and its peak is
 * the serialization size rather than a per-pass re-evaluation. */
export function hashCanonicalStream(produce: (emit: (chunk: string) => void) => void): string {
	const chunks: string[] = [];
	produce(chunk => chunks.push(chunk));
	const hasher = new Bun.CryptoHasher("sha256");
	let length = 0;
	for (const chunk of chunks) length += chunk.length;
	hasher.update(`${length}:`);
	for (const chunk of chunks) hasher.update(chunk);
	hasher.update(";");
	return hasher.digest("hex");
}
