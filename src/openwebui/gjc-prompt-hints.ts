import { OPENWEBUI_METADATA_NAMESPACE } from "./persistence-contract";

export interface OpenWebUIPromptHint {
	readonly command: string;
	readonly name: string;
	readonly content: string;
	readonly tags: readonly string[];
	readonly meta: Record<string, unknown>;
}

const PROMPT_META = {
	[OPENWEBUI_METADATA_NAMESPACE]: { prompt_hint: true },
} as const;

export const GJC_LEGACY_PROJECT_ADMIN_PROMPT_HINTS: readonly OpenWebUIPromptHint[] = [
	{
		command: "gjc-project-link",
		name: "GJC: Link project folder",
		content: "/gjc project link {{PROJECT_PATH}}",
		tags: ["gjc", "project"],
		meta: {
			...PROMPT_META,
			description: "Link a local folder into OpenWebUI and import its GJC session history.",
		},
	},
	{
		command: "gjc-project-list",
		name: "GJC: List linked project folders",
		content: "/gjc project list",
		tags: ["gjc", "project"],
		meta: {
			...PROMPT_META,
			description: "Show the GJC project folders currently linked into OpenWebUI.",
		},
	},
	{
		command: "gjc-project-unlink",
		name: "GJC: Unlink project folder",
		content: "/gjc project unlink {{PROJECT_ID}}",
		tags: ["gjc", "project"],
		meta: {
			...PROMPT_META,
			description: "Remove a project folder from OpenWebUI display without deleting local GJC history.",
		},
	},
];

export const GJC_OPENWEBUI_PROMPT_HINTS: readonly OpenWebUIPromptHint[] = [
	{
		command: "gjc-skill-deep-interview",
		name: "GJC: Deep interview",
		content: "/skill:deep-interview {{REQUEST}}",
		tags: ["gjc", "workflow"],
		meta: {
			...PROMPT_META,
			description: "Start the GJC deep-interview workflow for clarifying requirements.",
		},
	},
	{
		command: "gjc-skill-ralplan",
		name: "GJC: RAL plan",
		content: "/skill:ralplan {{TASK}}",
		tags: ["gjc", "workflow"],
		meta: {
			...PROMPT_META,
			description: "Start the GJC ralplan workflow for acceptance-driven planning.",
		},
	},
	{
		command: "gjc-skill-ultragoal",
		name: "GJC: Ultragoal",
		content: "/skill:ultragoal {{GOAL}}",
		tags: ["gjc", "workflow"],
		meta: {
			...PROMPT_META,
			description: "Start the GJC ultragoal workflow for goal-bound execution.",
		},
	},
	{
		command: "gjc-skill-team",
		name: "GJC: Team",
		content: "/skill:team {{TASK}}",
		tags: ["gjc", "workflow"],
		meta: {
			...PROMPT_META,
			description: "Start the GJC team workflow for coordinated multi-agent work.",
		},
	},
];

export const GJC_OPENWEBUI_PROMPT_HINT_MARKER = "prompt_hint" as const;
export const GJC_OPENWEBUI_PROMPT_HINT_INSTALLATION_ID_KEYS = ["installation_id", "installationId"] as const;

export function isGjcProjectAdminPromptCommand(command: string): boolean {
	return GJC_LEGACY_PROJECT_ADMIN_PROMPT_HINTS.some(hint => hint.command === command);
}

export function isCanonicalGjcProjectAdminPromptHint(
	hint: Pick<OpenWebUIPromptHint, "command" | "name" | "content">,
): boolean {
	return GJC_LEGACY_PROJECT_ADMIN_PROMPT_HINTS.some(
		canonical =>
			canonical.command === hint.command && canonical.name === hint.name && canonical.content === hint.content,
	);
}
