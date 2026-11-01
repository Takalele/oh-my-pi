/**
 * Drives Google's official `antigravity-acp` binary (the ACP Registry release)
 * as an agent-as-model. omp is a plain ACP *client*: it spawns the unmodified
 * server, opens one ACP session per omp chat session, forwards the latest
 * prompt, and renders the agent's own stream back as omp deltas. This is the
 * only ToS-permitted integration shape — no direct Google API surface, no
 * credential handling on omp's side (the binary owns the Google sign-in).
 *
 * The agent runs its OWN tools (file edits, terminal) inside the session cwd.
 * Those tool calls are rendered as activity summaries, never as omp `toolCall`
 * blocks: the agent loop would otherwise execute them again against omp's tool
 * set (agent-loop.ts gates on toolCall blocks with stop reasons `stop`/
 * `toolUse`). Permission elicits are auto-answered `allow_once` because the
 * AI layer has no approval UI; the binary's own mode setting (default /
 * auto_edit / yolo) is the intended control surface.
 */
import {
	getAntigravityAcpInstall,
	ensureAntigravityProfile,
	connectAntigravityAcp,
	killAntigravityAcpProcess,
	parseAntigravityAcpAuthUrl,
	type AntigravityAcpConnection,
	type AntigravityAcpInstall,
} from "@oh-my-pi/pi-utils/antigravity";
import type { Client, ContentBlock, SessionConfigOption, SessionUpdate } from "@oh-my-pi/pi-utils/acp";
import { logger, VERSION } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	ProviderSessionState,
	StreamFunction,
	StreamOptions,
	TextContent,
} from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";

export const ANTIGRAVITY_ACP_PROVIDER_ID = "antigravity";
export const ANTIGRAVITY_ACP_API = "antigravity-acp";

/** Permission mode requested for the ACP session; maps to the binary's own modes. */
export type AntigravityPermissionMode = "default" | "auto_edit" | "yolo";

export interface AntigravityAcpOptions extends StreamOptions {
	cwd?: string;
	reasoning?: Effort;
	disableReasoning?: boolean;
	/**
	 * Maps onto the binary's advertised session modes. Unset keeps the
	 * server's current mode; approvals that still arrive are auto-allowed
	 * once (see file header).
	 */
	permissionMode?: AntigravityPermissionMode;
}

/** Cancel grace after the caller aborts: ACP cancel, then hard process kill. */
const CANCEL_KILL_GRACE_MS = 5_000;
/** Bound for replaying prior turns on a cold session (chars; ~1 token/char). */
const REPLAY_CHAR_BUDGET = 400_000;
const REPLAY_NOTE =
	"[Context note: this is a fresh Antigravity session. Earlier conversation is replayed below as plain text; tool output from earlier turns is not included.]\n\n";

interface AntigravityAcpStreamState {
	stream: AssistantMessageEventStream;
	output: AssistantMessage;
	activeTextIndex?: number;
	activeThinkingIndex?: number;
}

/** One live ACP session bound to one omp chat session. */
interface AntigravityAcpSession {
	connection: AntigravityAcpConnection;
	install: AntigravityAcpInstall;
	sessionId: string;
	cwd: string;
	configOptions: SessionConfigOption[];
	/** Last wire model id selected through `configOptions`. */
	selectedModelId?: string;
	/** Mode id currently set, when the agent advertises modes. */
	currentModeId?: string;
	/** Latest usage_update snapshot (`used` tokens), fallback when the prompt response omits usage. */
	lastUsedTokens?: number;
	/** Turn currently streaming; session/update notifications route to it. */
	activeTurn?: AntigravityAcpTurn;
	starting?: Promise<void>;
	close(): void;
}

interface AntigravityAcpTurn {
	state: AntigravityAcpStreamState;
	onUpdate(update: SessionUpdate): void;
}

function antigravityAcpProviderSessionStateKey(cwd: string, sessionId: string | undefined): string {
	return `antigravity-acp\u0000${cwd}\u0000${sessionId ?? ""}`;
}

function getProviderSession(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
	cwd: string,
	sessionId: string | undefined,
): AntigravityAcpSession | undefined {
	if (!providerSessionState) return undefined;
	const key = antigravityAcpProviderSessionStateKey(cwd, sessionId);
	return providerSessionState.get(key) as AntigravityAcpSession | undefined;
}

function createProviderSession(
	providerSessionState: Map<string, ProviderSessionState>,
	cwd: string,
	sessionId: string | undefined,
): AntigravityAcpSession {
	const session: AntigravityAcpSession = {
		connection: undefined as unknown as AntigravityAcpConnection,
		install: undefined as unknown as AntigravityAcpInstall,
		sessionId: "",
		cwd,
		configOptions: [],
		close() {
			killProviderSession(session);
			const key = antigravityAcpProviderSessionStateKey(cwd, sessionId);
			providerSessionState.delete(key);
		},
	};
	providerSessionState.set(antigravityAcpProviderSessionStateKey(cwd, sessionId), session);
	return session;
}

function killProviderSession(session: AntigravityAcpSession): void {
	session.activeTurn = undefined;
	try {
		if (session.connection?.child) killAntigravityAcpProcess(session.connection.child);
	} catch (error) {
		logger.debug("Antigravity ACP kill failed", {
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}

/** True when the live process/transport is unusable and must be rebuilt. */
function sessionAlive(session: AntigravityAcpSession): boolean {
	return (
		session.connection?.child !== undefined &&
		session.connection.child.exitCode === null &&
		session.connection.connection.signal.aborted === false &&
		session.sessionId !== ""
	);
}

export const streamAntigravityAcp: StreamFunction<"antigravity-acp"> = (
	model: Model<"antigravity-acp">,
	context: Context,
	options: AntigravityAcpOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const output = createAssistantMessage(model);
	stream.push({ type: "start", partial: output });
	const state: AntigravityAcpStreamState = { stream, output };

	void runAntigravityAcpTurn(model, context, options, state).catch(error => {
		if (!stream.done) {
			output.stopReason = "error";
			output.errorMessage = antigravityAcpErrorText(error);
			stream.push({ type: "error", reason: "error", error: output });
		}
	});

	return stream;
};

async function runAntigravityAcpTurn(
	model: Model<"antigravity-acp">,
	context: Context,
	options: AntigravityAcpOptions,
	state: AntigravityAcpStreamState,
): Promise<void> {
	const cwd = options.cwd ?? process.cwd();
	const pool = options.providerSessionState;
	let session = pool ? getProviderSession(pool, cwd, options.sessionId) : undefined;
	if (session && sessionAlive(session) === false) {
		session.close();
		session = undefined;
	}
	if (!session) {
		if (!pool) {
			// No session pool: a per-request process would churn a full Google
			// sign-in handshake per turn; require the caller to own session state.
			throw new AIError.ConfigurationError(
				"Antigravity requires session-scoped provider state (providerSessionState).",
			);
		}
		session = createProviderSession(pool, cwd, options.sessionId);
	}
	if (!session.starting) {
		const starting = session;
		session.starting = startAntigravityAcpSession(starting, cwd).finally(() => {
			starting.starting = undefined;
		});
	}
	await session.starting;
	if (!sessionAlive(session)) throw new AIError.ConfigurationError("Antigravity ACP session could not start.");

	await applySessionConfig(session, model, options);

	const prompt = buildPromptBlocks(model, context, session);
	const turn = createTurn(state, session);
	session.activeTurn = turn;

	const abort = options.signal;
	let cancelTimer: NodeJS.Timeout | undefined;
	const live = session;
	const onAbort = (): void => {
		// ACP cancel first: the agent finishes its current step and answers the
		// prompt with stopReason "cancelled". The kill is the backstop.
		live.connection.connection.cancel({ sessionId: live.sessionId }).catch(() => {});
		cancelTimer = setTimeout(() => killProviderSession(live), CANCEL_KILL_GRACE_MS);
	};
	abort?.addEventListener("abort", onAbort, { once: true });

	try {
		const response = await live.connection.connection.prompt({
			sessionId: live.sessionId,
			prompt,
		});
		applyUsage(state.output, response.usage, live.lastUsedTokens);
		if (abort?.aborted) {
			finishStream(state, live, "aborted");
			return;
		}
		finishStream(state, live, mapStopReason(response.stopReason));
	} catch (error) {
		if (abort?.aborted) {
			finishStream(state, live, "aborted");
			return;
		}
		// A dead transport mid-prompt means the process is gone; drop it so the
		// next turn rebuilds instead of probing a corpse.
		if (!sessionAlive(live)) live.close();
		throw error;
	} finally {
		clearTimeout(cancelTimer);
		abort?.removeEventListener("abort", onAbort);
		if (live.activeTurn === turn) live.activeTurn = undefined;
	}
}

function createTurn(state: AntigravityAcpStreamState, session: AntigravityAcpSession): AntigravityAcpTurn {
	return {
		state,
		onUpdate(update) {
			switch (update.sessionUpdate) {
				case "agent_message_chunk":
					if (update.content.type === "text") emitText(state, update.content.text);
					return;
				case "agent_thought_chunk":
					if (update.content.type === "text") emitThinking(state, update.content.text);
					return;
				case "tool_call":
				case "tool_call_update":
					// Direction A: the agent executed this itself; render it as an
					// activity line in the thinking lane. Never a toolCall block —
					// the loop would re-execute it against omp tools.
					emitThinking(state, formatToolActivity(update));
					return;
				case "plan": {
					const lines = update.entries.map(entry => `- [${entry.status}] ${entry.content}`).join("\n");
					if (lines) emitThinking(state, `\nPlan:\n${lines}\n`);
					return;
				}
				case "usage_update":
					session.lastUsedTokens = update.used;
					return;
				case "config_option_update":
					session.configOptions = update.configOptions;
					return;
				default:
					return;
			}
		},
	};
}

function formatToolActivity(
	update: Extract<SessionUpdate, { sessionUpdate: "tool_call" | "tool_call_update" }>,
): string {
	const title = update.title?.trim();
	const label = title || update.toolCallId;
	const status = update.status ?? "pending";
	return `\n[${status}] ${label}\n`;
}

/**
 * Spawns + handshakes the binary for `session`. Sign-in state lives in the
 * profile home (the binary owns Google tokens); a signed-out binary fails the
 * authenticate call, surfaced as a configuration error pointing at `/login`.
 */
async function startAntigravityAcpSession(session: AntigravityAcpSession, cwd: string): Promise<void> {
	// No implicit download: the runtime is a ~100 MB third-party binary the
	// operator installs consciously (`omp antigravity install`, run by the
	// `/login antigravity` hook too). Model use without it is a hard error.
	const install = await getAntigravityAcpInstall();
	if (!install) {
		throw new AIError.ConfigurationError(
			"Antigravity ACP binary is not installed. Run `omp antigravity install` first.",
		);
	}
	const profileHome = await ensureAntigravityProfile("oauth-personal");

	let authUrlText = "";
	const connection = await connectAntigravityAcp({
		executablePath: install.executablePath,
		profileHome,
		authType: "oauth-personal",
		workspaceDir: cwd,
		harnessPath: install.harnessPath,
		onAuthText: text => {
			authUrlText += text;
		},
		client: conn => antigravityAcpClient(session, conn),
	});
	session.connection = connection;
	session.install = install;
	session.cwd = cwd;

	const initialized = await connection.connection.initialize({
		protocolVersion: 1,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		clientInfo: { name: "oh-my-pi", title: "oh-my-pi", version: VERSION },
	});

	// The personal sign-in is the only permitted flow; the binary accepts its
	// id even when `initialize` does not list it (API-key/Vertex methods exist
	// but are out of scope here).
	const preferred = initialized.authMethods?.find(method => method.id === "oauth-personal");
	const fallback = initialized.authMethods?.find(method => method.type === undefined || method.type === "agent");
	const methodId = preferred?.id ?? fallback?.id ?? "oauth-personal";
	try {
		await connection.connection.authenticate({ methodId });
	} catch (error) {
		killProviderSession(session);
		const authUrl = authUrlText ? parseAntigravityAcpAuthUrl(authUrlText) : null;
		const hint = authUrl
			? ` The server offered a sign-in link (open it, then run /login antigravity): ${authUrl}`
			: " Run /login antigravity to sign in.";
		throw new AIError.ConfigurationError(`Antigravity sign-in required or failed.${hint}`, { cause: error });
	}

	const created = await connection.connection.newSession({ cwd, mcpServers: [] });
	session.sessionId = created.sessionId;
	session.configOptions = created.configOptions ?? [];
	session.currentModeId = created.modes?.currentModeId;

	connection.exited.then(() => {
		if (session.activeTurn) {
			const state = session.activeTurn.state;
			if (!state.stream.done) {
				state.output.stopReason = "error";
				state.output.errorMessage = "The Antigravity server process exited mid-turn.";
				state.stream.push({ type: "error", reason: "error", error: state.output });
			}
		}
		session.sessionId = "";
	});
}

function antigravityAcpClient(session: AntigravityAcpSession, _conn: unknown): Client {
	return {
		async requestPermission(params) {
			// The binary asked its OWN tools for approval inside our cwd. The AI
			// layer has no approval UI, so honor the least-granting allow option
			// once. `interaction_*` ids are questions, not permissions — refuse
			// gracefully rather than guessing an answer.
			const options = params.options ?? [];
			const isQuestion = String(params.toolCall?.toolCallId ?? "").startsWith("interaction_");
			if (!isQuestion) {
				const allow = options.find(option => option.kind === "allow_once");
				if (allow) return { outcome: { outcome: "selected", optionId: allow.optionId } };
			}
			const reject =
				options.find(option => option.kind === "reject_once") ?? options.find(o => o.kind === "reject_always");
			if (reject) return { outcome: { outcome: "selected", optionId: reject.optionId } };
			return { outcome: { outcome: "cancelled" } };
		},
		sessionUpdate(params) {
			if (params.sessionId !== session.sessionId) return;
			session.activeTurn?.onUpdate(params.update);
		},
	};
}

/** Model + thought-level selection, re-applied every turn (cheap when unchanged). */
async function applySessionConfig(
	session: AntigravityAcpSession,
	model: Model<"antigravity-acp">,
	options: AntigravityAcpOptions,
): Promise<void> {
	if (options.permissionMode && session.currentModeId !== undefined) {
		const wanted = options.permissionMode;
		if (session.currentModeId !== wanted) {
			try {
				await session.connection.connection.setSessionMode({ sessionId: session.sessionId, modeId: wanted });
				session.currentModeId = wanted;
			} catch {
				// Older binaries hide modes behind configOptions; the model/think
				// selects below still apply. Mode is a convenience, not a gate.
			}
		}
	}

	const modelOption = session.configOptions.find(option => option.id === "model" && option.type === "select");
	if (!modelOption || modelOption.type !== "select") return;
	const choices = modelOption.options.map(option => option.value);
	const wanted = resolveAntigravityWireModel(model.id, choices);
	if (wanted === undefined) {
		throw new AIError.ConfigurationError(
			`Antigravity model '${model.id}' is unavailable for this Google account. Pick a model the account serves (check /model).`,
		);
	}
	if (wanted !== session.selectedModelId) {
		const response = await session.connection.connection.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: "model",
			value: wanted,
		});
		session.configOptions = response.configOptions;
		session.selectedModelId = wanted;
	}

	const thinkOption = session.configOptions.find(
		option => option.category === "thought_level" && option.type === "select",
	);
	if (!thinkOption || thinkOption.type !== "select") return;
	const effort = options.reasoning && !options.disableReasoning ? options.reasoning : undefined;
	const fromSku = tierOfModelId(model.id);
	const wantedLevel = pickThinkingLevel(thinkOption, effort ?? fromSku);
	if (wantedLevel !== undefined && wantedLevel !== thinkOption.currentValue) {
		const response = await session.connection.connection.setSessionConfigOption({
			sessionId: session.sessionId,
			configId: thinkOption.id,
			value: wantedLevel,
		});
		session.configOptions = response.configOptions;
	}
}

/**
 * The bundled SKUs carry tier suffixes (`gemini-3.7-flash-high`); runtime 1.4
 * lists the family base (`gemini-3.7-flash`) and controls the tier through the
 * thought_level option instead. Prefer the exact SKU; fall back to the base.
 */
function resolveAntigravityWireModel(modelId: string, choices: readonly string[]): string | undefined {
	if (choices.includes(modelId)) return modelId;
	const tier = tierOfModelId(modelId);
	if (tier) {
		const base = modelId.slice(0, -(tier.length + 1));
		if (choices.includes(base)) return base;
	}
	const family = modelId.replace(/-(low|medium|high|minimal|xhigh|max)$/, "");
	return choices.includes(family) ? family : undefined;
}

function tierOfModelId(modelId: string): "low" | "medium" | "high" | undefined {
	const match = /-(low|medium|high)$/.exec(modelId);
	return match ? (match[1] as "low" | "medium" | "high") : undefined;
}

function pickThinkingLevel(
	option: Extract<SessionConfigOption, { type: "select" }>,
	wanted: string | undefined,
): string | undefined {
	const values = option.options.map(o => o.value);
	if (wanted && values.includes(wanted)) return wanted;
	if (wanted === "minimal" || wanted === "low") return values.includes("low") ? "low" : values[0];
	if (wanted === "xhigh" || wanted === "max") return values.includes("high") ? "high" : values[values.length - 1];
	return undefined;
}

/**
 * Warm session: just the new prompt. Cold session (fresh binary process on a
 * resumed omp chat): replay user/assistant text so the agent has context —
 * its own conversation memory starts empty.
 */
function buildPromptBlocks(
	model: Model<"antigravity-acp">,
	context: Context,
	session: AntigravityAcpSession,
): ContentBlock[] {
	const messages = context.messages;
	const lastUser = findLastUserIndex(messages);
	if (lastUser < 0) {
		throw new AIError.ConfigurationError("Antigravity turn requires a user message.");
	}
	const blocks: ContentBlock[] = [];
	if (session.configOptions.length > 0 && hasPriorTurns(messages, lastUser)) {
		let budget = REPLAY_CHAR_BUDGET - REPLAY_NOTE.length;
		const prior: ContentBlock[] = [];
		for (let i = lastUser - 1; i >= 0 && budget > 0; i--) {
			const rendered = renderHistoryMessage(messages[i]);
			if (!rendered) continue;
			const text = rendered.text.slice(0, budget);
			budget -= rendered.text.length;
			prior.unshift({ type: "text", text });
		}
		blocks.push({ type: "text", text: REPLAY_NOTE });
		blocks.push(...prior);
	}
	const current = messages[lastUser];
	if (typeof current.content === "string") {
		blocks.push({ type: "text", text: current.content });
	} else {
		for (const part of current.content) {
			if (part.type === "text") blocks.push({ type: "text", text: part.text });
			else if (part.type === "image") blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
		}
	}
	return blocks;
}

function findLastUserIndex(messages: readonly Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "user") return i;
	}
	return -1;
}

function hasPriorTurns(messages: readonly Message[], lastUser: number): boolean {
	return messages.slice(0, lastUser).some(message => message.role === "assistant" || message.role === "user");
}

function renderHistoryMessage(message: Message | undefined): { text: string } | undefined {
	if (!message) return undefined;
	if (message.role === "user") {
		if (typeof message.content === "string") {
			return message.content.trim() ? { text: `User: ${message.content}` } : undefined;
		}
		const text = message.content
			.filter(part => part.type === "text")
			.map(part => (part as TextContent).text)
			.join("\n");
		return text.trim() ? { text: `User: ${text}` } : undefined;
	}
	if (message.role === "assistant") {
		const text = message.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.join("\n");
		return text.trim() ? { text: `Assistant: ${text}` } : undefined;
	}
	return undefined;
}

function emitText(state: AntigravityAcpStreamState, text: string): void {
	if (!text) return;
	endThinking(state);
	let index = state.activeTextIndex;
	if (index === undefined) {
		state.output.content.push({ type: "text", text: "" });
		index = state.output.content.length - 1;
		state.activeTextIndex = index;
		state.stream.push({ type: "text_start", contentIndex: index, partial: state.output });
	}
	const block = state.output.content[index];
	if (block?.type !== "text") return;
	block.text += text;
	state.stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: state.output });
}

function emitThinking(state: AntigravityAcpStreamState, thinking: string): void {
	if (!thinking) return;
	endText(state);
	let index = state.activeThinkingIndex;
	if (index === undefined) {
		state.output.content.push({ type: "thinking", thinking: "" });
		index = state.output.content.length - 1;
		state.activeThinkingIndex = index;
		state.stream.push({ type: "thinking_start", contentIndex: index, partial: state.output });
	}
	const block = state.output.content[index];
	if (block?.type !== "thinking") return;
	block.thinking += thinking;
	state.stream.push({ type: "thinking_delta", contentIndex: index, delta: thinking, partial: state.output });
}

function endText(state: AntigravityAcpStreamState): void {
	if (state.activeTextIndex === undefined) return;
	const block = state.output.content[state.activeTextIndex];
	if (block?.type === "text") {
		state.stream.push({
			type: "text_end",
			contentIndex: state.activeTextIndex,
			content: block.text,
			partial: state.output,
		});
	}
	state.activeTextIndex = undefined;
}

function endThinking(state: AntigravityAcpStreamState): void {
	if (state.activeThinkingIndex === undefined) return;
	const block = state.output.content[state.activeThinkingIndex];
	if (block?.type === "thinking") {
		state.stream.push({
			type: "thinking_end",
			contentIndex: state.activeThinkingIndex,
			content: block.thinking,
			partial: state.output,
		});
	}
	state.activeThinkingIndex = undefined;
}

function finishStream(
	state: AntigravityAcpStreamState,
	session: AntigravityAcpSession,
	reason: "stop" | "length" | "aborted",
): void {
	endText(state);
	endThinking(state);
	if (reason === "aborted") {
		state.output.stopReason = "aborted";
		state.stream.push({ type: "error", reason: "aborted", error: state.output });
		return;
	}
	state.output.stopReason = reason;
	state.stream.push({ type: "done", reason, message: state.output });
	// A cancelled/failed turn leaves the ACP session usable; only a dead
	// transport forces a rebuild on the next turn.
	if (!sessionAlive(session)) session.close();
}

function mapStopReason(reason: string): "stop" | "length" {
	return reason === "max_tokens" ? "length" : "stop";
}

function applyUsage(output: AssistantMessage, usage: unknown, lastUsedTokens: number | undefined): void {
	if (usage && typeof usage === "object") {
		const u = usage as {
			inputTokens?: number | null;
			outputTokens?: number | null;
			totalTokens?: number | null;
			cachedReadTokens?: number | null;
			cachedWriteTokens?: number | null;
		};
		const input = u.inputTokens ?? 0;
		const outputTokens = u.outputTokens ?? 0;
		const cacheRead = u.cachedReadTokens ?? 0;
		const cacheWrite = u.cachedWriteTokens ?? 0;
		output.usage = {
			input,
			output: outputTokens,
			cacheRead,
			cacheWrite,
			totalTokens: u.totalTokens ?? input + outputTokens + cacheRead + cacheWrite,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		return;
	}
	if (lastUsedTokens !== undefined) {
		output.usage = {
			...output.usage,
			input: lastUsedTokens,
			totalTokens: lastUsedTokens,
		};
	}
}

function createAssistantMessage(model: Model<"antigravity-acp">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function antigravityAcpErrorText(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
