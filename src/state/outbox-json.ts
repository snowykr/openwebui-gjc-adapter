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
				} else if (code >= 0xd800 && code <= 0xdbff && index + 1 < raw.length) {
					const next = raw.charCodeAt(index + 1);
					if (next >= 0xdc00 && next <= 0xdfff) {
						buffer += raw[index]!;
						buffer += raw[index + 1]!;
						index += 1;
					} else {
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

/** Emits the same serialization as JSON.stringify(value) (insertion-ordered
 * object keys, undefined/function/symbol object values skipped, array holes
 * and NaN/Infinity as null), but chunk by chunk so the caller never holds the
 * whole serialization in memory at once. toJSON is intentionally not invoked;
 * payloads are plain OpenWebUI data. */
export function streamPlainJson(value: unknown, emit: (chunk: string) => void): void {
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
	if (typeof value === "number" || typeof value === "boolean") {
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
			const item = value[index];
			if (item === undefined || typeof item === "function" || typeof item === "symbol") emit("null");
			else streamPlainJson(item, emit);
		}
		emit("]");
		return;
	}
	emit("{");
	let wrote = false;
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (entry === undefined || typeof entry === "function" || typeof entry === "symbol") continue;
		if (wrote) emit(",");
		wrote = true;
		emit(JSON.stringify(key));
		emit(":");
		streamPlainJson(entry, emit);
	}
	emit("}");
}

/** Hashes a canonical serialization produced by a caller-supplied streaming
 * emitter without ever materializing the whole serialization: pass 1 measures
 * the byte length (the lineage hash prefix), pass 2 streams the bytes into the
 * hash. The emitter must be deterministic so both passes agree. */
export function hashCanonicalStream(produce: (emit: (chunk: string) => void) => void): string {
	const hasher = new Bun.CryptoHasher("sha256");
	let length = 0;
	produce(chunk => {
		length += chunk.length;
	});
	hasher.update(`${length}:`);
	produce(chunk => hasher.update(chunk));
	hasher.update(";");
	return hasher.digest("hex");
}
