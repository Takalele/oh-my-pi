/**
 * Runtime model discovery for the `antigravity` provider.
 *
 * There is no HTTP model-listing endpoint: the model roster lives in the
 * official `antigravity-acp` binary's `configOptions` (the same select the
 * binary shows every ACP client, e.g. the `acp agy` picker). Discovery is
 * therefore a plain ACP handshake against the installed binary: spawn it,
 * authenticate (no-op when the binary is already signed in — the binary owns
 * the Google tokens), open one throwaway session, and read the `model`
 * select plus the `thought_level` select off `session/new`.
 *
 * ToS compliance mirrors the provider: only the unmodified official binary is
 * driven, sign-in state is never read by omp, and the reported roster is
 * exactly what the official client surfaces for that account.
 *
 * A missing install, a signed-out binary, or an uncooperative handshake all
 * yield `null` so the manager keeps the bundled rows instead of an empty
 * authoritative roster.
 */
import {
	connectAntigravityAcp,
	withAntigravityAcpLease,
	type AntigravityAcpConnection,
	ensureAntigravityProfile,
	type AntigravityAcpInstall,
	getAntigravityAcpInstall,
} from "@oh-my-pi/pi-utils/antigravity";
import type { SessionConfigOption } from "@oh-my-pi/pi-utils/acp";
import { logger, VERSION } from "@oh-my-pi/pi-utils";
import { Effort } from "../effort";
import type { ModelSpec, ThinkingConfig } from "../types";

/** The personal sign-in is the only permitted flow (matches the provider). */
const ANTIGRAVITY_ACP_AUTH_METHOD = "oauth-personal";
/** Seed base url; discovery rows must match the bundled rows' endpoint. */
const ANTIGRAVITY_ACP_DISCOVERY_BASE_URL = "https://antigravity.google";
/**
 * Bound on the whole handshake. A signed-in binary answers `authenticate`
 * immediately; a signed-out one blocks it until a browser flow completes, so
 * discovery must not wait on it — startup model resolution would stall.
 */
const DISCOVERY_HANDSHAKE_TIMEOUT_MS = 15_000;
/** Plan-included models: the binary reports no per-token pricing. */
const PLAN_COST: ModelSpec<"antigravity-acp">["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** The binary serves 1M-context Gemini lanes for every plan SKU. */
const ANTIGRAVITY_CONTEXT_WINDOW = 1_000_000;

/** thought_level wire values mapped onto catalog efforts (unknown values dropped). */
const EFFORT_BY_THOUGHT_LEVEL: Readonly<Partial<Record<string, Effort>>> = {
	minimal: Effort.Minimal,
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};

/** Options for one discovery pass. */
export interface AntigravityAcpDiscoveryOptions {
	/** Working directory for the throwaway ACP session. Default: process.cwd(). */
	cwd?: string;
	/** Handshake timeout override (tests). */
	handshakeTimeoutMs?: number;
}

function selectOption(
	options: readonly SessionConfigOption[],
	id: string,
): Extract<SessionConfigOption, { type: "select" }> | undefined {
	const found = options.find(option => option.type === "select" && option.id === id);
	return found?.type === "select" ? found : undefined;
}

/** thought_level options by id; the binary names it `thinking_level` with category `thought_level`. */
function thoughtLevelOption(
	options: readonly SessionConfigOption[],
): Extract<SessionConfigOption, { type: "select" }> | undefined {
	const byCategory = options.find(option => option.category === "thought_level" && option.type === "select");
	if (byCategory?.type === "select") return byCategory;
	return selectOption(options, "thinking_level");
}

/** Ordered, de-duplicated efforts from the select's wire values (wire order = least → most). */
function effortsFromThoughtLevels(values: readonly string[]): Effort[] {
	const efforts: Effort[] = [];
	for (const value of values) {
		const effort = EFFORT_BY_THOUGHT_LEVEL[value.trim().toLowerCase()];
		if (effort !== undefined && !efforts.includes(effort)) efforts.push(effort);
	}
	return efforts;
}

/**
 * One row per `model` select choice. Both roster shapes the binaries ship are
 * consumed as-is: tiered SKUs (`gemini-3.7-flash-high`) and family bases
 * (`gemini-3.7-flash`, tier picked via thought_level at request time — the
 * provider's `resolveAntigravityWireModel` already handles either).
 */
function specFromChoice(
	option: { value: string; name: string; description?: string | null },
	thinking: ThinkingConfig | undefined,
): ModelSpec<"antigravity-acp"> {
	const id = option.value.trim();
	const spec: ModelSpec<"antigravity-acp"> = {
		id,
		name: option.name.trim() || id,
		api: "antigravity-acp",
		provider: "antigravity",
		baseUrl: ANTIGRAVITY_ACP_DISCOVERY_BASE_URL,
		reasoning: thinking !== undefined,
		input: ["text"],
		supportsTools: true,
		cost: PLAN_COST,
		contextWindow: ANTIGRAVITY_CONTEXT_WINDOW,
		maxTokens: null,
	};
	if (thinking) spec.thinking = thinking;
	const description = option.description?.trim();
	if (description) spec.description = description;
	return spec;
}

/**
 * Reads the live model roster from the installed binary. Returns `null` (keep
 * bundled rows) when the runtime is absent, signed out, or too slow to answer.
 */
export async function fetchAntigravityAcpModels(
	options: AntigravityAcpDiscoveryOptions = {},
): Promise<readonly ModelSpec<"antigravity-acp">[] | null> {
	const install = await getAntigravityAcpInstall();
	if (!install) return null;
	const profileHome = await ensureAntigravityProfile("oauth-personal");
	const cwd = options.cwd ?? process.cwd();
	const timeoutMs = options.handshakeTimeoutMs ?? DISCOVERY_HANDSHAKE_TIMEOUT_MS;

	// Same in-process lease the sign-in and install flows take: discovery
	// must not spawn a binary that `omp antigravity update` is replacing.
	return withAntigravityAcpLease(() => runDiscoveryHandshake(install, profileHome, cwd, timeoutMs));
}

async function runDiscoveryHandshake(
	install: AntigravityAcpInstall,
	profileHome: string,
	cwd: string,
	timeoutMs: number,
): Promise<readonly ModelSpec<"antigravity-acp">[] | null> {
	let connection: AntigravityAcpConnection | undefined;
	try {
		connection = await connectAntigravityAcp({
			executablePath: install.executablePath,
			profileHome,
			authType: "oauth-personal",
			workspaceDir: cwd,
			harnessPath: install.harnessPath,
			client: () => ({
				async requestPermission(params) {
					const reject = params.options.find(option => option.kind === "reject_once");
					return reject
						? { outcome: { outcome: "selected", optionId: reject.optionId } }
						: { outcome: { outcome: "cancelled" } };
				},
				sessionUpdate() {},
			}),
		});
		const conn = connection.connection;
		const handshake = (async () => {
			await conn.initialize({
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				clientInfo: { name: "oh-my-pi", title: "oh-my-pi", version: VERSION },
			});
			await conn.authenticate({ methodId: ANTIGRAVITY_ACP_AUTH_METHOD });
			return conn.newSession({ cwd, mcpServers: [] });
		})();
		const timer = Promise.withResolvers<never>();
		const timeoutHandle = setTimeout(
			() => timer.reject(new Error(`Antigravity discovery handshake exceeded ${timeoutMs}ms`)),
			timeoutMs,
		);
		const created = await Promise.race([handshake, timer.promise]).finally(() => clearTimeout(timeoutHandle));

		const configOptions = created.configOptions ?? [];
		const modelOption = selectOption(configOptions, "model");
		if (!modelOption || modelOption.options.length === 0) {
			logger.debug("Antigravity discovery: binary advertises no model select", {
				options: configOptions.map(option => option.id),
			});
			return null;
		}
		const levelOption = thoughtLevelOption(configOptions);
		const efforts = levelOption ? effortsFromThoughtLevels(levelOption.options.map(option => option.value)) : [];
		const thinking: ThinkingConfig | undefined = efforts.length > 0 ? { mode: "google-level", efforts } : undefined;
		return modelOption.options.map(option => specFromChoice(option, thinking));
	} catch (error) {
		// Signed-out, vanished install, or slow handshake: the bundled roster
		// is the fallback, and `/login antigravity` remains the way in.
		logger.debug("Antigravity discovery unavailable; keeping bundled models", {
			reason: error instanceof Error ? error.message : String(error),
		});
		return null;
	} finally {
		if (connection) {
			connection.kill();
			const grace = Promise.withResolvers<void>();
			setTimeout(grace.resolve, 3_000);
			await Promise.race([connection.exited, grace.promise]);
		}
	}
}
