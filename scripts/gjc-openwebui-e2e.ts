#!/usr/bin/env bun
/// <reference lib="dom" />

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import puppeteer, { type Page } from "puppeteer-core";

const timeoutMs = 120_000;
const openWebUiUrl = process.env.GJC_OPENWEBUI_E2E_URL ?? "http://127.0.0.1:8080";
const model = process.env.GJC_OPENWEBUI_E2E_MODEL;
const screenshotPath = process.env.GJC_OPENWEBUI_E2E_SCREENSHOT ?? "/tmp/gjc-openwebui-smoke.webp";
const transcriptPath = process.env.GJC_OPENWEBUI_E2E_TRANSCRIPT;
const sourceHash = process.env.GJC_OPENWEBUI_E2E_SOURCE_HASH?.trim();
const expectedModelLabel = process.env.GJC_OPENWEBUI_E2E_EXPECTED_MODEL_LABEL?.trim();

export function parseSocketIoFrame(payload: string): unknown | undefined {
	const match = payload.match(/^42(?:\/[^,]*,)?(.+)$/s);
	if (!match) return undefined;
	try {
		return JSON.parse(match[1]);
	} catch {
		return undefined;
	}
}
export function matchesModelOption(optionValue: string | undefined, selectedModel: string): boolean {
	if (optionValue === selectedModel) return true;
	const suffix = `.${selectedModel}`;
	if (optionValue === undefined || !optionValue.endsWith(suffix)) return false;
	return /^[A-Za-z0-9_-]+$/.test(optionValue.slice(0, -suffix.length));
}
export function isOpenWebUiEventFrame(payload: string): boolean {
	const event = parseSocketIoFrame(payload);
	return Array.isArray(event) && event[0] === "events";
}
export function acceptedChatId(response: Readonly<{ status: number; body: string }>): string | undefined {
	if (response.status < 200 || response.status >= 300) return undefined;
	try {
		const value: unknown = JSON.parse(response.body);
		if (
			!value ||
			typeof value !== "object" ||
			!("status" in value) ||
			value.status !== true ||
			!("chat_id" in value) ||
			typeof value.chat_id !== "string" ||
			value.chat_id.length === 0 ||
			!("task_ids" in value) ||
			!Array.isArray(value.task_ids) ||
			value.task_ids.length === 0 ||
			!value.task_ids.every(taskId => typeof taskId === "string" && taskId.length > 0)
		)
			return undefined;
		return value.chat_id;
	} catch {
		return undefined;
	}
}
export function isOpenWebUiEventFrameForChat(payload: string, chatId: string): boolean {
	const event = parseSocketIoFrame(payload);
	if (!Array.isArray(event) || event[0] !== "events") return false;
	const detail = event[1];
	return detail !== null && typeof detail === "object" && "chat_id" in detail && detail.chat_id === chatId;
}
export function modelSearchTerm(selectedModel: string): string {
	const separator = selectedModel.lastIndexOf("/");
	const thinkingLevel = selectedModel.lastIndexOf(":");
	if (separator < 0 || thinkingLevel <= separator + 1) return selectedModel;
	try {
		return decodeURIComponent(selectedModel.slice(separator + 1, thinkingLevel));
	} catch {
		return selectedModel;
	}
}

export function assertVisualEvidence(input: {
	readonly text: string;
	readonly socketFrames: readonly string[];
	readonly completionResponses: readonly { readonly status: number; readonly body: string }[];
	readonly chatId: string;
	readonly currentAssistantText: string;
	readonly expectedResponseText: string;
	readonly toolReadFinishedCount: number;
}): void {
	if (input.text.includes("Server Connection Error")) throw new Error("OpenWebUI reported a server connection error");
	if (!input.completionResponses.some(response => acceptedChatId(response) === input.chatId))
		throw new Error("OpenWebUI did not accept the submitted chat request");
	if (!input.currentAssistantText.includes(input.expectedResponseText))
		throw new Error(`OpenWebUI did not render the expected response: ${input.expectedResponseText}`);
	if (input.toolReadFinishedCount === 0)
		throw new Error("OpenWebUI did not record Tool read finished for the submitted turn");
	if (!input.socketFrames.some(frame => isOpenWebUiEventFrameForChat(frame, input.chatId)))
		throw new Error("OpenWebUI did not emit a post-submit events Socket.IO frame for the submitted chat");
}
export function sourceHashFromGitState(input: {
	readonly head: string;
	readonly indexTree: string;
	readonly stagedDiff: string;
	readonly unstagedDiff: string;
}): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}

function gitOutput(args: readonly string[]): Buffer {
	const result = spawnSync("git", args, { cwd: process.cwd(), encoding: "buffer" });
	if (result.error || result.status !== 0) throw new Error("Unable to calculate the current source hash");
	return Buffer.from(result.stdout);
}

function currentSourceState(): { readonly hash: string; readonly head: string; readonly indexTree: string } {
	const untracked = gitOutput(["ls-files", "--others", "--exclude-standard", "-z"]);
	if (untracked.length > 0) throw new Error("Cannot record a source hash with untracked files");
	const head = gitOutput(["rev-parse", "HEAD"]).toString("utf8").trim();
	const indexTree = gitOutput(["write-tree"]).toString("utf8").trim();
	return {
		hash: sourceHashFromGitState({
			head,
			indexTree,
			stagedDiff: gitOutput(["diff", "--cached", "--binary"]).toString("base64"),
			unstagedDiff: gitOutput(["diff", "--binary"]).toString("base64"),
		}),
		head,
		indexTree,
	};
}

function browserExecutable(): string {
	for (const candidate of [
		process.env.GJC_TRUSTED_CHROMIUM_EXECUTABLE,
		"/usr/bin/google-chrome",
		"/usr/bin/chromium",
	].filter((value): value is string => Boolean(value)))
		if (candidate.startsWith("/") && existsSync(candidate)) return candidate;
	throw new Error("Chrome or Chromium executable is unavailable");
}

async function login(page: Page): Promise<void> {
	await page.goto(`${openWebUiUrl}/auth`, { waitUntil: "networkidle2", timeout: timeoutMs });
	if (!(await page.$('input[type="email"]'))) {
		await page.goto(openWebUiUrl, { waitUntil: "networkidle2", timeout: timeoutMs });
		return;
	}
	const email = process.env.GJC_OPENWEBUI_E2E_EMAIL;
	const password = process.env.GJC_OPENWEBUI_E2E_PASSWORD;
	if (!email || !password) throw new Error("OpenWebUI credentials are required when authentication is enabled");
	await page.locator('input[type="email"]').fill(email);
	await page.locator('input[type="password"]').fill(password);
	await page.locator('button[type="submit"]').click();
	await page.waitForFunction('!location.pathname.startsWith("/auth")', { timeout: timeoutMs });
}
async function dismissReleaseNotes(page: Page): Promise<void> {
	const releaseNotes = await page.evaluate(() => {
		const visible = document.body.innerText.includes("What's New in Open WebUI");
		const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(candidate =>
			candidate.textContent?.includes("Okay, Let's Go!"),
		);
		if (visible && !button) throw new Error("OpenWebUI release-notes dialog cannot be dismissed");
		button?.click();
		return button !== undefined;
	});
	if (releaseNotes)
		await page.waitForFunction(() => !document.body.innerText.includes("What's New in Open WebUI"), {
			timeout: timeoutMs,
		});
	if (await page.evaluate(() => document.body.innerText.includes("What's New in Open WebUI")))
		throw new Error("OpenWebUI release-notes dialog remains visible");
}

async function selectModel(
	page: Page,
	selectedModel: string,
	expectedLabel?: string,
): Promise<{ readonly value: string; readonly label: string }> {
	await page.goto(openWebUiUrl, { waitUntil: "networkidle2", timeout: timeoutMs });
	await dismissReleaseNotes(page);
	await page.waitForSelector('button[id^="model-selector-"][id$="-button"]', { timeout: timeoutMs });
	await dismissReleaseNotes(page);
	const picker = await page.$('button[id^="model-selector-"][id$="-button"]');
	if (!picker) throw new Error("OpenWebUI model picker is unavailable");
	await picker.click();
	let modelSearchSelector: string | undefined;
	for (const selector of [
		"#model-search-input",
		'input[aria-label="Search In Models"]',
		'input[placeholder="Search a model"]',
	])
		if (await page.$(selector)) {
			modelSearchSelector = selector;
			break;
		}
	if (modelSearchSelector) await page.locator(modelSearchSelector).fill(modelSearchTerm(selectedModel));
	await page.waitForFunction(
		value =>
			Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="option"]')).some(option => {
				if (value === option.dataset.value) return true;
				const suffix = `.${value}`;
				if (!option.dataset.value?.endsWith(suffix)) return false;
				return /^[A-Za-z0-9_-]+$/.test(option.dataset.value.slice(0, -suffix.length));
			}),
		{ timeout: timeoutMs },
		selectedModel,
	);
	if (expectedLabel)
		await page.waitForFunction(
			({ label, value }) =>
				Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="option"]')).some(option => {
					if (option.textContent?.includes(label) !== true) return false;
					if (value === option.dataset.value) return true;
					const suffix = `.${value}`;
					if (!option.dataset.value?.endsWith(suffix)) return false;
					return /^[A-Za-z0-9_-]+$/.test(option.dataset.value.slice(0, -suffix.length));
				}),
			{ timeout: timeoutMs },
			{ label: expectedLabel, value: selectedModel },
		);
	const options = await page.$$('button[role="option"]');
	const option = (
		await Promise.all(
			options.map(async candidate =>
				matchesModelOption(await candidate.evaluate(element => element.dataset.value), selectedModel)
					? candidate
					: undefined,
			),
		)
	).find(Boolean);
	if (!option) throw new Error(`OpenWebUI model option is unavailable: ${selectedModel}`);
	const selectedOption = await option.evaluate(element => ({
		value: element.dataset.value ?? "",
		label: element.textContent?.trim() ?? "",
	}));
	if (!matchesModelOption(selectedOption.value, selectedModel))
		throw new Error(`OpenWebUI selected an unexpected model option: ${selectedOption.value}`);
	if (expectedLabel && selectedOption.label !== expectedLabel)
		throw new Error(`OpenWebUI did not render the expected model label: ${expectedLabel}`);
	await option.click();
	await page.waitForFunction(
		value =>
			Array.from(document.querySelectorAll<HTMLButtonElement>('button[id^="model-selector-"][id$="-button"]')).some(
				button => button.textContent?.includes(value),
			),
		{ timeout: timeoutMs },
		modelSearchTerm(selectedModel),
	);
	await new Promise(resolve => setTimeout(resolve, 1_000));
	return selectedOption;
}
async function waitForCurrentAssistantText(
	page: Page,
	chatId: string,
	expectedResponseText: string,
): Promise<{ readonly text: string; readonly toolReadFinishedCount: number }> {
	const result = await page.waitForFunction(
		async ({ chatId, expectedResponseText }) => {
			const response = await fetch(`/api/v1/chats/${encodeURIComponent(chatId)}`);
			if (!response.ok) return null;
			const value: unknown = await response.json();
			const isRecord = (candidate: unknown): candidate is Record<string, unknown> =>
				candidate !== null && typeof candidate === "object";
			if (!isRecord(value) || !isRecord(value.chat) || !isRecord(value.chat.history)) return null;
			const { history } = value.chat;
			if (typeof history.currentId !== "string" || !isRecord(history.messages)) return null;
			const message = history.messages[history.currentId];
			if (!isRecord(message) || message.role !== "assistant" || typeof message.content !== "string") return null;
			const statusHistory = Array.isArray(message.statusHistory) ? message.statusHistory : [];
			const toolReadFinishedCount = statusHistory.filter(
				status => isRecord(status) && status.description === "Tool read finished",
			).length;
			return message.content.includes(expectedResponseText)
				? { text: message.content, toolReadFinishedCount }
				: null;
		},
		{ timeout: timeoutMs },
		{ chatId, expectedResponseText },
	);
	const assistant: unknown = await result.jsonValue();
	if (
		typeof assistant !== "object" ||
		assistant === null ||
		typeof Reflect.get(assistant, "text") !== "string" ||
		typeof Reflect.get(assistant, "toolReadFinishedCount") !== "number"
	)
		throw new Error("OpenWebUI did not return an assistant message for the submitted chat");
	return {
		text: Reflect.get(assistant, "text") as string,
		toolReadFinishedCount: Reflect.get(assistant, "toolReadFinishedCount") as number,
	};
}

export async function runVisualSmoke(): Promise<void> {
	if (!model) throw new Error("GJC_OPENWEBUI_E2E_MODEL is required");
	const browser = await puppeteer.launch({
		executablePath: browserExecutable(),
		headless: true,
		protocolTimeout: timeoutMs,
		args: ["--no-sandbox"],
	});
	try {
		const page = await browser.newPage();
		await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
		page.setDefaultTimeout(timeoutMs);
		const cdp = await page.createCDPSession();
		const socketFrames: string[] = [];
		const completionRequestModels: string[] = [];
		const completionResponses: Array<{ status: number; body: string }> = [];
		const submittedCompletionRequests = new WeakSet<object>();
		let captureSubmittedRequest = false;
		let captureSocketFrames = false;
		let resolveCompletionResponse: (() => void) | undefined;
		await cdp.send("Network.enable");
		cdp.on("Network.webSocketFrameReceived", event => {
			if (captureSocketFrames) socketFrames.push(event.response.payloadData);
		});
		page.on("request", request => {
			if (!new URL(request.url()).pathname.endsWith("/api/chat/completions") || !captureSubmittedRequest) return;
			submittedCompletionRequests.add(request);
			try {
				const body: unknown = JSON.parse(request.postData() ?? "");
				if (body && typeof body === "object" && "model" in body && typeof body.model === "string")
					completionRequestModels.push(body.model);
			} catch {
				// The response status and body remain the authoritative result evidence.
			}
		});
		page.on("response", response => {
			if (
				!new URL(response.url()).pathname.endsWith("/api/chat/completions") ||
				!submittedCompletionRequests.has(response.request())
			)
				return;
			void response
				.text()
				.then(body => completionResponses.push({ status: response.status(), body }))
				.catch(() => completionResponses.push({ status: response.status(), body: "" }))
				.finally(() => resolveCompletionResponse?.());
		});
		const actions: Array<Record<string, string>> = [];
		await login(page);
		actions.push({ type: "goto", timestamp: new Date().toISOString(), url: `${openWebUiUrl}/auth` });
		const expectedVersion = process.env.GJC_OPENWEBUI_E2E_EXPECTED_VERSION?.trim();
		if (process.env.GJC_OPENWEBUI_E2E_EXPECTED_VERSION !== undefined && !expectedVersion)
			throw new Error("GJC_OPENWEBUI_E2E_EXPECTED_VERSION must be non-empty");
		if (process.env.GJC_OPENWEBUI_E2E_SOURCE_HASH !== undefined && !sourceHash)
			throw new Error("GJC_OPENWEBUI_E2E_SOURCE_HASH must be non-empty");
		if (process.env.GJC_OPENWEBUI_E2E_EXPECTED_MODEL_LABEL !== undefined && !expectedModelLabel)
			throw new Error("GJC_OPENWEBUI_E2E_EXPECTED_MODEL_LABEL must be non-empty");
		const observedVersion = await page.evaluate(async () => {
			const response = await fetch("/api/version");
			if (!response.ok) throw new Error(`OpenWebUI version endpoint returned ${response.status}`);
			const value: unknown = await response.json();
			if (!value || typeof value !== "object" || !("version" in value) || typeof value.version !== "string")
				throw new Error("OpenWebUI version endpoint returned an invalid payload");
			return value.version;
		});
		if (expectedVersion && observedVersion !== expectedVersion)
			throw new Error(`OpenWebUI version mismatch: expected ${expectedVersion}, received ${observedVersion}`);
		if (transcriptPath && (!expectedVersion || !sourceHash || !expectedModelLabel))
			throw new Error("Hash-bound transcript requires expected OpenWebUI version, source hash, and model label");
		const currentSource = sourceHash === undefined ? undefined : currentSourceState();
		if (sourceHash && currentSource?.hash !== sourceHash)
			throw new Error(`Source hash mismatch: expected ${sourceHash}, received ${currentSource?.hash}`);
		const selectedModelOption = await selectModel(page, model, expectedModelLabel);
		actions.push({
			type: "select-model",
			timestamp: new Date().toISOString(),
			selector: 'button[role="option"]',
			value: selectedModelOption.value,
			label: selectedModelOption.label,
		});
		const prompt =
			process.env.GJC_OPENWEBUI_E2E_PROMPT ??
			"Use the read tool on package.json, then reply with the package name. Do not skip the tool call.";
		const expectedResponseText = process.env.GJC_OPENWEBUI_E2E_EXPECTED_TEXT ?? "openwebui-gjc-adapter";
		if (!expectedResponseText.trim()) throw new Error("GJC_OPENWEBUI_E2E_EXPECTED_TEXT must be non-empty");
		await page.locator("#chat-input").fill(prompt);
		actions.push({ type: "fill", timestamp: new Date().toISOString(), selector: "#chat-input" });
		await page.focus("#chat-input");
		socketFrames.length = 0;
		completionRequestModels.length = 0;
		completionResponses.length = 0;
		captureSubmittedRequest = true;
		captureSocketFrames = true;
		const completionResponse = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("OpenWebUI did not complete the submitted chat request")),
				timeoutMs,
			);
			resolveCompletionResponse = () => {
				clearTimeout(timer);
				resolve();
			};
		});
		await page.keyboard.press("Enter");
		actions.push({ type: "press", timestamp: new Date().toISOString(), selector: "#chat-input" });
		await completionResponse;
		captureSubmittedRequest = false;
		if (
			completionRequestModels.length === 0 ||
			completionRequestModels.some(requestedModel => !matchesModelOption(requestedModel, model))
		)
			throw new Error(
				`OpenWebUI did not submit only the canonical model ID or one connection-prefixed form: ${model}`,
			);
		const chatId = completionResponses.map(acceptedChatId).find((value): value is string => value !== undefined);
		if (chatId === undefined) throw new Error("OpenWebUI did not accept the submitted chat request");
		const assistant = await waitForCurrentAssistantText(page, chatId, expectedResponseText);
		captureSocketFrames = false;
		const text = await page.evaluate(() => document.body.innerText);
		assertVisualEvidence({
			text,
			socketFrames,
			completionResponses,
			chatId,
			currentAssistantText: assistant.text,
			expectedResponseText,
			toolReadFinishedCount: assistant.toolReadFinishedCount,
		});
		await mkdir(dirname(screenshotPath), { recursive: true });
		await page.screenshot({
			path: screenshotPath,
			type: screenshotPath.endsWith(".png") ? "png" : "webp",
			fullPage: true,
		});
		if (transcriptPath) {
			await mkdir(dirname(transcriptPath), { recursive: true });
			await writeFile(
				transcriptPath,
				`${JSON.stringify(
					{
						schemaVersion: 1,
						surface: "web",
						tool: "puppeteer-core",
						targetUrl: openWebUiUrl,
						observedVersion,
						expectedVersion,
						model,
						expectedResponseText,
						expectedModelLabel,
						sourceHash,
						sourceCommit: currentSource?.head,
						sourceIndexTree: currentSource?.indexTree,
						chatId,
						socketEventFramesAfterSubmit: socketFrames.length,
						socketEventFramesForSubmittedChat: socketFrames.filter(frame =>
							isOpenWebUiEventFrameForChat(frame, chatId),
						).length,
						chatCompletionModelsAfterSubmit: completionRequestModels,
						chatCompletionResponseStatusesAfterSubmit: completionResponses.map(response => response.status),
						currentAssistantText: assistant.text,
						selectedModelOption,
						toolReadFinishedCount: assistant.toolReadFinishedCount,
						actions,
						assertions: [
							{
								timestamp: new Date().toISOString(),
								selector: "body, button[role=option], /api/chat/completions",
								status: "passed",
								description: `Selected ${selectedModelOption.label} with canonical value ${selectedModelOption.value}; submitted ${model}; rendered and received ${expectedResponseText}, Tool read finished, and a Socket.IO event.`,
							},
						],
					},
					null,
					2,
				)}\n`,
			);
		}
		process.stdout.write(`${screenshotPath}\n`);
	} finally {
		await browser.close();
	}
}

if (import.meta.main)
	runVisualSmoke().catch(error => {
		console.error(error instanceof Error ? (error.stack ?? error.message) : error);
		process.exitCode = 1;
	});
