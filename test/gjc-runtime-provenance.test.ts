import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeTmux, exitAndObservePostCloseFailure } from "../scripts/gjc-release-compat-lifecycle";

const ROOT = join(import.meta.dir, "..");
const GJC_VERSION = "0.11.6";
const BUN_IMAGE_DIGEST = "sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4";
const PYTHON_IMAGE_DIGEST = "sha256:8a7e7cc04fd3e2bd787f7f24e22d5d119aa590d429b50c95dfe12b3abe52f48b";

function normalizeRelease(version: string, nativesVersion: string, tag = "") {
	const versionPattern = /^v?\d+\.\d+\.\d+$/;
	if (!versionPattern.test(version) || !versionPattern.test(nativesVersion)) throw new Error("invalid version");
	const normalizedVersion = version.replace(/^v/, "");
	if (nativesVersion.replace(/^v/, "") !== normalizedVersion) throw new Error("mismatched natives");
	const normalizedTag = tag || `v${normalizedVersion}`;
	if (normalizedTag !== `v${normalizedVersion}`) throw new Error("invalid tag");
	return { version: normalizedVersion, nativesVersion: normalizedVersion, tag: normalizedTag };
}
function releaseRoute(event: "repository_dispatch" | "schedule" | "workflow_dispatch", version = "") {
	if (event === "repository_dispatch") return "dispatched-repository";
	if (event === "workflow_dispatch" && version !== "") return "dispatched-manual";
	return "fixed";
}

describe("GJC SDK runtime provenance", () => {
	test("pins all published GJC runtime packages to the current exact release", async () => {
		const manifest = await Bun.file(join(ROOT, "package.json")).json();
		const dependencies = Reflect.get(manifest, "dependencies");

		for (const packageName of [
			"@gajae-code/ai",
			"@gajae-code/bridge-client",
			"@gajae-code/coding-agent",
			"@gajae-code/natives",
		])
			expect(Reflect.get(dependencies, packageName)).toBe(GJC_VERSION);
		expect(Reflect.get(manifest, "patchedDependencies")).toBeUndefined();
		expect(Reflect.get(manifest, "files")).not.toContain("patches");
	});

	test("installs and invokes the released CLI from the production dependency tree", async () => {
		const dockerfile = await Bun.file(join(ROOT, "Dockerfile.adapter")).text();

		expect(dockerfile).toContain("COPY package.json bun.lock ./");
		expect(dockerfile).toContain("bun install --frozen-lockfile --production");
		expect(dockerfile).toContain(
			'gjc_version="$(bun --no-env-file --config=/dev/null ./node_modules/.bin/gjc --version)"',
		);
		expect(dockerfile).toContain(`gjc_version="\${gjc_version#gjc/}"`);
		expect(dockerfile).toContain(`test "$gjc_version" = "${GJC_VERSION}"`);
		expect(dockerfile.match(/org\.opencontainers\.image\.version="[^"]+"/g)).toEqual([
			`org.opencontainers.image.version="${GJC_VERSION}"`,
		]);
		expect(dockerfile).not.toContain("0.11.2");
		expect(dockerfile).toContain("GJC_OPENWEBUI_GJC_COMMAND=/opt/openwebui-gjc-adapter/node_modules/.bin/gjc");
		expect(dockerfile).not.toContain("/opt/gajae-code");
		expect(dockerfile).not.toContain("git fetch");
		expect(dockerfile).not.toContain("git apply");
		expect(dockerfile).not.toContain("packages/natives");
		expect(dockerfile).not.toContain("GJC_UPSTREAM_COMMIT");
	});

	test("keeps pinned base images and runs as a non-root adapter user", async () => {
		const dockerfile = await Bun.file(join(ROOT, "Dockerfile.adapter")).text();

		expect(dockerfile).toContain(`FROM oven/bun:1.3.14@${BUN_IMAGE_DIGEST} AS bun-runtime`);
		expect(dockerfile).toContain(`FROM python:3.12-slim-bookworm@${PYTHON_IMAGE_DIGEST}`);
		expect(dockerfile).toContain("COPY --from=bun-runtime /usr/local/bin/bun /opt/bun/bin/bun");
		expect(dockerfile).toContain(`LABEL org.opencontainers.image.version="${GJC_VERSION}"`);
		expect(dockerfile).toContain("/usr/sbin/groupadd --system --gid 10001 adapter");
		expect(dockerfile).toContain("/usr/sbin/useradd --system --uid 10001 --gid adapter");
		expect(dockerfile).toContain("USER adapter:adapter");
	});

	test("normalizes manual versions and structurally routes release lanes", async () => {
		const workflow = await Bun.file(join(ROOT, ".github/workflows/gjc-release-compat.yml")).text();
		const reusable = await Bun.file(join(ROOT, ".github/workflows/gjc-release-compat-run.yml")).text();

		for (const fixture of [
			{
				version: "0.11.6",
				nativesVersion: "0.11.6",
				tag: "",
				expected: { version: "0.11.6", nativesVersion: "0.11.6", tag: "v0.11.6" },
			},
			{
				version: "v0.11.6",
				nativesVersion: "v0.11.6",
				tag: "v0.11.6",
				expected: { version: "0.11.6", nativesVersion: "0.11.6", tag: "v0.11.6" },
			},
		])
			expect(normalizeRelease(fixture.version, fixture.nativesVersion, fixture.tag)).toEqual(fixture.expected);
		expect(() => normalizeRelease("0.11.6", "0.11.2", "v0.11.6")).toThrow();
		expect(() => normalizeRelease("0.11.6", "0.11.6", "v0.11.2")).toThrow();
		for (const fixture of [
			{ event: "schedule" as const, version: "", route: "fixed" },
			{ event: "workflow_dispatch" as const, version: "", route: "fixed" },
			{ event: "workflow_dispatch" as const, version: "v0.11.6", route: "dispatched-manual" },
			{ event: "repository_dispatch" as const, version: "", route: "dispatched-repository" },
		])
			expect(releaseRoute(fixture.event, fixture.version)).toBe(fixture.route);

		expect(workflow).toContain("types: [gajae-code-release]");
		expect(workflow).toContain("fixed-compatibility:");
		expect(workflow).toContain("dispatched-repository-compatibility:");
		expect(workflow).toContain("dispatched-manual-compatibility:");
		expect(workflow).toContain(
			"if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.version == '')",
		);
		expect(workflow).toContain("if: github.event_name == 'repository_dispatch'");
		expect(workflow).toContain("if: github.event_name == 'workflow_dispatch' && inputs.version != ''");
		expect(workflow).toContain(`version: \${{ inputs.version }}`);
		expect(workflow).toContain(`natives_version: \${{ inputs.version }}`);
		expect(workflow).toContain(`commit: \${{ inputs.commit || github.sha }}`);
		expect(workflow).toContain("- lane: v0.11.1-pair");
		expect(workflow).toContain("- lane: v0.11.2-pair");
		expect(workflow).toContain("- lane: v0.11.4-pair");
		expect(workflow).toContain("- lane: v0.11.4-pair\n            version: 0.11.4\n            tag: v0.11.4");
		expect(workflow).toContain(`natives_version: \${{ matrix.version }}`);
		expect(workflow).not.toMatch(/^\s+if:.*\bmatrix\./m);

		expect(reusable).toContain("on:\n  workflow_call:");
		expect(reusable).toContain('[[ "$INPUT_VERSION" =~ $version_pattern ]]');
		expect(reusable).toContain(`version="\${INPUT_VERSION#v}"`);
		expect(reusable).toContain(`natives_version="\${INPUT_NATIVES_VERSION#v}"`);
		expect(reusable).toContain(`tag="\${INPUT_TAG:-v$version}"`);
		expect(reusable).toContain('[[ "$tag" = "v$version" ]]');
		expect(reusable).toContain('[[ "$INPUT_COMMIT" =~ $sha_pattern ]]');
		expect(reusable).toContain('if [[ "$INPUT_TRIGGER" = repository_dispatch ]]; then');
		expect(reusable).toContain('test -n "$INPUT_NATIVES_VERSION"');
		expect(reusable).toContain("bun install --frozen-lockfile --ignore-scripts");
		expect(reusable).toContain(
			'cp scripts/gjc-release-compat.ts scripts/gjc-release-compat-fixtures.ts scripts/gjc-release-compat-lifecycle.ts scripts/gjc-release-compat-runtime.ts scripts/gjc-release-compat-sdk.ts "$compat_root/"',
		);
		expect(reusable).toContain(`cli_version_pattern='^(gjc/)?([0-9]+\\.[0-9]+\\.[0-9]+)$'`);
		expect(reusable).toContain(`cli_version="\${BASH_REMATCH[2]}"`);
		expect(reusable).toContain('[[ "$cli_version" = "$GJC_CODING_AGENT_VERSION" ]]');
		expect(reusable).toContain("def sanitize(value, key=");
		expect(reusable).toContain('"adapter": {');
		expect(reusable).toContain('"upstream": {');
		expect(reusable).toContain("ADAPTER_REPOSITORY");
		expect(reusable).toContain("operation-report.json");
		expect(reusable).not.toContain("bun update");
		expect(reusable).not.toContain("git apply");
	});

	test("records actual SDK responses through split SDK, runtime, and lifecycle harnesses", async () => {
		const runner = await Bun.file(join(ROOT, "scripts/gjc-release-compat.ts")).text();
		const sdk = await Bun.file(join(ROOT, "scripts/gjc-release-compat-sdk.ts")).text();
		const runtime = await Bun.file(join(ROOT, "scripts/gjc-release-compat-runtime.ts")).text();
		const lifecycle = await Bun.file(join(ROOT, "scripts/gjc-release-compat-lifecycle.ts")).text();
		const fixtures = await Bun.file(join(ROOT, "scripts/gjc-release-compat-fixtures.ts")).text();

		expect(runner).toContain('from "./gjc-release-compat-sdk"');
		expect(runner).toContain('from "./gjc-release-compat-runtime"');
		expect(runner).toContain('from "./gjc-release-compat-lifecycle"');
		expect(runner).toContain('client!.query("session.metadata")');
		expect(runner).toContain('client!.query("workflow.gates.list")');
		expect(runner).toContain('client!.query("models.list/current")');
		expect(runner).toContain('client!.control("model.set"');
		expect(runner).toContain('client!.control("thinking.set"');
		expect(runner).toContain("push({ name, shape: shapeOf(value), observed: value })");
		expect(runner).toContain('Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: providerResponse })');
		expect(fixtures).toContain("providers:\n  compat-local:");
		expect(runner).toMatch(/"--model",\s*"compat-local\/hermetic-model"/);
		expect(runner).not.toContain("promptInteractive");
		expect(runner).not.toContain("--op");

		expect(sdk).toContain("SdkClient.connect(endpoint.url, endpoint.token");
		expect(sdk).toContain("client.control(operation, input");
		expect(sdk).toContain("snapshotPublicEndpoints(workspace)");
		expect(sdk).toContain("endpointFingerprint(previous) !== endpointFingerprint(endpoint)");
		expect(sdk).toContain("session.metadata");
		expect(sdk).toContain("targetSessionId: requestedSessionId");

		expect(runtime).toContain('client.control("turn.prompt", { text })');
		expect(runtime).toContain('probe.query("session.branch_candidates")');
		expect(runtime).toContain("rediscoverSessionId");
		expect(runtime).toContain("client.onFrame(frame =>");
		expect(runtime).toContain('frame.type !== "agent_end" && frame.type !== "agent_failed"');
		expect(runtime).toContain("matches(frame, pendingCorrelation!)");
		expect(runtime).toContain("pendingFrames.push(frame)");
		expect(runtime).toContain('send-keys", "-t", target, "/session", "Enter"');

		expect(lifecycle).toContain('phase: "sdkLogicalClose"');
		expect(lifecycle).toContain('phase: "cliLifecycleTermination"');
		expect(lifecycle).toContain("postAcknowledgement:");
		expect(lifecycle).toContain("tmuxTargetLive: live");
		expect(lifecycle).toContain("awaitLifecycleTermination(");
		expect(lifecycle).toContain('action: "/exit"');
		expect(lifecycle).toContain('send-keys", "-t", target, "/exit", "Enter"]);');
		expect(lifecycle).toContain("tmuxTargetAbsent: true");
		expect(lifecycle).toContain("tmuxPanePid(tmuxTarget)");
		expect(lifecycle).toContain("const originalPanePid = await tmuxPanePid(tmuxTarget);");
		expect(lifecycle).toContain("postAcknowledgementPanePid !== originalPanePid");
		expect(lifecycle).toContain("originalPanePidLive");
		expect(lifecycle).toContain("endpoint: { descriptor: endpoint.descriptor, fingerprint, originalPanePid },");
		expect(lifecycle).toContain("originalPanePidAbsent: true");
		expect(lifecycle).toContain("process.kill(pid, 0)");
		expect(runner).toContain('awaitTmuxTermination(resumedTarget, "resumed compatibility tmux session")');
		expect(lifecycle).toContain('phase: "gracefulTmuxTermination"');
		expect(runner).toContain("observed.cleanup = { forcedTmuxSessions: [] };");
		expect(runner).not.toContain("forbiddenFallbacks:");
	});

	test("allows broad tmux cleanup only before public close invocation", async () => {
		const runner = await Bun.file(join(ROOT, "scripts/gjc-release-compat.ts")).text();
		const lifecycle = await Bun.file(join(ROOT, "scripts/gjc-release-compat-lifecycle.ts")).text();
		const commands: string[][] = [];
		const run = async (_command: string, args: readonly string[]) => {
			commands.push([...args]);
			return args[0] === "list-sessions" ? "gjc-compat-before\nunrelated\n" : "";
		};

		expect(await closeTmux("gjc-compat-", run)).toEqual(["gjc-compat-before"]);
		expect(commands).toContainEqual(["kill-session", "-t", "gjc-compat-before"]);
		commands.length = 0;
		const evidence = await exitAndObservePostCloseFailure("/unused", undefined, "gjc-compat-after", run);
		expect(commands).toEqual([["send-keys", "-t", "gjc-compat-after", "/exit", "Enter"]]);
		expect(evidence).toMatchObject({
			phase: "postCloseFailureCleanup",
			action: "/exit",
			uncertainty: { reason: "exact endpoint identity unavailable" },
		});

		const publicCloseInvokedAt = runner.indexOf("publicCloseInvoked = true;");
		const publicCloseAt = runner.indexOf("closeWithPublicSdkProof", publicCloseInvokedAt);
		const guardedCleanupAt = runner.indexOf("observed.cleanup = publicCloseInvoked");
		const postCloseCleanupAt = runner.indexOf(
			"postClose: await exitAndObservePostCloseFailure(workspace, sdkLogicalClose?.endpoint, tmuxSession, run)",
			guardedCleanupAt,
		);
		const prePublicCloseBranchAt = runner.indexOf(": { forcedTmuxSessions:", postCloseCleanupAt);
		const broadCleanupAt = runner.indexOf("await closeTmux(tmuxSession, run)", prePublicCloseBranchAt);
		expect(publicCloseInvokedAt).toBeGreaterThan(0);
		expect(publicCloseAt).toBeGreaterThan(publicCloseInvokedAt);
		expect(guardedCleanupAt).toBeGreaterThan(publicCloseAt);
		expect(postCloseCleanupAt).toBeGreaterThan(guardedCleanupAt);
		expect(prePublicCloseBranchAt).toBeGreaterThan(postCloseCleanupAt);
		expect(broadCleanupAt).toBeGreaterThan(prePublicCloseBranchAt);
		expect(lifecycle).toContain('phase: "postCloseFailureCleanup"');
	});
	test("parses released /session surfaces and strict released CLI version output, then conditions startup flags by probed version", async () => {
		const runner = await Bun.file(join(ROOT, "scripts/gjc-release-compat.ts")).text();
		const runtime = await Bun.file(join(ROOT, "scripts/gjc-release-compat-runtime.ts")).text();
		const parseSessionBootstrap = (output: string) => ({
			sessionId: /(?:^|\n)\s*(?:ID|Session ID)\s*:\s*([^\s]+)\s*$/im.exec(output)?.[1],
			sessionFile: /(?:^|\n)\s*File\s*:\s*(\S(?:.*\S)?)\s*$/im.exec(output)?.[1],
		});
		const startupArguments = (version: string) =>
			version === "0.11.1"
				? ["--model", "compat-local/hermetic-model"]
				: ["--model", "compat-local/hermetic-model", "--thinking", "off"];
		const parseReleasedCliVersion = (output: string) => {
			const match = /^(?:gjc\/)?(\d+\.\d+\.\d+)$/.exec(output.trim());
			if (match === null) throw new Error("invalid version");
			return match[1];
		};

		expect(parseSessionBootstrap("Session Info\nFile: /tmp/sessions/alpha.jsonl\nID: alpha-123\n")).toEqual({
			sessionId: "alpha-123",
			sessionFile: "/tmp/sessions/alpha.jsonl",
		});
		expect(parseSessionBootstrap("Sessions dashboard\nSession ID: beta-456\n")).toEqual({
			sessionId: "beta-456",
			sessionFile: undefined,
		});
		expect(startupArguments("0.11.1")).not.toContain("--thinking");
		expect(startupArguments("0.11.6")).toEqual(["--model", "compat-local/hermetic-model", "--thinking", "off"]);
		expect(parseReleasedCliVersion("gjc/0.11.1\n")).toBe("0.11.1");
		expect(parseReleasedCliVersion("0.11.6\n")).toBe("0.11.6");
		expect(() => parseReleasedCliVersion("gjc/0.11.1 extra")).toThrow("invalid version");
		expect(runner).toContain("const match = /^(?:gjc\\/)?(\\d+\\.\\d+\\.\\d+)$/.exec(output);");
		expect(runner).toContain('await run(command, ["--version"])');
		expect(runner).toContain('version === "0.11.1" ? arguments_ : [...arguments_, "--thinking", "off"]');
		expect(runtime).toContain('output.includes("Sessions dashboard")');
		expect(runtime).toContain(
			'output.includes("Session Info") && bootstrap.sessionId !== undefined && bootstrap.sessionFile !== undefined',
		);
		expect(runtime).toContain(
			"const sessionFile = /(?:^|\\n)\\s*File\\s*:\\s*(\\S(?:.*\\S)?)\\s*$/im.exec(output)?.[1];",
		);
		expect(runner).toContain('if (thinkingSupported) await observe("thinking.set"');
	});
	test("cites the structural scanner as a separate artifact without fabricating runtime observation", async () => {
		const runner = await Bun.file(join(ROOT, "scripts/gjc-release-compat.ts")).text();

		expect(runner).toContain(
			"Static source contract artifact: \\`test/gjc-sdk-v3-contract.test.ts\\` (separate test artifact; not observed by this runtime harness).",
		);
		expect(runner).not.toContain("structuralFallbackEvidence");
		expect(runner).not.toContain("passed-by-test");
	});
});
