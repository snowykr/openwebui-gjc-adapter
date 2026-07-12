import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildPendingRecoveryLinkage,
	INITIAL_BOOTSTRAP_STATE,
	parseBootstrapState,
	resetBootstrapState,
} from "../src/configure/bootstrap-state";
import { runConfigureCommand } from "../src/configure/configure-command";
import { captureDurableDeploymentSnapshot } from "../src/configure/durable-deployment-snapshot";
import type { DeploymentLifecycle } from "../src/configure/installed-cli-contracts";
import { type InstalledConfig, readInstalledConfig, writeInstalledConfig } from "../src/configure/private-config";
import { createProductionDeployment } from "../src/configure/production-deployment";

const roots: string[] = [];
const fileDescriptors: number[] = [];
afterEach(() => {
	for (const fd of fileDescriptors.splice(0)) closeSync(fd);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "gjc-recovery-locations-"));
	roots.push(root);
	const path = join(root, "config.json");
	const prior: InstalledConfig = {
		version: 1,
		mode: "existing",
		installationId: "install",
		adapterToken: "adapter",
		readinessToken: "readiness",
		openWebUIApiToken: "prior-token",
		openWebUIApiUrl: "http://openwebui.test",
		adapterProviderUrl: "http://adapter.test/v1",
		bindHost: "127.0.0.1",
		bindPort: 8765,
		projectRoot: join(root, "prior-project"),
		gjcConfigDirName: ".prior-gjc",
		gjcCodingAgentDir: join(root, "prior-agent"),
	};
	writeInstalledConfig(prior, path);
	return { root, path, prior };
}

function lifecycle(events: string[]): DeploymentLifecycle {
	return {
		managed: async () => {
			events.push("managed");
			return { completed: true, mode: "managed" };
		},
		existing: async () => {
			events.push("existing");
			return { completed: true, mode: "existing" };
		},
		reset: async () => {
			events.push("reset");
			return { completed: true, mode: "reset" };
		},
	};
}

function production(path: string) {
	return createProductionDeployment({ path, parseState: parseBootstrapState, resetState: resetBootstrapState });
}

function secretFd(root: string): number {
	const path = join(root, `secret-${crypto.randomUUID()}`);
	writeFileSync(path, "retry-token\n");
	const fd = openSync(path, "r");
	fileDescriptors.push(fd);
	return fd;
}

function targetPending(f: ReturnType<typeof fixture>) {
	const pending = {
		version: 1 as const,
		mode: "existing" as const,
		priorMode: "existing" as const,
		installationId: f.prior.installationId,
		transactionId: "transaction",
		adapterToken: f.prior.adapterToken,
		readinessToken: f.prior.readinessToken,
		targetUrl: f.prior.openWebUIApiUrl,
		providerUrl: f.prior.adapterProviderUrl,
		uiPort: 8080,
		bindPort: f.prior.bindPort,
		projectRoot: join(f.root, "target-project"),
		gjcConfigDirName: ".target-gjc",
		gjcCodingAgentDir: join(f.root, "target-agent"),
		priorControllerEnabled: false,
		priorControllerActive: false,
		controllerRecoveryRequired: false,
		controllerQuiesced: false,
		linkage: "",
	};
	return { ...pending, linkage: buildPendingRecoveryLinkage(pending) };
}

function stagePending(f: ReturnType<typeof fixture>): void {
	const pending = targetPending(f);
	const configHome = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
	captureDurableDeploymentSnapshot(f.path, join(configHome, "systemd", "user"), pending.transactionId);
	writeFileSync(
		`${f.path}.bootstrap.json`,
		`${JSON.stringify({ ...INITIAL_BOOTSTRAP_STATE, pendingRecovery: pending })}\n`,
		{ mode: 0o600 },
	);
}

function request(f: ReturnType<typeof fixture>, events: string[], fields: Record<string, string | boolean>) {
	return runConfigureCommand({
		mode: "existing",
		options: {
			"openwebui-url": f.prior.openWebUIApiUrl,
			"adapter-ingress-url": f.prior.adapterProviderUrl,
			"openwebui-api-token-fd": String(secretFd(f.root)),
			...fields,
		},
		path: f.path,
		dependencies: { deployment: lifecycle(events) },
		production: production(f.path),
		confirmReset: async () => true,
	});
}

describe("pending recovery runtime-location authority", () => {
	test("uses explicit fields before same-mode prior fields on a clean configure", async () => {
		const f = fixture();
		const events: string[] = [];
		await request(f, events, { "gjc-config-dir-name": ".explicit-gjc" });
		expect(readInstalledConfig(f.path)).toMatchObject({
			gjcConfigDirName: ".explicit-gjc",
			gjcCodingAgentDir: f.prior.gjcCodingAgentDir,
		});
		expect(events).toEqual(["existing"]);
	});

	test("resumes omitted retry fields from authoritative pending identity", async () => {
		const f = fixture();
		stagePending(f);
		const capturedPrior = Buffer.from(readFileSync(f.path)).toString("base64");
		expect(readFileSync(`${f.path}.recovery.json`, "utf8")).toContain(capturedPrior);
		const events: string[] = [];
		await request(f, events, {});
		expect(readInstalledConfig(f.path)).toMatchObject({
			gjcConfigDirName: ".target-gjc",
			gjcCodingAgentDir: join(f.root, "target-agent"),
		});
		expect(events).toEqual(["existing"]);
	});

	for (const conflict of [
		{
			field: "gjc-config-dir-name",
			value: ".conflict-gjc",
			message: "pending recovery --gjc-config-dir-name does not match retry input",
		},
		{
			field: "gjc-coding-agent-dir",
			value: "/conflict-agent",
			message: "pending recovery --gjc-coding-agent-dir does not match retry input",
		},
	] as const) {
		test(`rejects ${conflict.field} conflict before mutation or deployment`, async () => {
			const f = fixture();
			stagePending(f);
			const before = {
				config: readFileSync(f.path),
				bootstrap: readFileSync(`${f.path}.bootstrap.json`),
				recovery: readFileSync(`${f.path}.recovery.json`),
			};
			const events: string[] = [];
			await expect(
				request(f, events, { [conflict.field]: conflict.value, reset: true, "reset-proof": "proof" }),
			).rejects.toThrow(conflict.message);
			expect(readFileSync(f.path)).toEqual(before.config);
			expect(readFileSync(`${f.path}.bootstrap.json`)).toEqual(before.bootstrap);
			expect(readFileSync(`${f.path}.recovery.json`)).toEqual(before.recovery);
			expect(events).toEqual([]);
		});
	}
});
