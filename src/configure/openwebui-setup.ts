import { OPENWEBUI_HEADER_DESCRIPTORS } from "../contracts";
import {
	advanceBootstrapState,
	type BootstrapState,
	type BootstrapStateStore,
	type ExclusiveMaintenanceBoundary,
	withExclusiveMaintenance,
} from "./bootstrap-state";

export interface OpenWebUIHttpClient {
	request<T>(method: string, path: string, body?: unknown, authorization?: string): Promise<T>;
}
export interface OpenWebUIVersionResponse {
	readonly version: string;
}
export interface SignupRequest {
	readonly email: string;
	readonly password: string;
	readonly name: string;
	readonly profile_image_url: string;
}
export interface AuthUser {
	readonly id: string;
	readonly email?: string;
	readonly name?: string;
	readonly role?: string;
}
export interface ApiKeyResponse {
	readonly api_key: string;
}
export interface SessionResponse {
	readonly token?: string;
	readonly access_token?: string;
}
export interface OwnershipMarker {
	readonly schema: 1;
	readonly installationId: string;
}
export interface OpenAIConnectionConfig {
	readonly enable?: boolean;
	readonly prefix_id?: string;
	readonly model_ids?: readonly string[];
	readonly headers?: Readonly<Record<string, string>>;
	readonly openwebui_gjc_adapter?: OwnershipMarker;
	readonly [key: string]: unknown;
}
export interface OpenAIConfigResponse {
	readonly ENABLE_OPENAI_API?: boolean | null;
	readonly OPENAI_API_BASE_URLS: readonly string[];
	readonly OPENAI_API_KEYS: readonly string[];
	readonly OPENAI_API_CONFIGS: Readonly<Record<string, OpenAIConnectionConfig>>;
}
export interface OpenAIConfigUpdateRequest {
	readonly ENABLE_OPENAI_API: boolean;
	readonly OPENAI_API_BASE_URLS: readonly string[];
	readonly OPENAI_API_KEYS: readonly string[];
	readonly OPENAI_API_CONFIGS: Readonly<Record<string, OpenAIConnectionConfig>>;
}
export interface ProviderConnection {
	readonly id: string;
	readonly name?: string;
	readonly url: string;
	readonly key?: string;
	readonly config?: OpenAIConnectionConfig;
}
export const GJC_PROVIDER_OWNERSHIP_SENTINEL = "gjc-adapter";
export const GJC_PROVIDER_OWNERSHIP_HEADER = "X-GJC-Ownership";
export interface OpenWebUISetupInput {
	readonly http: OpenWebUIHttpClient;
	readonly state: BootstrapStateStore;
	readonly maintenance: ExclusiveMaintenanceBoundary;
	readonly adapterUrl: string;
	readonly adapterToken: string;
	readonly adminEmail: string;
	readonly adminPassword: string;
	readonly installationId: string;
	readonly openWebUIApiToken?: string;
	readonly mode?: "managed" | "existing";
	readonly writeCheckpoints?: boolean;
	readonly stopAfter?: "api-key" | "provider";
}
export interface OpenWebUISetupResult {
	readonly state: BootstrapState;
	readonly apiKey: string;
	readonly openAIConnections: readonly ProviderConnection[];
	readonly ownerUserId: string;
}
export const GJC_MODEL_ID = "gjc";
export function buildManagedAdapterUrl(): string {
	return "http://adapter:8765/v1";
}
export function buildExistingAdapterUrl(host: string, port = 8765): string {
	const normalized = host.trim();
	if (!normalized) throw new Error("Adapter host must be non-empty");
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Adapter port must be between 1 and 65535");
	return `http://${normalized}:${port}/v1`;
}

export async function configureOpenWebUI(input: OpenWebUISetupInput): Promise<OpenWebUISetupResult> {
	let existingOwnerUserId: string | undefined;
	let existingToken: string | undefined;
	if (input.mode === "existing") {
		existingToken = input.openWebUIApiToken?.trim();
		if (!existingToken) throw new Error("existing mode requires an OpenWebUI API token");
		const authUser = await input.http.request<AuthUser | AuthUser[]>(
			"GET",
			"/api/v1/auths/",
			undefined,
			existingToken,
		);
		const authenticatedUser = Array.isArray(authUser) ? authUser[0] : authUser;
		existingOwnerUserId = authenticatedUser?.id?.trim();
		if (!existingOwnerUserId) throw new Error("OpenWebUI did not return the authenticated owner user ID");
		if (authenticatedUser?.role?.toLowerCase() !== "admin")
			throw new Error("existing mode requires an OpenWebUI administrator token");
	}
	return withExclusiveMaintenance(input.maintenance, async () => {
		let state = (await input.state.read()) ?? { ...INITIAL_STATE };
		if (!input.installationId.trim()) throw new Error("installationId must be non-empty");
		if (input.mode === "existing") {
			return {
				state,
				apiKey: existingToken as string,
				openAIConnections: [],
				ownerUserId: existingOwnerUserId as string,
			};
		}
		const version = await input.http.request<OpenWebUIVersionResponse>("GET", "/api/version");
		if (!version || !atLeast010(version.version))
			throw new Error(`OpenWebUI ${version?.version ?? "unknown"} is below required v0.10.0`);
		let apiKey = state.apiKeyCreated ? (state.openWebUIApiToken ?? input.openWebUIApiToken) : undefined;
		let sessionToken = !state.apiKeyCreated ? state.openWebUIApiToken : undefined;
		if (!state.apiKeyCreated) {
			if (!sessionToken?.trim()) {
				const session = await input.http.request<SessionResponse>("POST", "/api/v1/auths/signup", {
					email: input.adminEmail,
					password: input.adminPassword,
					name: input.adminEmail,
					profile_image_url: "",
				} satisfies SignupRequest);
				sessionToken = session?.token ?? session?.access_token;
				if (!sessionToken?.trim()) throw new Error("OpenWebUI signup did not return a session token");
				// Keep only the short-lived session credential so an interrupted key
				// request can be retried without signing up the user again.
				state = advanceBootstrapState(state, "bootstrap", {
					bootstrapComplete: state.bootstrapComplete,
					openWebUIApiToken: sessionToken,
				});
				if (input.writeCheckpoints !== false) await input.state.write(state);
			}
			const rawKey = await input.http.request<ApiKeyResponse>(
				"POST",
				"/api/v1/auths/api_key",
				undefined,
				sessionToken,
			);
			apiKey = rawKey?.api_key?.trim();
			if (!apiKey) throw new Error("OpenWebUI did not return an API key");
		}
		if (!apiKey?.trim()) throw new Error("managed mode requires an authenticated API key");
		const authUser = await input.http.request<AuthUser | AuthUser[]>("GET", "/api/v1/auths/", undefined, apiKey);
		const ownerUserId = (Array.isArray(authUser) ? authUser[0]?.id : authUser?.id)?.trim();
		if (!ownerUserId) throw new Error("OpenWebUI did not return the authenticated owner user ID");
		const apiKeyPhase = state.apiKeyCreated ? state.phase : "api-key";
		state = advanceBootstrapState(state, apiKeyPhase, {
			bootstrapComplete: true,
			apiKeyCreated: true,
			ownerUserId,
			openWebUIApiToken: apiKey,
		});
		if (input.writeCheckpoints !== false) await input.state.write(state);
		if (input.stopAfter === "api-key") return { state, apiKey, openAIConnections: [], ownerUserId };
		await readProviderConfig(input.http, input.installationId, apiKey);
		const marker: OwnershipMarker = { schema: 1, installationId: input.installationId };
		const ownedConfig: OpenAIConnectionConfig = {
			enable: true,
			model_ids: [GJC_MODEL_ID],
			headers: buildHeaders(),
			openwebui_gjc_adapter: marker,
		};
		const owned: ProviderConnection = {
			id: "0",
			url: input.adapterUrl,
			key: input.adapterToken,
			config: ownedConfig,
		};
		await writeProviderConfig(input.http, [owned], apiKey);
		const openAIPhase = state.openAIConfigured ? state.phase : "openai";
		state = advanceBootstrapState(state, openAIPhase, { openAIConfigured: true, openAIConnectionIds: ["0"] });
		if (input.writeCheckpoints !== false) await input.state.write(state);
		return { state, apiKey, openAIConnections: [owned], ownerUserId };
	});
}
const HEADER_TOKENS: Readonly<Record<string, string>> = {
	chatId: "{{CHAT_ID}}",
	messageId: "{{MESSAGE_ID}}",
	userMessageId: "{{USER_MESSAGE_ID}}",
	userMessageParentId: "{{USER_MESSAGE_PARENT_ID}}",
	task: "{{TASK}}",
	userId: "{{USER_ID}}",
};
function buildHeaders(): Record<string, string> {
	return Object.fromEntries(
		OPENWEBUI_HEADER_DESCRIPTORS.map(descriptor => [descriptor.name, HEADER_TOKENS[descriptor.field]]),
	);
}
function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
async function readProviderConfig(
	http: OpenWebUIHttpClient,
	installationId: string,
	authorization: string,
): Promise<ProviderConnection[]> {
	const current = await http.request<OpenAIConfigResponse>("GET", "/openai/config", undefined, authorization);
	if (
		!isRecord(current) ||
		!Array.isArray(current.OPENAI_API_BASE_URLS) ||
		!Array.isArray(current.OPENAI_API_KEYS) ||
		!isRecord(current.OPENAI_API_CONFIGS)
	)
		throw new Error("OpenWebUI provider configuration is malformed");
	if (current.OPENAI_API_BASE_URLS.length !== current.OPENAI_API_KEYS.length)
		throw new Error("OpenWebUI provider configuration is malformed");
	const n = current.OPENAI_API_BASE_URLS.length;
	const configs = current.OPENAI_API_CONFIGS;
	if (isPristineDefault(current)) return [];
	if (Object.keys(configs).length !== n || Object.keys(configs).some(key => !/^\d+$/.test(key) || Number(key) >= n))
		throw new Error("OpenWebUI provider configuration is malformed");
	const connections = current.OPENAI_API_BASE_URLS.map((url, index) => {
		const config = configs[String(index)];
		if (
			typeof url !== "string" ||
			!url.trim() ||
			typeof current.OPENAI_API_KEYS[index] !== "string" ||
			!isRecord(config)
		)
			throw new Error("OpenWebUI provider configuration is malformed");
		return {
			id: String(index),
			url,
			key: current.OPENAI_API_KEYS[index],
			config: config as OpenAIConnectionConfig,
		} satisfies ProviderConnection;
	});
	if (connections.length !== 1 || connections[0].id !== "0" || !isOwnedConfig(connections[0].config, installationId))
		throw new Error("OpenWebUI provider configuration is foreign or ownership is invalid");
	return connections;
}
function isPristineDefault(current: OpenAIConfigResponse): boolean {
	return (
		current.ENABLE_OPENAI_API === true &&
		current.OPENAI_API_BASE_URLS.length === 1 &&
		current.OPENAI_API_BASE_URLS[0] === "https://api.openai.com/v1" &&
		current.OPENAI_API_KEYS.length === 1 &&
		current.OPENAI_API_KEYS[0] === "" &&
		Object.keys(current.OPENAI_API_CONFIGS).length === 0
	);
}
function isOwnedConfig(config: OpenAIConnectionConfig, installationId: string): boolean {
	const expected = {
		enable: true,
		model_ids: [GJC_MODEL_ID],
		headers: buildHeaders(),
		openwebui_gjc_adapter: { schema: 1, installationId },
	};
	return JSON.stringify(config) === JSON.stringify(expected);
}
async function writeProviderConfig(
	http: OpenWebUIHttpClient,
	connections: readonly ProviderConnection[],
	authorization: string,
): Promise<void> {
	const body: OpenAIConfigUpdateRequest = {
		ENABLE_OPENAI_API: true,
		OPENAI_API_BASE_URLS: connections.map(c => c.url),
		OPENAI_API_KEYS: connections.map(c => c.key ?? ""),
		OPENAI_API_CONFIGS: Object.fromEntries(connections.map((c, i) => [String(i), c.config ?? {}])),
	};
	await http.request<void>("POST", "/openai/config/update", body, authorization);
	const readback = await http.request<OpenAIConfigResponse>("GET", "/openai/config", undefined, authorization);
	if (JSON.stringify(readback) !== JSON.stringify(body))
		throw new Error("OpenWebUI provider configuration readback did not match update");
}
const INITIAL_STATE: BootstrapState = {
	version: 1,
	phase: "preflight",
	bootstrapComplete: false,
	apiKeyCreated: false,
	openAIConfigured: false,
	routeVerified: false,
	ownershipVerified: false,
	openAIConnectionIds: [],
};
function atLeast010(version: string): boolean {
	const match = /^(\d+)\.(\d+)/.exec(version);
	return match !== null && (Number(match[1]) > 0 || (Number(match[1]) === 0 && Number(match[2]) >= 10));
}
