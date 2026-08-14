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
function streamCanonicalJson(value: CanonicalJsonValue, emit: (chunk: string) => void): void {
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
