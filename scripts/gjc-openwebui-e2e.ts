#!/usr/bin/env bun
/// <reference lib="dom" />

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import puppeteer, { type Page } from "puppeteer-core";

const timeoutMs = 120_000;
const openWebUiUrl = process.env.GJC_OPENWEBUI_E2E_URL ?? "http://127.0.0.1:3000";
const model = process.env.GJC_OPENWEBUI_E2E_MODEL;
const screenshotPath = process.env.GJC_OPENWEBUI_E2E_SCREENSHOT ?? "/tmp/gjc-openwebui-smoke.webp";

export function parseSocketIoFrame(payload: string): unknown | undefined {
	const match = payload.match(/^42(?:\/[^,]*,)?(.+)$/s);
	if (!match) return undefined;
	try {
		return JSON.parse(match[1]);
	} catch {
		return undefined;
	}
}

export function assertVisualEvidence(input: { readonly text: string; readonly socketFrames: readonly string[] }): void {
	if (input.text.includes("Server Connection Error")) throw new Error("OpenWebUI reported a server connection error");
	for (const expected of ["Thinking completed", "Tool read started", "Tool read finished"])
		if (!input.text.includes(expected)) throw new Error(`OpenWebUI did not render ${expected}`);
	if (!input.socketFrames.some(frame => parseSocketIoFrame(frame) !== undefined))
		throw new Error("OpenWebUI did not emit a native Socket.IO event frame");
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

async function selectModel(page: Page, selectedModel: string): Promise<void> {
	await page.goto(openWebUiUrl, { waitUntil: "networkidle2", timeout: timeoutMs });
	const picker = await page.$('button[id^="model-selector-"][id$="-button"]');
	if (!picker) throw new Error("OpenWebUI model picker is unavailable");
	await picker.click();
	await page.waitForSelector("#model-search-input", { timeout: timeoutMs });
	await page.locator("#model-search-input").fill(selectedModel);
	await page.waitForFunction(
		value =>
			Array.from(document.querySelectorAll<HTMLButtonElement>('button[role="option"]')).some(
				option => option.dataset.value === value,
			),
		{ timeout: timeoutMs },
		selectedModel,
	);
	const options = await page.$$('button[role="option"]');
	const option = (
		await Promise.all(
			options.map(async candidate =>
				(await candidate.evaluate(element => element.dataset.value)) === selectedModel ? candidate : undefined,
			),
		)
	).find(Boolean);
	if (!option) throw new Error(`OpenWebUI model option is unavailable: ${selectedModel}`);
	await option.click();
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
		page.setDefaultTimeout(timeoutMs);
		const cdp = await page.createCDPSession();
		const socketFrames: string[] = [];
		await cdp.send("Network.enable");
		cdp.on("Network.webSocketFrameReceived", event => socketFrames.push(event.response.payloadData));
		page.on("response", async response => {
			if (!response.url().includes("/socket.io/")) return;
			const payload = await response.text().catch(() => "");
			for (const packet of payload.split("\u001e")) {
				const offset = packet.indexOf("42[");
				if (offset >= 0) socketFrames.push(packet.slice(offset));
			}
		});
		await login(page);
		await selectModel(page, model);
		await page
			.locator("#chat-input")
			.fill(
				process.env.GJC_OPENWEBUI_E2E_PROMPT ??
					"Use the read tool on package.json, then reply with the package name. Do not skip the tool call.",
			);
		await page.focus("#chat-input");
		await page.keyboard.press("Enter");
		await page.waitForFunction(
			'!document.body.innerText.includes("Server Connection Error") && document.body.innerText.includes("Thinking completed") && document.body.innerText.includes("Tool read finished")',
			{ timeout: timeoutMs },
		);
		const history = await page.$('button[aria-label="Toggle status history"]');
		if (history && (await history.evaluate(element => element.getAttribute("aria-expanded"))) !== "true")
			await history.click();
		const text = await page.evaluate(() => document.body.innerText);
		assertVisualEvidence({ text, socketFrames });
		await mkdir(dirname(screenshotPath), { recursive: true });
		await page.screenshot({ path: screenshotPath, type: "webp", fullPage: true });
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
