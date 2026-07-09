import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, symlink } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createOpenWebUIFileContextResolver,
	type OpenWebUIFileContextClient,
} from "../src/openwebui/file-context-resolver";
import type { RegisteredProject } from "../src/projects/registry";

describe("createOpenWebUIFileContextResolver", () => {
	test("materializes original OpenWebUI bytes under the project cache and preserves text fallback", async () => {
		const projectRoot = await mkdtemp(path.join(os.tmpdir(), "openwebui-file-context-"));
		const resolver = createOpenWebUIFileContextResolver(
			fileClient({
				bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
				contentType: "application/pdf",
				content: "fallback extracted text",
				filename: "direct.pdf",
			}),
		);

		const resolved = await resolver({
			reference: { id: "file-1", name: "direct.pdf", type: "application/pdf" },
			project: registeredProject(projectRoot),
			chatId: "chat-1",
			userMessageId: "user-1",
		});

		expect(resolved).toEqual({
			id: "file-1",
			filename: "direct.pdf",
			localPath: path.join(projectRoot, ".gjc/openwebui-attachments/chat-1/user-1/file-1.pdf"),
			content: "fallback extracted text",
		});
		if (resolved?.localPath === undefined) throw new Error("expected local materialized path");
		expect(await readFile(resolved.localPath)).toEqual(Buffer.from([0x25, 0x50, 0x44, 0x46]));
	});

	test("preserves extracted text fallback without a local path when original bytes are missing", async () => {
		const projectRoot = await mkdtemp(path.join(os.tmpdir(), "openwebui-file-context-"));
		const resolver = createOpenWebUIFileContextResolver(
			fileClient({
				content: "fallback extracted text only",
				filename: "direct.pdf",
			}),
		);

		const resolved = await resolver({
			reference: { id: "missing-bytes", name: "direct.pdf", type: "application/pdf" },
			project: registeredProject(projectRoot),
			chatId: "chat-1",
			userMessageId: "user-1",
		});

		expect(resolved).toEqual({
			id: "missing-bytes",
			filename: "direct.pdf",
			content: "fallback extracted text only",
		});
	});

	test("rejects materialization when the attachment cache resolves outside the project", async () => {
		const projectRoot = await mkdtemp(path.join(os.tmpdir(), "openwebui-file-context-"));
		const escapeRoot = await mkdtemp(path.join(os.tmpdir(), "openwebui-file-escape-"));
		await mkdir(path.join(projectRoot, ".gjc"), { recursive: true });
		await symlink(escapeRoot, path.join(projectRoot, ".gjc/openwebui-attachments"), "dir");
		const resolver = createOpenWebUIFileContextResolver(
			fileClient({
				bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
				contentType: "application/pdf",
				content: "fallback extracted text",
				filename: "direct.pdf",
			}),
		);

		await expect(
			resolver({
				reference: { id: "file-1", name: "direct.pdf", type: "application/pdf" },
				project: registeredProject(projectRoot),
				chatId: "chat-1",
				userMessageId: "user-1",
			}),
		).rejects.toThrow("symbolic link");
		expect(await readdir(escapeRoot)).toEqual([]);
	});
});

function registeredProject(cwd: string): RegisteredProject {
	return {
		id: "demo",
		name: "Demo",
		cwd,
		modelId: "gjc/demo",
		allowedRoot: path.dirname(cwd),
		createdAt: new Date("2026-07-09T00:00:00.000Z"),
	};
}

function fileClient(input: {
	readonly bytes?: Uint8Array;
	readonly contentType?: string;
	readonly content: string;
	readonly filename: string;
}): OpenWebUIFileContextClient {
	return {
		async getFileBytes(fileId) {
			if (input.bytes === undefined) return undefined;
			return { id: fileId, bytes: input.bytes, contentType: input.contentType };
		},
		async getFileContent(fileId) {
			return { id: fileId, filename: input.filename, content: input.content };
		},
	};
}
