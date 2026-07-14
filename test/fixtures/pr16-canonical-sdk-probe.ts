import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join } from "node:path";

/** The sole source-host PR16 driver.  It deliberately has no test or adapter imports. */
type J = Record<string, unknown>;
type Track = "current-dev" | "pinned-c439";
const SCHEMA = {
	index: "pr16-global-evidence-index/v3",
	identity: "pr16-global-index-identity/v1",
	trace: "pr16-probe-trace/v1",
	manifest: "pr16-evidence-manifest/v9",
	review: "pr16-reviewer-verification/v7",
} as const;
async function main(): Promise<void> {
	const input = process.argv.slice(2);
	const command = input.shift();
	try {
		if (command !== "run" && command !== "review") die("subcommand must be run or review");
		const parsed = args(input, command);
		if (command === "run") await run(parsed);
		else review(parsed);
	} catch (error) {
		process.stderr.write(`pr16 probe: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}

function args(xs: string[], cmd: string): Map<string, string> {
	const allowed =
		cmd === "run"
			? [
					"canonical",
					"track",
					"source-cli",
					"work-root",
					"timeout-ms",
					"trace",
					"probe-sha256",
					"provenance",
					"provenance-sha256",
					"provenance-devino",
					"uid-mapping",
					"uid-mapping-sha256",
					"uid-mapping-devino",
					"global-index",
					"global-index-identity",
					"handoff-output",
				]
			: [
					"track",
					"work-root",
					"manifest",
					"handoff",
					"probe-sha256",
					"global-index",
					"global-index-identity",
					"uid-mapping",
					"uid-mapping-sha256",
					"uid-mapping-devino",
				];
	const m = new Map<string, string>();
	for (let i = 0; i < xs.length; i++) {
		const k = xs[i];
		if (!k.startsWith("--") || !allowed.includes(k.slice(2)) || m.has(k.slice(2)))
			die(`invalid or duplicate argument ${k}`);
		const v = xs[++i];
		if (!v || v.startsWith("--")) die(`missing value for ${k}`);
		m.set(k.slice(2), v);
	}
	const req =
		cmd === "run"
			? [
					"canonical",
					"track",
					"source-cli",
					"work-root",
					"timeout-ms",
					"trace",
					"probe-sha256",
					"global-index",
					"global-index-identity",
				]
			: ["track", "work-root", "manifest", "handoff", "probe-sha256", "global-index", "global-index-identity"];
	for (const k of req) if (!m.has(k)) die(`missing --${k}`);
	if (m.get("track") !== "current-dev" && m.get("track") !== "pinned-c439")
		die("track must be current-dev or pinned-c439");
	for (const k of [
		"canonical",
		"source-cli",
		"work-root",
		"trace",
		"provenance",
		"manifest",
		"handoff",
		"global-index",
		"global-index-identity",
		"uid-mapping",
	])
		if (m.has(k) && !isAbsolute(m.get(k)!)) die(`--${k} must be absolute`);
	if (m.has("handoff-output") && !isAbsolute(m.get("handoff-output")!)) die("--handoff-output must be absolute");
	if (cmd === "run" && (!/^\d+$/.test(m.get("timeout-ms") ?? "") || Number(m.get("timeout-ms")) < 100))
		die("timeout-ms must be at least 100");
	return m;
}

async function run(a: Map<string, string>): Promise<void> {
	const track = a.get("track") as Track,
		root = a.get("work-root")!;
	const index = json(a.get("global-index")!, SCHEMA.index),
		identity = json(a.get("global-index-identity")!, SCHEMA.identity);
	validateGlobal(index, identity, a.get("global-index")!, a.get("global-index-identity")!, track);
	observed(
		"global probe identity",
		index.probeSha === a.get("probe-sha256") &&
			(index.artifacts as J[]).every(artifact => artifact.probeSha === a.get("probe-sha256")),
		"index and artifacts bind the exact probe SHA",
	);
	observed("probe identity", a.get("probe-sha256") === hash(new URL(import.meta.url).pathname), "probe SHA");
	observed(
		"global access",
		access(a.get("global-index")!, a.get("global-index-identity")!, track).pass === true,
		"readonly fixed paths and mutation denial",
	);
	const uidMapping = track === "pinned-c439" ? validateUidMapping(a) : undefined;
	let provenance: J | undefined;
	if (track === "pinned-c439") {
		for (const k of ["provenance", "provenance-sha256", "provenance-devino"]) if (!a.has(k)) die(`missing --${k}`);
		const provenancePath = a.get("provenance")!;
		provenance = json(provenancePath, "pr16-provenance-receipt/v4");
		const provenanceStat = statSync(provenancePath);
		const expectedDevino = parseDevino(a.get("provenance-devino")!);
		const provenanceText = readFileSync(provenancePath, "utf8");
		observed(
			"provenance",
			provenance.schema === "pr16-provenance-receipt/v4" &&
				hash(provenancePath) === a.get("provenance-sha256") &&
				provenanceStat.dev === expectedDevino.dev &&
				provenanceStat.ino === expectedDevino.inode &&
				(provenanceStat.mode & 0o777) === 0o644 &&
				provenanceText.endsWith("\n") &&
				provenance.track === track &&
				provenance.probeSha256 === a.get("probe-sha256") &&
				typeof provenance.canonicalSha256 === "string",
			"immutable mounted receipt content, schema, track, hash, and dev:ino",
		);
		observed("provenance readonly", !canOpenWritable(provenancePath), "mount rejects writable open");
	}
	for (const d of ["home", "agent", "project", "state", "sessions", "evidence"]) {
		mkdirSync(join(root, d), { recursive: true, mode: 0o700 });
		chmodSync(join(root, d), 0o700);
	}
	writeFileSync(join(root, "home", ".gjc-config"), "", { mode: 0o600 });
	const provider = await startProvider(root);
	let life: Awaited<ReturnType<typeof lifecycle>> | undefined;
	let ws: WebSocket | undefined;
	try {
		writeModels(root, provider.url);
		const marker = await markers(root, a, track);
		life = await lifecycle(a, root);
		finalizeMarkers(marker, root, track);
		const session = await protocol(life.endpoint);
		ws = session.ws;
		const q10 = await queries(ws),
			selection = await levels(ws),
			gate = await gateTurn(ws, String(life.lifecycle.sessionId), provider);
		writeFileSync(
			join(root, "evidence", "pre-cleanup-receipt.json"),
			`${JSON.stringify(redact({ schema: "pr16-pre-cleanup-receipt/v1", sessionId: life.lifecycle.sessionId, endpoint: { url: life.endpoint.url, token: "[redacted]" }, providerRequests: provider.requests(), ownedProcess: { lifecycle: "active", observed: true } }))}\n`,
			{ mode: 0o600 },
		);
		life.lifecycle.closeIdempotent = await life.close();
		life.lifecycle.close = true;
		ws.close();
		ws = undefined;
		const endpointRejected = await socket(
			`${String(life.endpoint.url)}?token=${encodeURIComponent(String(life.endpoint.token))}`,
		)
			.then(w => {
				w.close();
				return false;
			})
			.catch(() => true);
		provider.stop();
		const cleanup = {
			schema: "pr16-cleanup-receipt/v1",
			status: "complete",
			sessionClosed: life.lifecycle.close === true,
			endpointRejected,
			providerStopped: true,
			ownedProcess: { lifecycle: "exited", observed: true },
		};
		observed("endpoint cleanup", endpointRejected, "closed endpoint rejected");
		writeFileSync(join(root, "evidence", "cleanup-receipt.json"), `${JSON.stringify(redact(cleanup))}\n`, {
			mode: 0o600,
		});
		if (track === "pinned-c439") await writeNativeReceipt(root);
		const trace = {
			schema: SCHEMA.trace,
			track,
			probeSha256: a.get("probe-sha256"),
			globalIndex: (index.artifacts as J[]).map(x => ({
				logicalId: x.logicalId,
				schema: x.schema,
				sha256: x.sha256,
				dev: x.dev,
				inode: x.inode,
				mode: x.mode,
			})),
			marker,
			lifecycle: { ...life.lifecycle, savedPath: undefined },
			protocol: session.receipts,
			q10,
			selection,
			gate,
			retention: "retain-through-handoff",
		};
		writeFileSync(a.get("trace")!, `${JSON.stringify(redact(trace))}\n`, { mode: 0o600 });
		const evidence = readdirSync(join(root, "evidence")).filter(name => name !== "manifest.json");
		const entries = evidence.map(name => ({
			path: `evidence/${name}`,
			sha256: hash(join(root, "evidence", name)),
		}));
		const manifest = {
			schema: SCHEMA.manifest,
			track,
			probeSha256: a.get("probe-sha256"),
			adapterUid: process.getuid?.(),
			adapterGid: process.getgid?.(),
			globalEvidenceIndexRef: ref(a.get("global-index")!, index, "global:index"),
			globalIndexIdentityRef: ref(a.get("global-index-identity")!, identity, "global:index-identity"),
			entries,
			markers: marker,
			pinnedProvenance: provenance ? redact(provenance) : undefined,
			writeAudit: "observed",
			retention: "retain-through-handoff",
		};
		const manifestPath = join(root, "evidence", "manifest.json");
		writeFileSync(manifestPath, `${JSON.stringify(redact(manifest))}\n`, { mode: 0o600 });
		const handoff = {
			schema: "pr16-handoff/v1",
			track,
			manifestPath,
			manifestSha256: hash(manifestPath),
			globalEvidenceIndexRef: manifest.globalEvidenceIndexRef,
			globalIndexIdentityRef: manifest.globalIndexIdentityRef,
			indexIdentityOwn: {
				sha256: hash(a.get("global-index-identity")!),
				dev: statSync(a.get("global-index-identity")!).dev,
				inode: statSync(a.get("global-index-identity")!).ino,
				mode: statSync(a.get("global-index-identity")!).mode & 0o777,
			},
			uidMapping: uidMapping ?? { adapterUid: manifest.adapterUid, adapterGid: manifest.adapterGid },
		};
		const handoffPath = track === "pinned-c439" ? join(root, "evidence", "handoff.json") : join(root, "handoff.json");
		writeFileSync(a.get("handoff-output") ?? handoffPath, `${JSON.stringify(redact(handoff))}\n`, {
			mode: 0o600,
		});
	} finally {
		if (ws) ws.close();
		if (life && life.lifecycle.close !== true) {
			try {
				await life.close();
			} catch {}
		}
		provider.stop();
	}
}

async function writeNativeReceipt(root: string): Promise<void> {
	const nativeDir = "/opt/gajae-code/packages/natives/native";
	const source = join(nativeDir, "index.js");
	observed("native source", existsSync(source), "reviewed native module");
	const moduleUrl = new URL(`file://${source}`).href;
	const candidates = readdirSync(nativeDir)
		.filter(name => name.endsWith(".node"))
		.sort()
		.map(name => join(nativeDir, name));
	observed("native candidates", candidates.length > 0, "native addon candidate");
	const candidate = candidates[0]!;
	const bindings = createRequire(import.meta.url)(candidate) as J;
	observed("native sentinel", typeof bindings.__piNativesV0_10_1 === "function", "first candidate version sentinel");
	const stale = readdirSync("/opt/gajae-code/packages").filter(
		name => name.startsWith("natives-") && existsSync(join("/opt/gajae-code/packages", name, "native")),
	);
	observed("native stale candidates", stale.length === 0, "no stale candidate directories");
	const mod = (await import(moduleUrl)) as J;
	const exports = Object.keys(mod).sort();
	const hashed = (mod.h06FormatHashLines as (text: string, startLine: number) => string)("alpha\nbeta", 1);
	const fuzzySequence = (
		mod.h02ScoreSequenceFuzzy as (lines: string[], pattern: string[], start: number, eof: boolean) => J
	)(["function alpha() {}", "x"], ["function alpha() {}"], 0, false);
	const fuzzyMatch = (mod.h01FindBestFuzzyMatch as (content: string, target: string, threshold: number) => J)(
		"alpha\nbeta",
		"alpha",
		0.9,
	);
	observed(
		"native APIs",
		typeof mod.h06FormatHashLines === "function" &&
			typeof mod.h02ScoreSequenceFuzzy === "function" &&
			typeof mod.h01FindBestFuzzyMatch === "function" &&
			hashed.split("\n").length === 2 &&
			typeof fuzzySequence.matchCount === "number" &&
			fuzzyMatch !== null,
		"native hash and fuzzy APIs",
	);
	writeFileSync(
		join(root, "evidence", "native-receipt.json"),
		`${JSON.stringify(
			redact({
				schema: "pr16-native-receipt/v1",
				sourceModuleLoaded: true,
				sourceSha256: hash(source),
				selectedCandidate: basename(candidate),
				selectedCandidateSha256: hash(candidate),
				sentinel: "__piNativesV0_10_1",
				knownExports: ["h06FormatHashLines", "h02ScoreSequenceFuzzy", "h01FindBestFuzzyMatch"],
				observedExports: exports,
				hashLineCount: hashed.split("\n").length,
				fuzzySequenceMatchCount: fuzzySequence.matchCount,
				fuzzyMatchObserved: fuzzyMatch !== null,
				staleCandidateDirectories: stale,
			}),
		)}\n`,
		{ mode: 0o600 },
	);
}
function writeModels(root: string, url: string): void {
	const models: string[] = [];
	for (let i = 0; i < 192; i++)
		models.push(
			`      - id: page-${String(i + 1).padStart(3, "0")}\n        api: openai-completions\n        baseUrl: ${url}\n        reasoning: false`,
		);
	const y = `providers:\n  probe:\n    api: openai-completions\n    auth: none\n    baseUrl: ${url}\n    models:\n      - id: plain\n        api: openai-completions\n        baseUrl: ${url}\n        reasoning: false\n      - id: reasoning\n        api: openai-completions\n        baseUrl: ${url}\n        reasoning: true\n        thinking:\n          minLevel: low\n          maxLevel: max\n          mode: effort\n          defaultLevel: medium\n          levels: [low, medium, high, xhigh, max]\n${models.join("\n")}\n`;
	writeFileSync(join(root, "agent", "models.yml"), y, { mode: 0o600 });
}

async function markers(root: string, _a: Map<string, string>, _track: Track): Promise<J> {
	const agent = join(root, "agent", "marker"),
		current = join(root, "project", "marker");
	writeFileSync(join(root, "agent", "marker.ts"), `Bun.write(${JSON.stringify(agent)},"agent\\n")`);
	writeFileSync(join(root, "project", "marker.ts"), `Bun.write(${JSON.stringify(current)},"current\\n")`);
	writeFileSync(join(root, "agent", "bunfig.toml"), `preload=[${JSON.stringify(join(root, "agent", "marker.ts"))}]\n`);
	writeFileSync(
		join(root, "project", "bunfig.toml"),
		`preload=[${JSON.stringify(join(root, "project", "marker.ts"))}]\n`,
	);
	writeFileSync(join(root, "agent", ".env"), `PR16_AGENT_MARKER=${agent}\n`);
	writeFileSync(join(root, "project", ".env"), `PR16_CURRENT_MARKER=${current}\n`);
	const precheck = !exists(agent) && !exists(current);
	const activeProcessCount = configProcessCount(root);
	const brokerAbsent = !exists(join(root, "agent", "broker.sock")) && !exists(join(root, "agent", "broker.pid"));
	observed("marker precheck", precheck, "both markers absent before lifecycle");
	observed("broker precheck", brokerAbsent, "no broker marker/socket before create");
	const r = {
		schema: "pr16-marker-receipt/v3",
		agentMarkerExecuted: false,
		currentMarkerExecuted: false,
		driverMarkerPrecheck: precheck,
		driverConfigActiveProcessCount: activeProcessCount,
		brokerAbsentBeforeCreate: brokerAbsent,
		sessionCommandOverridePresent: Boolean(process.env.PI_SESSION_COMMAND || process.env.GJC_SESSION_COMMAND),
	};
	return r;
}
function finalizeMarkers(r: J, root: string, track: Track): void {
	const agent = join(root, "agent", "marker"),
		current = join(root, "project", "marker");
	const expectedAgent = track === "current-dev",
		expectedCurrent = track === "current-dev";
	const agentExecuted = exists(agent) && readFileSync(agent, "utf8") === "agent\n";
	const currentExecuted = exists(current) && readFileSync(current, "utf8") === "current\n";
	observed("agent marker", agentExecuted === expectedAgent, "broker child attribution");
	observed("current marker", currentExecuted === expectedCurrent, "broker child attribution");
	r.agentMarkerExecuted = agentExecuted;
	r.currentMarkerExecuted = currentExecuted;
	observed(
		"marker receipt contract",
		r.driverMarkerPrecheck === true &&
			r.driverConfigActiveProcessCount === 0 &&
			r.brokerAbsentBeforeCreate === true &&
			(track === "current-dev"
				? r.agentMarkerExecuted === true && r.currentMarkerExecuted === true
				: r.agentMarkerExecuted === false &&
					r.currentMarkerExecuted === false &&
					r.sessionCommandOverridePresent === false),
		"derived marker and broker observations",
	);
	writeFileSync(join(root, "evidence", "marker-receipt.json"), `${JSON.stringify(r)}\n`, { mode: 0o600 });
}

async function lifecycle(
	a: Map<string, string>,
	root: string,
): Promise<{ endpoint: J; lifecycle: J; close: () => Promise<boolean> }> {
	const cli = a.get("source-cli")!,
		agent = join(root, "agent"),
		cwd = join(root, "project"),
		env = safe(root);
	const run = async (op: string, input: J, key?: string) => {
		const argv = [
			"bun",
			"--no-env-file",
			"--config=/dev/null",
			cli,
			"daemon",
			"session",
			"global",
			"--op",
			op,
			"--json-input-stdin",
			...(key ? ["--idempotency-key", key] : []),
			"--agent-dir",
			agent,
		];
		const p = Bun.spawn(argv, {
			cwd: agent,
			env,
			stdin: Buffer.from(JSON.stringify(input)),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, exit] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		observed(op, exit === 0 && !!out.trim(), sanitize(err));
		const x = JSON.parse(out.trim()) as J;
		observed(`${op} response`, x.ok === true, JSON.stringify(x.error ?? {}));
		return (x.result ?? {}) as J;
	};
	const create = await run("session.create", { cwd }, randomUUID());
	const sid = String(create.sessionId),
		endpoint = create.endpoint as J;
	observed(
		"authority",
		typeof sid === "string" && typeof endpoint?.url === "string" && typeof endpoint?.token === "string",
		"session authority",
	);
	const list = await run("session.list", { cwd, resolveSessionId: sid });
	const saved = (list.savedSession ?? {}) as J;
	observed("list", saved.id === sid, "saved session identity");
	const resolve = await run("session.list", { cwd, resolveSessionId: sid });
	observed("resolve", (resolve.savedSession as J)?.id === sid, "resolved session");
	const resumed = await run("session.resume", { cwd, sessionId: sid, sessionPath: String(saved.path) }, randomUUID());
	observed("resume", resumed.sessionId === sid, "session authority");
	const mismatch = await run(
		"session.resume",
		{ cwd, sessionId: `${sid}-mismatch`, sessionPath: String(saved.path) },
		randomUUID(),
	).catch(() => undefined);
	observed("mismatched resume", mismatch === undefined, "wrong session rejected");
	return {
		endpoint,
		lifecycle: {
			create: observed("lifecycle create", sid.length > 0, "session id"),
			list: observed("lifecycle list", saved.id === sid, "saved session identity"),
			resolve: observed("lifecycle resolve", (resolve.savedSession as J)?.id === sid, "resolved session"),
			resume: observed("lifecycle resume", resumed.sessionId === sid, "session authority"),
			sessionId: sid,
			savedPath: saved.path,
			resumed: resumed.sessionId,
		},
		close: async () => {
			await run("session.close", { sessionId: sid }, randomUUID());
			try {
				await run("session.close", { sessionId: sid }, randomUUID());
				return true;
			} catch {
				return false;
			}
		},
	};
}

async function protocol(endpoint: J): Promise<{ endpoint: J; ws: WebSocket; receipts: J[] }> {
	const url = String(endpoint.url),
		token = String(endpoint.token),
		receipts: J[] = [];
	const bad = await socket(`${url}?token=wrong`)
		.then(w => {
			w.close();
			return false;
		})
		.catch(() => true);
	observed("wrong token", bad, "handshake rejected");
	const ws = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
	await open(ws);
	bindFrames(ws);
	const hello = await nextFrame(ws, () => true);
	const valid =
		["hello", "server_hello", "broker_hello"].includes(String(hello.type)) &&
		hello.protocolVersion === 3 &&
		typeof hello.connectionId === "string";
	observed("protocol hello", valid, "protocolVersion/connection");
	receipts.push({ hello: hello.type, protocolVersion: hello.protocolVersion, connectionId: hello.connectionId });
	return { endpoint, ws, receipts };
}
async function socket(url: string): Promise<WebSocket> {
	const w = new WebSocket(url);
	await open(w);
	return w;
}
function open(w: WebSocket): Promise<void> {
	return new Promise((ok, no) => {
		const t = setTimeout(() => no(new Error("websocket timeout")), 5000);
		w.addEventListener(
			"open",
			() => {
				clearTimeout(t);
				ok();
			},
			{ once: true },
		);
		w.addEventListener(
			"error",
			() => {
				clearTimeout(t);
				no(new Error("websocket rejected"));
			},
			{ once: true },
		);
	});
}
async function request(w: WebSocket, type: string, body: J): Promise<J> {
	const id = randomUUID();
	w.send(JSON.stringify({ type, ...body, id }));
	const f = await nextFrame(
		w,
		frame => frame.id === id && (frame.type === "query_response" || frame.type === "control_response"),
	);
	observed(`${type} response`, f.id === id && f.ok !== undefined, JSON.stringify(f.error ?? {}));
	return f;
}
async function collectModels(
	w: WebSocket,
	initialCursor?: string,
	initialItems: J[] = [],
): Promise<{ items: J[]; pages: number }> {
	const items: J[] = [...initialItems];
	const seen = new Set<string>();
	let cursor = initialCursor;
	for (let pageNo = initialCursor ? 2 : 1; pageNo <= 256; pageNo++) {
		const response = await request(w, "query_request", {
			query: "models.list/current",
			input: {},
			...(cursor ? { cursor } : {}),
		});
		const page = response.page as J;
		observed("q10 response page", Array.isArray(page?.items) && typeof page.complete === "boolean", "canonical page");
		for (const item of page.items as J[]) {
			const key = `${item.provider}/${item.id}`;
			observed(
				"q10 duplicate",
				!items.some(existing => `${existing.provider}/${existing.id}` === key),
				"unique tuple",
			);
			items.push(item);
		}
		if (page.complete === true) return { items, pages: pageNo };
		const next = page.continuationCursor;
		if (typeof next !== "string" || next.length === 0 || seen.has(next)) die("invalid Q10 continuation cursor");
		seen.add(next);
		cursor = next;
	}
	die("q10 exceeded page cap");
}
async function queries(w: WebSocket): Promise<J> {
	const firstPage = await request(w, "query_request", { query: "models.list/current", input: {} });
	const first = firstPage.page as J;
	observed(
		"q10 incomplete",
		first.complete === false && typeof first.continuationCursor === "string",
		"disposable cursor",
	);
	const mismatch = await request(w, "query_request", {
		query: "session.metadata",
		input: {},
		cursor: first.continuationCursor,
	});
	observed(
		"cursor mismatch",
		mismatch.ok === false && (mismatch.error as J)?.code === "invalid_input",
		"typed invalid_input",
	);
	const walk = await collectModels(w, first.continuationCursor as string, first.items as J[]);
	observed("q10 pages", walk.pages >= 2, "at least two pages");
	const fresh = await collectModels(w);
	observed("q10 fresh pages", fresh.pages >= 2 && fresh.items.length === walk.items.length, "fresh complete walk");
	const custom = walk.items.filter(item => item.provider === "probe" && item.id === "reasoning");
	observed("q10 custom row", custom.length === 1, "exact custom model");
	const row = custom[0];
	observed("q10 tuple", row.reasoning === true && Array.isArray((row.thinking as J)?.validLevels), "full tuple");
	return {
		mismatch: mismatch.ok === false,
		continuation: walk.pages >= 2,
		freshWalk: fresh.pages >= 2,
		pages: walk.pages,
		freshPages: fresh.pages,
		items: walk.items.length,
		customRow: row,
	};
}
async function levels(w: WebSocket): Promise<J> {
	const values = ["off", "low", "medium", "high", "xhigh", "max"],
		rows: J[] = [];
	let lastItems: J[] = [];
	for (const thinkingLevel of values) {
		const f = await request(w, "control_request", {
			operation: "model.set",
			input: { id: "probe/reasoning", thinkingLevel },
		});
		observed(`setter ${thinkingLevel}`, f.ok === true, "canonical model.set");
		const readback = await collectModels(w);
		lastItems = readback.items;
		const row = readback.items.find(item => item.provider === "probe" && item.id === "reasoning");
		observed(
			`current ${thinkingLevel}`,
			row?.current === true && row.currentThinkingLevel === thinkingLevel,
			"normalized current readback",
		);
		rows.push({ level: thinkingLevel, result: f.result, readback: row });
	}
	const restore = await request(w, "control_request", {
		operation: "model.set",
		input: { id: "probe/reasoning", thinkingLevel: "medium" },
	});
	const check = await collectModels(w);
	lastItems = check.items;
	const current = check.items.find(item => item.provider === "probe" && item.id === "reasoning");
	observed("medium restored", restore.ok === true && current?.currentThinkingLevel === "medium", "pre-gate level");
	const probeModels = lastItems.filter(item => item.provider === "probe");
	const exactThinkingSurface = probeModels.filter(item => {
		const thinking = item.thinking as J | undefined;
		return Array.isArray(thinking?.validLevels) && JSON.stringify(thinking.validLevels) === JSON.stringify(values);
	});
	const customOnly =
		probeModels.filter(item => item.id === "reasoning").length === 1 &&
		exactThinkingSurface.length === 1 &&
		exactThinkingSurface[0]?.id === "reasoning" &&
		probeModels.filter(item => item.id !== "reasoning").every(item => item.reasoning === false);
	observed(
		"custom thinking surface",
		customOnly,
		"only probe/reasoning exposes the exact provider-local six-level surface",
	);
	return { customOnly, levels: rows, restored: current };
}
async function gateTurn(
	w: WebSocket,
	sessionId: string,
	provider: { requests: () => number; secondRequestHasToolResult: () => boolean },
): Promise<J> {
	const baseline = await request(w, "query_request", { query: "workflow.gates.list", input: {} });
	observed("q12 baseline", baseline.ok === true && baseline.page !== undefined, "gate snapshot");
	const baselineItems = ((baseline.page as J).items ?? []) as J[];
	const baselineIds = new Set(baselineItems.map(item => String(item.id ?? item.gateId ?? "")));
	const beforePrompt = provider.requests();
	const f = await request(w, "control_request", { operation: "turn.prompt", input: { text: "probe" } });
	for (let attempt = 0; provider.requests() < 1 && attempt < 50; attempt++) await Bun.sleep(100);
	const afterPrompt = provider.requests();
	observed("provider request one", beforePrompt === 0 && afterPrompt === 1, "exactly one request before gate answer");
	const result = f.result as J;
	const commandId = result.commandId,
		turnId = result.turnId;
	observed(
		"prompt correlation",
		f.ok === true &&
			typeof commandId === "string" &&
			commandId.length > 0 &&
			typeof turnId === "string" &&
			turnId.length > 0 &&
			sessionId.length > 0,
		"accepted turn",
	);
	let after: J | undefined;
	let gate: J | undefined = frameQueues.get(w)?.find(frame => frame.type === "workflow_gate");
	for (let attempt = 0; !gate && attempt < 50; attempt++) {
		after = await request(w, "query_request", { query: "workflow.gates.list", input: {} });
		const afterItems = ((after.page as J)?.items ?? []) as J[];
		gate = afterItems.find(item => !baselineIds.has(String(item.id ?? item.gateId ?? "")));
		gate ??= frameQueues.get(w)?.find(frame => frame.type === "workflow_gate");
		if (gate) break;
		await Bun.sleep(100);
	}
	const gateId = String(gate?.id ?? gate?.gateId ?? gate?.gate_id ?? "");
	observed("gate observed", gateId.length > 0, "Q12 durable gate");
	const beforeAnswer = provider.requests();
	observed("provider request one before answer", beforeAnswer === 1, "no second request before gate answer");
	const ans = await request(w, "control_request", {
		operation: "workflow.gate_answer",
		input: { id: gateId, response: { selected: ["one"], other: false } },
		idempotencyKey: randomUUID(),
	});
	for (let attempt = 0; !provider.secondRequestHasToolResult() && attempt < 50; attempt++) await Bun.sleep(100);
	const acceptedBeforeRequest2 = ans.ok === true && provider.secondRequestHasToolResult();
	observed(
		"gate accepted before request two",
		acceptedBeforeRequest2,
		"request two contains the resolved ask tool result",
	);
	let terminal: J | undefined;
	let sawResolved = false;
	let sawIdle = false;
	for (let i = 0; i < 64; i++) {
		let event: J;
		try {
			event = await nextFrame(w, frame => frame.type !== "query_response" && frame.type !== "control_response");
		} catch {
			break;
		}
		const payload =
			event.type === "event" && typeof event.payload === "object" && event.payload !== null
				? (event.payload as J)
				: event;
		// Retain only correlated terminal evidence; raw frames are intentionally excluded.
		sawResolved ||= payload.type === "action_resolved";
		sawIdle ||= payload.type === "activity" && payload.state === "idle";
		if (
			payload.type === "agent_failed" &&
			payload.sessionId === sessionId &&
			payload.commandId === commandId &&
			payload.turnId === turnId
		)
			die("correlated agent_failed");
		if (
			payload.type === "agent_end" &&
			payload.sessionId === sessionId &&
			payload.commandId === commandId &&
			payload.turnId === turnId
		) {
			terminal = { type: "agent_end", correlated: true };
			break;
		}
	}
	const compatibilityObservation =
		terminal === undefined && sawResolved && sawIdle
			? { type: "finalized_idle", correlatedTerminal: false, providerRequests: provider.requests() }
			: undefined;
	const canonicalTerminalPresent = terminal !== undefined;
	const canonicalTerminalAbsent = !canonicalTerminalPresent;
	const afterAnswer = provider.requests();
	observed("provider request two", afterAnswer === 2, "exactly two requests after accepted gate answer");
	return {
		baseline: baseline.page,
		after: after?.page,
		acceptedBeforeRequest2,
		commandId,
		turnId,
		sessionId,
		gateId,
		terminal,
		compatibilityObservation,
		canonicalTerminalPresent,
		canonicalTerminalAbsent,
	};
}

function review(a: Map<string, string>): void {
	const track = a.get("track") as Track;
	const workRoot = a.get("work-root")!;
	const evidencePath = join(workRoot, "evidence");
	const manifestPath = a.get("manifest")!,
		handoffPath = a.get("handoff")!;
	const expectedManifest = join(evidencePath, "manifest.json");
	const expectedHandoff =
		track === "pinned-c439" ? join(evidencePath, "handoff.json") : join(workRoot, "handoff.json");
	requireDirectory(workRoot, "work root");
	const evidenceRoot = requireDirectory(evidencePath, "evidence root");
	observed("manifest location", manifestPath === expectedManifest, "manifest is derived from work root");
	observed("handoff location", handoffPath === expectedHandoff, "handoff is derived from work root");
	requireRegular(manifestPath);
	requireRegular(handoffPath);
	const i = json(a.get("global-index")!, SCHEMA.index),
		id = json(a.get("global-index-identity")!, SCHEMA.identity);
	validateGlobal(i, id, a.get("global-index")!, a.get("global-index-identity")!, track);
	observed(
		"review global probe identity",
		i.probeSha === a.get("probe-sha256") &&
			(i.artifacts as J[]).every(artifact => artifact.probeSha === a.get("probe-sha256")),
		"global evidence binds the reviewed probe SHA",
	);
	const repeatedAccess = access(a.get("global-index")!, a.get("global-index-identity")!, track);
	observed("review access proof", repeatedAccess.pass === true, "fixed reads and track mutation/list semantics");
	const reviewedUidMapping = track === "pinned-c439" ? validateUidMapping(a) : undefined;
	const m = json(manifestPath, SCHEMA.manifest),
		h = json(handoffPath, "pr16-handoff/v1");
	observed("manifest identity", m.probeSha256 === a.get("probe-sha256") && m.track === track, "manifest");
	const expectedIndexRef = ref(a.get("global-index")!, i, "global:index");
	const expectedIdentityRef = ref(a.get("global-index-identity")!, id, "global:index-identity");
	observed(
		"complete global references",
		JSON.stringify(m.globalEvidenceIndexRef) === JSON.stringify(expectedIndexRef) &&
			JSON.stringify(m.globalIndexIdentityRef) === JSON.stringify(expectedIdentityRef),
		"manifest logical ID/schema/path/SHA/dev/inode/mode references",
	);
	observed(
		"handoff schema",
		h.track === track &&
			h.manifestPath === manifestPath &&
			h.manifestSha256 === hash(manifestPath) &&
			JSON.stringify(h.globalEvidenceIndexRef) === JSON.stringify(expectedIndexRef) &&
			JSON.stringify(h.globalIndexIdentityRef) === JSON.stringify(expectedIdentityRef) &&
			(reviewedUidMapping === undefined || JSON.stringify(h.uidMapping) === JSON.stringify(reviewedUidMapping)),
		"handoff schema, manifest SHA, and complete global references",
	);
	const indexIdentityOwn = h.indexIdentityOwn as J | undefined;
	const identityStat = statSync(a.get("global-index-identity")!);
	observed(
		"handoff identity metadata",
		indexIdentityOwn?.sha256 === hash(a.get("global-index-identity")!) &&
			indexIdentityOwn?.dev === identityStat.dev &&
			indexIdentityOwn?.inode === identityStat.ino &&
			indexIdentityOwn?.mode === (identityStat.mode & 0o777),
		"index identity own SHA/dev/inode/mode",
	);
	const entries = Array.isArray(m.entries) ? (m.entries as J[]) : [];
	const expectedTrace = `evidence/${track}.trace.jsonl`;
	const traceEntries = entries.filter(entry => String(entry.path).endsWith(".trace.jsonl"));
	observed(
		"track trace entry",
		traceEntries.length === 1 && traceEntries[0]?.path === expectedTrace,
		"exactly one track-named trace entry",
	);
	requireEvidenceRegular(workRoot, evidenceRoot, expectedTrace);
	const trace = json(join(workRoot, expectedTrace), SCHEMA.trace);
	const gate = trace.gate as J,
		lifecycle = trace.lifecycle as J,
		compatibilityObservation = gate.compatibilityObservation as J | undefined;
	observed(
		"trace lifecycle and gate",
		trace.track === track &&
			trace.probeSha256 === a.get("probe-sha256") &&
			typeof lifecycle.closeIdempotent === "boolean" &&
			typeof gate.canonicalTerminalPresent === "boolean" &&
			typeof gate.canonicalTerminalAbsent === "boolean" &&
			gate.acceptedBeforeRequest2 === true &&
			gate.canonicalTerminalAbsent === !gate.canonicalTerminalPresent &&
			(!gate.canonicalTerminalAbsent || compatibilityObservation?.correlatedTerminal === false),
		"trace identity and mandatory lifecycle/gate fields",
	);
	const expected = new Set(entries.map(entry => String(entry.path)));
	const mismatches: string[] = [];
	for (const entry of entries) {
		const p = String(entry.path);
		observed(
			"manifest entry path",
			!isAbsolute(p) && p.startsWith("evidence/") && p !== "evidence/manifest.json",
			"relative local entry",
		);
		const full = requireEvidenceRegular(workRoot, evidenceRoot, p);
		try {
			if (hash(full) !== entry.sha256) mismatches.push(p);
		} catch {
			mismatches.push(p);
		}
	}
	const actual = readdirSync(evidencePath).filter(name => name !== "manifest.json" && name !== basename(handoffPath));
	const extra = actual.filter(name => !expected.has(`evidence/${name}`));
	observed("local entries", mismatches.length === 0 && extra.length === 0, "missing or extra local evidence");
	const compatibility = {
		disposition:
			gate.canonicalTerminalPresent === true && lifecycle.closeIdempotent === true ? "compatible" : "blocked",
		issues: [
			...(gate.canonicalTerminalPresent ? [] : ["missing-correlated-terminal"]),
			...(lifecycle.closeIdempotent ? [] : ["non-idempotent-close"]),
		],
		correlatedTerminal: gate.canonicalTerminalPresent,
		finalizedIdleObserved: compatibilityObservation?.correlatedTerminal === false,
		closeIdempotent: lifecycle.closeIdempotent,
	};
	const out = redact({
		schema: SCHEMA.review,
		track,
		manifestSha256: hash(manifestPath),
		indexIdentity: { schema: id.schema, sha256: hash(a.get("global-index-identity")!) },
		globalRefs: { index: m.globalEvidenceIndexRef, identity: m.globalIndexIdentityRef },
		uidMapping: h.uidMapping ?? { disposition: "not-executed" },
		compatibility,
		local: { count: entries.length, extra, status: mismatches.length === 0 && extra.length === 0 ? "pass" : "fail" },
	});
	process.stdout.write(`${JSON.stringify(out)}\n`);
}
function validateGlobal(i: J, id: J, ip: string, idp: string, t: Track): void {
	observed("global schema", i.schema === SCHEMA.index && id.schema === SCHEMA.identity, "schemas");
	const root = id.root as J,
		fin = id.index as J;
	const physicalRoot = dirname(ip);
	const rootStat = lstatSync(physicalRoot);
	const indexStat = lstatSync(ip);
	const identityStat = lstatSync(idp);
	observed(
		"global root ownership",
		rootStat.isDirectory() &&
			root.path === physicalRoot &&
			rootStat.uid === root.ownerUid &&
			rootStat.gid === root.ownerGid &&
			(rootStat.mode & 0o777) === root.mode &&
			root.mode === 0o711,
		"physical root and identity owner/mode",
	);
	observed(
		"index identity",
		!indexStat.isSymbolicLink() &&
			indexStat.isFile() &&
			i.logicalId === "global:index" &&
			root?.logicalId === "global:root" &&
			fin?.logicalId === "global:index" &&
			fin.path === ip &&
			fin.schema === SCHEMA.index &&
			fin.sha256 === hash(ip) &&
			fin.dev === indexStat.dev &&
			fin.inode === indexStat.ino &&
			fin.mode === 0o444 &&
			(indexStat.mode & 0o777) === 0o444,
		"identity and immutable index",
	);
	observed(
		"identity immutable",
		!identityStat.isSymbolicLink() && identityStat.isFile() && (identityStat.mode & 0o777) === 0o444,
		"identity",
	);
	const xs = i.artifacts;
	observed("artifact index", Array.isArray(xs) && xs.length === 3, "three indexed artifacts");
	for (const x of xs as J[]) {
		const p = String(x.path),
			st = lstatSync(p);
		observed(
			"artifact identity",
			!st.isSymbolicLink() &&
				st.isFile() &&
				typeof x.logicalId === "string" &&
				typeof x.schema === "string" &&
				p.length > 0 &&
				hash(p) === x.sha256 &&
				st.dev === x.dev &&
				st.ino === x.inode &&
				(st.mode & 0o777) === x.mode &&
				(st.mode & 0o777) === 0o444,
			"indexed logical ID/schema/path/hash/dev/inode/mode",
		);
	}
	if (t === "pinned-c439") observed("non-owner", process.getuid?.() !== root.ownerUid, "UID separation");
}
function access(ip: string, idp: string, t: Track): J {
	const d = dirname(ip),
		files = [ip, idp, ...(json(ip, SCHEMA.index).artifacts as J[]).map(x => String(x.path))];
	const fixedReads = files.every(p => {
		try {
			readFileSync(p);
			return true;
		} catch {
			return false;
		}
	});
	let list = false;
	try {
		readdirSync(d);
		list = true;
	} catch {}
	const suffix = createHash("sha256").update(`${Date.now()}-${randomUUID()}`).digest("hex").slice(0, 12);
	const createTarget = join(d, `.create-probe-${suffix}`);
	let create = false;
	try {
		writeFileSync(createTarget, "x", { flag: "wx" });
		create = true;
	} catch {}
	if (create) {
		try {
			unlinkSync(createTarget);
		} catch {}
	}
	const renameTarget = join(d, `.rename-probe-${suffix}`);
	let rename = false;
	try {
		renameSync(ip, renameTarget);
		rename = true;
	} catch {}
	if (rename) {
		try {
			renameSync(renameTarget, ip);
		} catch {}
	}
	const unlinkBytes = readFileSync(idp);
	const unlinkMode = statSync(idp).mode & 0o777;
	let unlink = false;
	try {
		unlinkSync(idp);
		unlink = true;
	} catch {}
	if (unlink) {
		try {
			writeFileSync(idp, unlinkBytes, { mode: unlinkMode });
			chmodSync(idp, unlinkMode);
		} catch {}
	}
	const mutation = {
		create: { attempted: true, denied: !create },
		rename: { attempted: true, denied: !rename },
		unlink: { attempted: true, denied: !unlink },
	};
	return {
		fixedReads,
		directoryList: list,
		mutation,
		pass:
			fixedReads &&
			mutation.create.denied &&
			mutation.rename.denied &&
			mutation.unlink.denied &&
			(t === "current-dev" || !list),
	};
}
function startProvider(
	_root: string,
): Promise<{ url: string; stop: () => void; requests: () => number; secondRequestHasToolResult: () => boolean }> {
	return new Promise(resolve => {
		let completionRequest = 0;
		let secondRequestHasToolResult = false;
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(req) {
				const requestUrl = new URL(req.url);
				observed(
					"provider loopback",
					requestUrl.hostname === "127.0.0.1" || requestUrl.hostname === "localhost",
					"loopback hostname",
				);
				observed("provider path", requestUrl.pathname === "/v1/chat/completions", "completion endpoint");
				const authorization = req.headers.get("authorization");
				observed("provider auth-none", authorization === "Bearer N/A", "canonical no-auth sentinel");
				const requestBody = (await req.json()) as J;
				observed("provider model", requestBody.model === "reasoning", "declared local reasoning model");
				if (completionRequest === 1) {
					const messages = Array.isArray(requestBody.messages) ? (requestBody.messages as J[]) : [];
					secondRequestHasToolResult = messages.some(
						message => message.role === "tool" && message.tool_call_id === "call_probe_ask",
					);
					observed(
						"request two tool result",
						secondRequestHasToolResult,
						"resolved ask result precedes final completion request",
					);
				}
				observed("provider request count", completionRequest < 2, "no extra completion request");
				const ask = completionRequest++ === 0;
				const chunks = ask
					? [
							{
								id: "chatcmpl-probe-ask",
								object: "chat.completion.chunk",
								created: 1,
								model: "reasoning",
								choices: [
									{
										index: 0,
										delta: {
											role: "assistant",
											tool_calls: [
												{
													index: 0,
													id: "call_probe_ask",
													type: "function",
													function: {
														name: "ask",
														arguments: JSON.stringify({
															questions: [
																{
																	id: "probe-choice",
																	question: "choose",
																	options: [{ label: "one" }, { label: "two" }],
																	multi: false,
																	recommended: 0,
																},
															],
														}),
													},
												},
											],
										},
										finish_reason: null,
									},
								],
							},
							{
								id: "chatcmpl-probe-ask",
								object: "chat.completion.chunk",
								created: 1,
								model: "reasoning",
								choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
							},
						]
					: [
							{
								id: "chatcmpl-probe-final",
								object: "chat.completion.chunk",
								created: 2,
								model: "reasoning",
								choices: [{ index: 0, delta: { content: "probe complete" }, finish_reason: null }],
							},
							{
								id: "chatcmpl-probe-final",
								object: "chat.completion.chunk",
								created: 2,
								model: "reasoning",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
							},
						];
				const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
				return new Response(body, {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		resolve({
			url: `http://127.0.0.1:${server.port}/v1`,
			stop: () => server.stop(),
			requests: () => completionRequest,
			secondRequestHasToolResult: () => secondRequestHasToolResult,
		});
	});
}
function parseDevino(value: string): { dev: number; inode: number } {
	const match = /^(\d+):(\d+)$/.exec(value);
	if (!match) die("identity must be DEV:INODE");
	return { dev: Number(match[1]), inode: Number(match[2]) };
}
function validateUidMapping(a: Map<string, string>): J {
	for (const key of ["uid-mapping", "uid-mapping-sha256", "uid-mapping-devino"])
		if (!a.has(key)) die(`missing --${key}`);
	const path = a.get("uid-mapping")!;
	const receipt = json(path, "pr16-pinned-uid-mapping-prerequisite/v1");
	const expected = parseDevino(a.get("uid-mapping-devino")!);
	const stat = statSync(path);
	observed(
		"pinned UID mapping prerequisite",
		hash(path) === a.get("uid-mapping-sha256") &&
			stat.dev === expected.dev &&
			stat.ino === expected.inode &&
			(stat.mode & 0o777) === 0o444 &&
			receipt.disposition === "ready" &&
			receipt.uidDistinct === true &&
			receipt.mappingResult === true &&
			receipt.fixedPathAccess === true &&
			receipt.directoryList === false &&
			receipt.create === false &&
			receipt.rename === false &&
			receipt.unlink === false &&
			receipt.adapterUid === process.getuid?.() &&
			receipt.adapterGid === process.getgid?.(),
		"host-produced mapping, identity, fixed reads, and access negatives",
	);
	return {
		logicalId: "pinned:uid-mapping-prerequisite",
		schema: receipt.schema,
		sha256: hash(path),
		dev: stat.dev,
		inode: stat.ino,
		mode: stat.mode & 0o777,
		disposition: receipt.disposition,
		adapterUid: receipt.adapterUid,
		adapterGid: receipt.adapterGid,
	};
}
function canOpenWritable(path: string): boolean {
	try {
		const fd = openSync(path, "r+");
		closeSync(fd);
		return true;
	} catch {
		return false;
	}
}
function configProcessCount(root: string): number {
	let count = 0;
	try {
		for (const entry of readdirSync("/proc")) {
			if (!/^\d+$/.test(entry)) continue;
			try {
				const cmd = readFileSync(join("/proc", entry, "cmdline"), "utf8");
				if (cmd.includes(root) && (cmd.includes("broker") || cmd.includes("daemon"))) count++;
			} catch {}
		}
	} catch {}
	return count;
}
function safe(root: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin",
		HOME: join(root, "home"),
		GJC_CODING_AGENT_DIR: join(root, "agent"),
		GJC_AGENT_DIR: join(root, "agent"),
		GJC_STATE_ROOT: join(root, "state"),
		GJC_CONFIG_DIR: join(root, ".gjc"),
		NO_PROXY: "*",
		no_proxy: "*",
		http_proxy: "",
		https_proxy: "",
		HTTP_PROXY: "",
		HTTPS_PROXY: "",
		ALL_PROXY: "",
		all_proxy: "",
	};
}
function requireDirectory(p: string, label: string): string {
	const s = lstatSync(p);
	observed(`${label} directory`, s.isDirectory() && !s.isSymbolicLink(), p);
	return realpathSync(p);
}
function requireRegular(p: string): void {
	const s = lstatSync(p);
	observed("regular non-symlink file", s.isFile() && !s.isSymbolicLink(), p);
}
function requireEvidenceRegular(workRoot: string, evidenceRoot: string, p: string): string {
	const full = join(workRoot, p);
	const s = lstatSync(full);
	observed("manifest entry regular file", s.isFile() && !s.isSymbolicLink(), p);
	const resolved = realpathSync(full);
	observed(
		"manifest entry containment",
		resolved.startsWith(`${evidenceRoot}/`) && resolved !== evidenceRoot,
		"entry resolves under evidence root",
	);
	return full;
}
function json(p: string, s?: string): J {
	const x = JSON.parse(readFileSync(p, "utf8")) as J;
	if (s && x.schema !== s) die(`expected ${s}`);
	return x;
}
function hash(p: string): string {
	return createHash("sha256").update(readFileSync(p)).digest("hex");
}
function ref(p: string, v: J, l: string): J {
	const s = statSync(p);
	return { logicalId: l, path: p, schema: v.schema, sha256: hash(p), dev: s.dev, inode: s.ino, mode: s.mode & 0o777 };
}
function exists(p: string): boolean {
	try {
		statSync(p);
		return true;
	} catch {
		return false;
	}
}
function sanitize(x: string): string {
	return x.replace(/(?:token|secret|password|authorization|cookie|pid|cwd|path)=[^\s]+/gi, "redacted").slice(0, 2048);
}
function redact(x: unknown): unknown {
	return JSON.parse(
		JSON.stringify(x, (_k, v) =>
			typeof v === "string" && v.length > 256
				? `[redacted:${createHash("sha256").update(v).digest("hex").slice(0, 16)}]`
				: v,
		),
	);
}
function observed(name: string, ok: boolean, detail: string): boolean {
	if (!ok) die(`observed assertion failed: ${name}: ${detail}`);
	return ok;
}
function die(x: string): never {
	throw new Error(x);
}
const frameQueues = new WeakMap<WebSocket, J[]>();
const frameWaiters = new WeakMap<WebSocket, Array<(frame: J) => void>>();
function bindFrames(w: WebSocket): void {
	frameQueues.set(w, []);
	frameWaiters.set(w, []);
	w.addEventListener("message", event => {
		const frame = JSON.parse(String(event.data)) as J;
		const waiter = frameWaiters.get(w)?.shift();
		if (waiter) waiter(frame);
		else frameQueues.get(w)?.push(frame);
	});
}
async function nextFrame(w: WebSocket, predicate: (frame: J) => boolean): Promise<J> {
	const queued = frameQueues.get(w) ?? [];
	const index = queued.findIndex(predicate);
	if (index >= 0) return queued.splice(index, 1)[0];
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("frame timeout")), 5000);
		const wait = (frame: J) => {
			if (predicate(frame)) {
				clearTimeout(timeout);
				resolve(frame);
			} else {
				frameQueues.get(w)?.push(frame);
				frameWaiters.get(w)?.push(wait);
			}
		};
		frameWaiters.get(w)?.push(wait);
	});
}

await main();
