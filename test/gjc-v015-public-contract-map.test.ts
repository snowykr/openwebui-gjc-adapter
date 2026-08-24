import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type SourceFile = { path: string; sha256: string; byteEncoding: "base64"; bytesBase64: string };
type Disposition = { old: string; new: string };
type ContractMap = {
	schemaVersion: number;
	evidenceSubject: {
		kind: string;
		commit: string;
		pullRequest: number;
		publicImport: string;
		packageRoot: string;
		declarationForm: string;
	};
	publishedNpmMetadata: {
		name: string;
		version: string;
		tarball: string;
		integrity: string;
		tarballSha256: string;
		generationStatus: string;
		note: string;
	};
	devConsumptionPlan: { verificationArtifact: string; productionActivation: string; prohibitedClaim: string };
	devArtifact: {
		path: string;
		sha256: string;
		shasum: string;
		integrity: string;
		packageName: string;
		packageVersion: string;
		build: string;
		slice1Dependency: string;
	};
	upstreamFiles: SourceFile[];
	apiFacts: Record<string, string | string[]>;
	forbiddenImports: string[];
	forbiddenApi: string[];
	disposition: Disposition[];
	evidence: Array<{
		id: string;
		status: "proven" | "blocked";
		criterion: string;
		provenance?: string;
		amendmentRequired?: string;
	}>;
};

const fixturePath = fileURLToPath(new URL("./fixtures/gjc-v015-public-contract-map.json", import.meta.url));
const documentPath = fileURLToPath(new URL("../docs/gjc-v015-public-contract-map.md", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const fixtureText = readFileSync(fixturePath, "utf8");
const fixture = JSON.parse(fixtureText) as ContractMap;
const contractMap = readFileSync(documentPath, "utf8");

const EXPECTED_SOURCE_PATHS = [
	"packages/coding-agent/package.json",
	"packages/coding-agent/src/sdk/index.ts",
	"packages/coding-agent/src/sdk/router/index.ts",
	"packages/coding-agent/src/sdk/router/session-router.ts",
	"packages/coding-agent/src/sdk/broker/session-index.ts",
	"packages/coding-agent/src/sdk/broker/index.ts",
	"packages/coding-agent/src/sdk/lifecycle/index.ts",
	"packages/coding-agent/src/sdk/lifecycle/service.ts",
	"packages/coding-agent/src/sdk/lifecycle/client.ts",
	"packages/coding-agent/src/sdk/session-list.ts",
	"packages/coding-agent/src/sdk/cli/session-cli.ts",
	"packages/coding-agent/src/sdk/host/control/dispatch.ts",
	"docs/sdk.md",
];

function source(path: string): string {
	const file = fixture.upstreamFiles.find(candidate => candidate.path === path);
	if (!file) throw new Error(`Missing embedded upstream source: ${path}`);
	return Buffer.from(file.bytesBase64, "base64").toString("utf8");
}

describe("GJC upstream dev generation-status contract map", () => {
	test("identifies the exact upstream merge and retains older npm metadata separately", () => {
		expect(fixture.schemaVersion).toBe(3);
		expect(fixture.evidenceSubject).toEqual({
			kind: "upstream-dev-merge",
			commit: "e3b3a76a590081ded16214a1188857524d40e701",
			pullRequest: 4853,
			publicImport: "@gajae-code/coding-agent/sdk",
			packageRoot: "packages/coding-agent",
			declarationForm:
				"TypeScript source exports in the exact dev worktree; docs/sdk.md is official protocol evidence; no generated dist/types directory is present.",
		});
		expect(fixture.publishedNpmMetadata).toMatchObject({
			name: "@gajae-code/coding-agent",
			version: "0.15.0",
			generationStatus: "absent",
		});
		expect(fixture.publishedNpmMetadata.note).toContain("predates generationStatus");
		expect(fixture.publishedNpmMetadata.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
		expect(fixture.publishedNpmMetadata.tarballSha256).toMatch(/^[a-f0-9]{64}$/);
	});

	test("recomputes every exact dev source hash solely from embedded bytes", () => {
		expect(fixture.upstreamFiles.map(file => file.path)).toEqual(EXPECTED_SOURCE_PATHS);
		for (const file of fixture.upstreamFiles) {
			expect(file.path).toMatch(
				/^(docs\/sdk\.md|packages\/coding-agent\/(?:package\.json|src\/sdk\/[A-Za-z0-9._/-]+\.ts))$/,
			);
			expect(file.path).not.toContain("..");
			expect(file.byteEncoding).toBe("base64");
			const bytes = Buffer.from(file.bytesBase64, "base64");
			expect(bytes.toString("base64")).toBe(file.bytesBase64);
			expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
		}
		expect(fixtureText).not.toContain("/tmp/");
	});

	test("proves public exports, lifecycle, generic request envelopes, and settlement boundaries", () => {
		const packageJson = source("packages/coding-agent/package.json");
		const sdkIndex = source("packages/coding-agent/src/sdk/index.ts");
		const routerIndex = source("packages/coding-agent/src/sdk/router/index.ts");
		const lifecycleIndex = source("packages/coding-agent/src/sdk/lifecycle/index.ts");
		const lifecycleClient = source("packages/coding-agent/src/sdk/lifecycle/client.ts");
		const lifecycleService = source("packages/coding-agent/src/sdk/lifecycle/service.ts");
		const router = source("packages/coding-agent/src/sdk/router/session-router.ts");
		expect(packageJson).toContain('"./sdk"');
		expect(packageJson).toContain('"./src/sdk/index.ts"');
		expect(sdkIndex).toContain('export * as lifecycle from "./lifecycle"');
		expect(sdkIndex).toContain('export * as router from "./router"');
		expect(routerIndex).toContain('export * from "./session-router"');
		expect(lifecycleIndex).toContain('export * from "./service"');
		expect(lifecycleClient).toContain("createSessionLifecycleService(agentDir: string)");
		expect(lifecycleService).toContain('"session.list"');
		expect(lifecycleService).toContain("continuationCursor");
		expect(router).toContain("async request(");
		expect(router).toContain("beforeDispatch?: (context: SdkDispatchContext) => void");
		expect(router).toContain("onDispatch?: SdkDispatchHandler");
		expect(router).toContain("const { beforeDispatch, onDispatch");
		expect(fixture.apiFacts.routerRequest).toContain("sole settler");
		expect(fixture.apiFacts.query).toContain('type: "query_request"');
		expect(fixture.apiFacts.query).toContain("continuationCursor");
		expect(fixture.apiFacts.terminalCancellation).toContain('operation: "turn.abort"');
		expect(fixture.apiFacts.terminalCancellation).toContain("idempotencyKey: string");
		expect(fixture.apiFacts.terminalCancellation).toContain("uncertain");
		const sdkDocs = source("docs/sdk.md");
		const sessionCli = source("packages/coding-agent/src/sdk/cli/session-cli.ts");
		const controlDispatch = source("packages/coding-agent/src/sdk/host/control/dispatch.ts");
		expect(sdkDocs).toContain("query_request");
		expect(sessionCli).toContain('type: "query_request"');
		expect(sessionCli).toContain('{ type: "control_request", operation, input');
		expect(sessionCli).toContain("throwResponseFailure(response)");
		expect(sessionCli).toContain("continuationCursor");
		expect(controlDispatch).toContain('mode !== "terminal"');
		expect(controlDispatch).toContain('scope !== "turn" && scope !== "owned"');
		expect(controlDispatch).toContain("terminal abort requires a nonempty idempotency key");
	});

	test("source-binds lifecycle authority, idempotency, certainty, external operations, and list failures", () => {
		const service = source("packages/coding-agent/src/sdk/lifecycle/service.ts");
		const client = source("packages/coding-agent/src/sdk/lifecycle/client.ts");
		const list = source("packages/coding-agent/src/sdk/session-list.ts");
		expect(service).toContain("function validActor");
		expect(service).toContain("actor.id");
		expect(service).toContain("actor.namespace");
		expect(service).toContain("function validRequestKey");
		expect(service).toContain("record.capability !== operation");
		expect(service).toContain("deriveSessionLifecycleIdempotencyKey");
		expect(service).toContain('createHash("sha256").update(canonicalJson(identity), "utf8").digest("hex")');
		expect(service).toContain(
			'export type SessionLifecycleCertainty = "terminal" | "retryable" | "cleanup_pending" | "uncertain"',
		);
		expect(service).toContain('if (code === "terminal_uncertain") return "uncertain"');
		expect(service).toContain('if (code === "cleanup_pending") return "cleanup_pending"');
		expect(service).toContain('return "retryable"');
		expect(service).toContain("return { ok: true, operation, result: parsed }");
		expect(service).toContain('failure(operation, "uncertain", "malformed_response"');
		expect(client).toContain("async createExternal(");
		expect(client).toContain("async resumeExternal(");
		expect(client).toContain("validateSessionLifecycleMutationRequest({");
		expect(list).toContain('"malformed_page" | "repeated_cursor" | "page_budget_exceeded"');
		expect(list).toContain('throw new SessionListTraversalError("malformed_page")');
		expect(list).toContain('throw new SessionListTraversalError("repeated_cursor")');
		expect(list).toContain('throw new SessionListTraversalError("page_budget_exceeded")');
	});

	test("proves exact public generationStatus retirement semantics and expiry/reuse protection", () => {
		const router = source("packages/coding-agent/src/sdk/router/session-router.ts");
		const index = source("packages/coding-agent/src/sdk/broker/session-index.ts");
		expect(router).toContain(
			"async generationStatus(sessionId: string, endpointGeneration: number): Promise<SessionGenerationStatus>",
		);
		expect(router).toContain('status: "retired"');
		expect(router).toContain('status: "current"');
		expect(router).toContain('status: "replaced"');
		expect(router).toContain('status: "unknown"');
		expect(router).toContain('source: "session_index"');
		expect(router).toContain("observedIndexSeq: status.observedIndexSeq");
		expect(router).toContain("evidenceIndexSeq: status.evidenceIndexSeq");
		expect(router).toContain('reason: "index_unavailable"');
		expect(router).toContain('reason: "invalid_generation"');
		expect(index).toContain(
			"async generationStatus(sessionId: string, endpointGeneration: number): Promise<SessionGenerationIndexStatus>",
		);
		expect(index).toContain('event: "host_unregistered" | "session_closed" | "session_deleted"');
		expect(index).toContain("currentGeneration: current.endpointGeneration");
		expect(index).toContain("terminalIncarnation !== registrationIncarnation");
		expect(index).toContain("latestExact.pid !== registration.pid");
		expect(index).toContain("locator.stateRoot");
		expect(index).toContain('reason: "proof_expired"');
		expect(index).toContain('reason: "generation_reused"');
		expect(index).toContain('reason: "ambiguous_authority"');
		expect(index).toContain('reason: "reconciliation_incomplete"');
		expect(index).toContain('reason: "index_incomplete"');
		expect(index).toContain('reason: "session_not_observed"');
		expect(index).toContain('reason: "generation_not_observed"');
		expect(fixture.apiFacts.generationStatus).toContain("current, retired, replaced, or unknown");
		expect(fixture.apiFacts.generationStatus).toContain("observedIndexSeq");
		expect(fixture.apiFacts.unknownReasons).toEqual([
			"invalid_generation",
			"index_unavailable",
			"index_incomplete",
			"session_not_observed",
			"generation_not_observed",
			"generation_reused",
			"ambiguous_authority",
			"proof_expired",
			"reconciliation_incomplete",
		]);
		expect(fixture.apiFacts.positiveRetirement).toContain("maxAgeMs");
		expect(fixture.apiFacts.positiveRetirement).toContain("never proves retirement");
		expect(fixture.apiFacts.positiveRetirement).toContain("incarnation, pid, and state root");
		expect(fixture.apiFacts.positiveRetirement).toContain(
			"Reused/ambiguous/incomplete/missing evidence never proves retirement",
		);
	});

	test("retains exclusions and the approved old-to-new disposition", () => {
		expect(fixture.forbiddenImports).toEqual([
			"@gajae-code/bridge-client",
			"@gajae-code/coding-agent/sdk/client",
			"@gajae-code/coding-agent/sdk/acp",
			"@gajae-code/coding-agent/sdk/broker",
		]);
		expect(fixture.forbiddenApi).toEqual(["router.SessionRouter#adoptLifecycleResult"]);
		expect(fixture.disposition).toHaveLength(10);
		expect(fixture.disposition.find(item => item.old === "switchSession")?.new).toContain(
			"no session.switch alias/fallback",
		);
		expect(fixture.disposition.find(item => item.old.startsWith("src/gjc/public-sdk-session-port"))?.new).toContain(
			"remove ./gjc/public-sdk-contract export",
		);
	});

	test("records the built release-shaped dev artifact and Slice 1 exact file dependency", () => {
		expect(fixture.evidence).toEqual([
			{
				id: "upstream-generation-status",
				status: "proven",
				criterion:
					"Exact upstream dev merge exposes public Router generationStatus with positive exact-generation retirement evidence.",
				provenance: "PR #4853 / e3b3a76a590081ded16214a1188857524d40e701",
			},
			{
				id: "release-shaped-dev-artifact",
				status: "proven",
				criterion:
					"A release-shaped package artifact built from the exact dev merge is recorded by vendor filename, SHA-256, npm shasum, full pack integrity, and Slice 1 file dependency.",
				provenance: "vendor/gajae-code-coding-agent-e3b3a76a590081ded16214a1188857524d40e701-8ba25005.tgz",
			},
		]);
		expect(fixture.devArtifact).toEqual({
			path: "vendor/gajae-code-coding-agent-e3b3a76a590081ded16214a1188857524d40e701-8ba25005.tgz",
			sha256: "8ba25005471c66871842cddefcdb98c0118ab26c3890b58f1f93665da524f4cb",
			shasum: "40eca66fa90a933381bdca8be6e404db4088c18f",
			integrity: "sha512-C5wDGvy2KOf+0DQKmo+q7Gi0y8XvUYjgXCZv03lGt+3zd+HPDPjz/Ll/cb6rf6FZPv+tY2AeqqymRlVYjz4HLA==",
			packageName: "@gajae-code/coding-agent",
			packageVersion: "0.15.0",
			build: "release-shaped dist/type generation and published-manifest rewriting from exact dev merge e3b3a76a590081ded16214a1188857524d40e701",
			slice1Dependency:
				"https://raw.githubusercontent.com/snowykr/openwebui-gjc-adapter/c09e31dc85c514cffaf7e44827b47d311620c49f/vendor/gajae-code-coding-agent-e3b3a76a590081ded16214a1188857524d40e701-8ba25005.tgz",
		});
		expect(fixture.devArtifact.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(fixture.devArtifact.shasum).toMatch(/^[a-f0-9]{40}$/);
		expect(fixture.devArtifact.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
		const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { dependencies?: Record<string, string> };
		expect(packageJson.dependencies?.[fixture.devArtifact.packageName]).toBe(fixture.devArtifact.slice1Dependency);
		expect(fixture.devConsumptionPlan.productionActivation).toContain(
			"package.json must use the exact file dependency",
		);
		expect(fixture.devConsumptionPlan.prohibitedClaim).toContain("npm @0.15.0");
	});

	test("agrees with the reviewable document without local source dependencies", () => {
		expect(contractMap).not.toContain("/tmp/");
		for (const section of [
			"provenance",
			"npm",
			"exports",
			"request",
			"generation-status",
			"disposition",
			"forbidden",
			"consumption",
		])
			expect(contractMap).toContain(`<!-- CONTRACT-MAP:${section} -->`);
		for (const value of [
			fixture.evidenceSubject.commit,
			"PR #4853",
			"predates `generationStatus`",
			"generationStatus(sessionId",
			"proof_expired",
			"generation_reused",
			"release-shaped exact dev package artifact",
			fixture.devArtifact.path,
			fixture.devArtifact.sha256,
			fixture.devArtifact.shasum,
			fixture.devArtifact.integrity,
		])
			expect(contractMap).toContain(value);
	});
});
