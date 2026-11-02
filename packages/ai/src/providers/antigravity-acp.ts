/**
 * Drives Google's official `antigravity-acp` binary (the ACP Registry release)
 * as an agent-as-model. omp is a plain ACP *client*: it spawns the unmodified
 * server, opens one ACP session per omp chat session, forwards the latest
 * prompt, and renders the agent's own stream back as omp deltas. This is the
 * only ToS-permitted integration shape — no direct Google API surface, no
 * credential handling on omp's side (the binary owns the Google sign-in).
 *
 * The agent runs its OWN tools (file edits, terminal) inside the session cwd.
 * Their `tool_call`/`tool_call_update` notifications become real `toolCall`
 * content blocks stamped `kCursorExecResolved` — the same carrier Cursor's
 * server-side exec channel uses — so the transcript and TUI render them as
 * ordinary tool cards while `agent-loop.ts` skips execution (the binary
 * already performed the side effect; running it again would double-apply it).
 * The paired `toolResult` message is built from the update's `rawOutput` and
 * routed through `onToolResult`, exactly like Cursor's exec results.
 * Permission elicits are auto-answered `allow_once` because the
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
import { editDiffString } from "@oh-my-pi/pi-natives";
import type { Client, ContentBlock, SessionConfigOption, SessionUpdate, ToolCallUpdate } from "@oh-my-pi/pi-utils/acp";
import { logger, VERSION } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type {
	AssistantMessage,
	Context,
	CursorToolResultHandler,
	Message,
	Model,
	ProviderSessionState,
	StreamFunction,
	StreamOptions,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types";
import { kCursorExecResolved } from "../utils/block-symbols";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
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
	/**
	 * Pairs each mirrored toolCall block with its synthesized toolResult —
	 * the same sink the Agent stamps on provider calls for server-executed
	 * tools (`streamSimple` fills it from `SimpleStreamOptions.cursorOnToolResult`).
	 */
	cursorOnToolResult?: CursorToolResultHandler;
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
	/** toolCallId → mirrored toolCall block awaiting completion/pairing. */
	blocks: Map<string, TrackedToolBlock>;
	/**
	 * `pending` frames held back without a block: in approval mode the binary
	 * first echoes the call it is about to ask permission for (same
	 * `toolCallId` as the `session/request_permission` request). Mirroring
	 * that echo would show a card for a call that may never run; the
	 * execution frames that follow create the block and inherit its diff.
	 * Auto-approved runs execute under a DIFFERENT id (`<session>:N`) with
	 * no diff/rawInput on their frames, so echoes are additionally indexed
	 * by kind+target (command line or path) and seed those cards instead.
	 * `echoIds` remembers every echoed id: a terminal frame for an id whose
	 * call was mirrored under another id (or denied) must not open a second
	 * card.
	 */
	pendingFrames: Map<string, ToolFrame>;
	pendingByTarget: Map<string, ToolFrame>;
	echoIds: Set<string>;
	/** Pairs each mirrored block with a synthesized toolResult (Cursor-exec path). */
	onToolResult?: CursorToolResultHandler;
	onUpdate(update: SessionUpdate): void;
	/** Close + pair blocks left unfinished when the turn ends without their status. */
	flushUnfinished(): void;
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
	const turn = createTurn(state, session, options);
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
			finishStream(state, live, turn, "aborted");
			return;
		}
		finishStream(state, live, turn, mapStopReason(response.stopReason));
	} catch (error) {
		if (abort?.aborted) {
			finishStream(state, live, turn, "aborted");
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

function createTurn(
	state: AntigravityAcpStreamState,
	session: AntigravityAcpSession,
	options: AntigravityAcpOptions,
): AntigravityAcpTurn {
	const byId = new Map<string, TrackedToolBlock>();
	const pending = new Map<string, ToolFrame>();
	const pendingByTarget = new Map<string, ToolFrame>();
	const echoIds = new Set<string>();
	const turn: AntigravityAcpTurn = {
		state,
		blocks: byId,
		pendingFrames: pending,
		pendingByTarget,
		echoIds,
		onToolResult: options.cursorOnToolResult,
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
					// Direction B: the binary already executed this tool in our
					// cwd. Mirror it as a real toolCall block stamped
					// `kCursorExecResolved` (the Cursor server-exec carrier) so
					// the transcript/TUI render an ordinary tool card while
					// `agent-loop` skips re-execution, and pair it with a
					// toolResult built from `rawOutput`.
					handleToolUpdate(turn, state, update);
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
		flushUnfinished() {
			for (const tracked of byId.values()) {
				if (tracked.ended) continue;
				endToolBlock(state, tracked);
				void deliverToolResult(turn, tracked, "The turn ended before this call reported completion.", true);
			}
		},
	};
	return turn;
}

/** A live toolCall block mirrored from ACP, pending its tool_result pairing. */
interface TrackedToolBlock {
	block: ToolCall & { [kCursorExecResolved]?: true };
	contentIndex: number;
	toolName: string;
	ended: boolean;
	paired: boolean;
	/** Diff/op/path carried from the approval echo into the result details. */
	editMeta?: { diff: string; op: "create" | "update"; path?: string; firstChangedLine?: number };
}

/** ACP `kind` → omp built-in tool name, so the TUI picks the native renderer. */
function mapToolName(kind: string | null | undefined, title: string | null | undefined): string {
	switch (kind) {
		case "edit":
		case "delete":
		case "move":
			return "edit";
		case "read":
			return "read";
		case "search":
			return "grep";
		case "execute":
			return "bash";
		case "fetch":
			return "web_search";
		case "think":
		case "switch_mode":
			return "think";
		default:
			// ACP `other` / absent: keep the server's own title when it names
			// something, else a neutral label. Unknown names draw a generic card.
			return title?.trim() ? normalizeActivityTitle(title) : "Antigravity";
	}
}

/** Lowercase snake-ish label from a server title, safe as a tool name. */
function normalizeActivityTitle(title: string): string {
	const cleaned = title
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "_")
		.replace(/[^a-z0-9_]/g, "")
		.slice(0, 48);
	return cleaned || "Antigravity";
}

/** ACP tool frame: the `tool_call` payload satisfies this superset shape. */
type ToolFrame = ToolCallUpdate & { sessionUpdate: "tool_call" | "tool_call_update" };

function handleToolUpdate(turn: AntigravityAcpTurn, state: AntigravityAcpStreamState, update: ToolFrame): void {
	let tracked = turn.blocks.get(update.toolCallId);
	if (!tracked) {
		const status = update.status ?? "in_progress";
		if (status === "pending") {
			// Approval echo: the same `toolCallId` also arrives in the
			// `session/request_permission` request, and the call may never
			// run under this id (denied, or re-issued under a `<session>:N`
			// id by an auto-approved run). Hold it: its diff/rawInput seed
			// the card the execution frames open — matched by id when the
			// ids agree, or by kind+target when they do not.
			const seen = turn.pendingFrames.get(update.toolCallId);
			turn.pendingFrames.set(update.toolCallId, seen ? mergeFrames(seen, update) : update);
			turn.echoIds.add(update.toolCallId);
			const target = echoTarget(update);
			if (target) {
				const seenTarget = turn.pendingByTarget.get(target);
				turn.pendingByTarget.set(target, seenTarget ? mergeFrames(seenTarget, update) : update);
			}
			return;
		}
		const idEcho = turn.pendingFrames.get(update.toolCallId);
		const echoed = idEcho ?? claimEchoByTarget(turn, update);
		turn.pendingFrames.delete(update.toolCallId);
		if (status === "failed" && (idEcho !== undefined || turn.echoIds.delete(update.toolCallId))) {
			// Terminal failure of an echoed call under its own id (approval
			// denied), or the "approved but never executed" tombstone of an
			// echo whose run happened under another id: no work happened
			// here, so no card — a failed card would report an execution
			// that never ran.
			return;
		}
		endText(state);
		endThinking(state);
		const frame = echoed ? mergeFrames(echoed, update) : update;
		const toolName = mapToolName(frame.kind, frame.title);
		const block: TrackedToolBlock["block"] = {
			type: "toolCall",
			id: update.toolCallId,
			name: toolName,
			arguments: toolArguments(frame, toolName),
			[kCursorExecResolved]: true,
		};
		state.output.content.push(block);
		tracked = {
			block,
			contentIndex: state.output.content.length - 1,
			toolName,
			ended: false,
			paired: false,
			editMeta: editMetaFromFrame(frame),
		};
		turn.blocks.set(update.toolCallId, tracked);
		state.stream.push({ type: "toolcall_start", contentIndex: tracked.contentIndex, partial: state.output });
	} else if (update.kind !== undefined || update.title !== undefined) {
		tracked.toolName = mapToolName(update.kind, update.title) || tracked.toolName;
		tracked.block.name = tracked.toolName;
	}
	// Later frames refine arguments (rawInput, diff). The cumulative
	// `message_update` re-lists the block, so no extra delta event is needed —
	// mutating `block.arguments` is enough for live and rebuilt paths alike.
	if (update.rawInput !== undefined || hasDiffContent(update) || update.locations !== undefined) {
		tracked.block.arguments = { ...tracked.block.arguments, ...toolArguments(update, tracked.toolName) };
	}

	const status = update.status;
	if (status === "completed" || status === "failed") {
		endToolBlock(state, tracked);
		const text = resultText(update.rawOutput) ?? update.title?.trim() ?? "completed";
		void deliverToolResult(turn, tracked, text, status === "failed", update.rawOutput);
	}
}

/** Overlay a later frame onto an earlier one; absent/null fields carry over. */
function mergeFrames(base: ToolFrame, next: ToolFrame): ToolFrame {
	return {
		...base,
		...next,
		kind: next.kind ?? base.kind,
		title: next.title ?? base.title,
		content: next.content ?? base.content,
		locations: next.locations ?? base.locations,
		rawInput: next.rawInput ?? base.rawInput,
		rawOutput: next.rawOutput ?? base.rawOutput,
	};
}

/** Frames carrying a diff/content payload (tool_call / tool_call_update). */
function hasDiffContent(update: { content?: unknown }): boolean {
	return Array.isArray(update.content) && update.content.length > 0;
}

function endToolBlock(state: AntigravityAcpStreamState, tracked: TrackedToolBlock): void {
	if (tracked.ended) return;
	tracked.ended = true;
	state.stream.push({
		type: "toolcall_end",
		contentIndex: tracked.contentIndex,
		toolCall: tracked.block,
		partial: state.output,
	});
}

async function deliverToolResult(
	turn: AntigravityAcpTurn,
	tracked: TrackedToolBlock,
	text: string,
	isError: boolean,
	rawOutput?: unknown,
): Promise<void> {
	if (tracked.paired) return;
	tracked.paired = true;
	const details = resultDetails(tracked, rawOutput);
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: tracked.block.id,
		toolName: tracked.toolName,
		content: [{ type: "text", text }],
		...(details ? { details } : {}),
		isError,
		timestamp: Date.now(),
	};
	try {
		await turn.onToolResult?.(result);
	} catch {
		// A rejecting transformer mirrors Cursor: the reserved payload stands.
	}
}

/**
 * Renderer-facing result details: `EditToolDetails`-shaped diff for edit
 * cards (built from the approval echo — execution frames never carry it),
 * bash-shaped exit code for command cards.
 */
function resultDetails(tracked: TrackedToolBlock, rawOutput?: unknown): Record<string, unknown> | undefined {
	if (tracked.toolName === "edit" && tracked.editMeta) {
		return {
			diff: tracked.editMeta.diff,
			op: tracked.editMeta.op,
			...(tracked.editMeta.path !== undefined ? { path: tracked.editMeta.path } : {}),
			...(tracked.editMeta.firstChangedLine !== undefined
				? { firstChangedLine: tracked.editMeta.firstChangedLine }
				: {}),
		};
	}
	if (tracked.toolName === "bash") {
		const rec = asRecord(rawOutput);
		const exitCode =
			typeof rec?.exitCode === "number"
				? rec.exitCode
				: typeof rec?.exit_code === "number"
					? rec.exit_code
					: undefined;
		return exitCode === undefined ? undefined : { exitCode };
	}
	return undefined;
}

/**
 * Identity key linking an approval echo to the execution frames of the same
 * call when their `toolCallId`s differ (auto-approved runs execute under a
 * `<session>:N` id): ACP kind + command line, or kind + target path.
 */
function echoTarget(update: ToolFrame): string | undefined {
	const raw = asRecord(update.rawInput);
	const kind = update.kind ?? "";
	if (kind === "execute") {
		const command = strOf(raw?.CommandLine ?? raw?.command_line ?? raw?.command);
		return command ? `execute:${command}` : undefined;
	}
	const path =
		strOf(raw?.TargetFile ?? raw?.file_path ?? raw?.path) ??
		update.locations?.find(loc => loc.path)?.path ??
		firstDiffPath(update);
	return path ? `${kind}:${path}` : undefined;
}

/** Claim (consume) the pending echo matching this frame's kind+target. */
function claimEchoByTarget(turn: AntigravityAcpTurn, update: ToolFrame): ToolFrame | undefined {
	const target = echoTarget(update);
	if (!target) return undefined;
	const echo = turn.pendingByTarget.get(target);
	if (echo) {
		turn.pendingByTarget.delete(target);
		turn.pendingFrames.delete(echo.toolCallId);
	}
	return echo;
}

function firstDiffPath(update: ToolFrame): string | undefined {
	if (!Array.isArray(update.content)) return undefined;
	for (const item of update.content) {
		const rec = asRecord(item);
		if (rec?.type === "diff" && typeof rec.path === "string") return rec.path;
	}
	return undefined;
}

/** Unified-diff details for the edit card, built once from the merged frame. */
function editMetaFromFrame(
	frame: ToolFrame,
): { diff: string; op: "create" | "update"; path?: string; firstChangedLine?: number } | undefined {
	const diff = firstDiff(frame);
	if (!diff || (diff.oldText === undefined && diff.newText === undefined)) return undefined;
	const raw = asRecord(frame.rawInput);
	const path =
		strOf(raw?.TargetFile ?? raw?.file_path ?? raw?.path) ??
		frame.locations?.find(loc => loc.path)?.path ??
		firstDiffPath(frame);
	const op: "create" | "update" = diff.oldText === undefined ? "create" : "update";
	const rendered = editDiffString(diff.oldText ?? "", diff.newText ?? "", path);
	if (!rendered.diff) return undefined;
	const line = raw?.StartLine;
	const firstChangedLine =
		typeof line === "number" && Number.isFinite(line)
			? line
			: (frame.locations?.find(loc => typeof loc.line === "number")?.line ?? rendered.firstChangedLine);
	return { diff: rendered.diff, op, ...(path !== undefined ? { path } : {}), firstChangedLine };
}

/** Map an ACP tool frame onto the built-in tool's argument shape, for the TUI. */
function toolArguments(update: ToolFrame, toolName: string): Record<string, unknown> {
	const raw = asRecord(update.rawInput);
	const location = update.locations?.find(loc => loc.path)?.path;
	const diff = firstDiff(update);
	switch (toolName) {
		case "edit": {
			const path = strOf(raw?.TargetFile ?? raw?.file_path ?? raw?.path) ?? location;
			const out: Record<string, unknown> = {};
			if (path) out.path = path;
			// Render-only diff fields: the TUI edit renderer reads newText/diff.
			if (diff) {
				if (diff.oldText !== undefined) out.oldText = diff.oldText;
				if (diff.newText !== undefined) out.newText = diff.newText;
			}
			return out;
		}
		case "read": {
			const path = strOf(raw?.file_path ?? raw?.TargetFile ?? raw?.path) ?? location;
			return path ? { path } : {};
		}
		case "bash": {
			const command = strOf(raw?.CommandLine ?? raw?.command_line ?? raw?.command);
			return command ? { command } : {};
		}
		case "grep": {
			const pattern = strOf(raw?.pattern ?? raw?.Pattern ?? raw?.query);
			const path = strOf(raw?.path ?? raw?.dir) ?? location;
			const out: Record<string, unknown> = {};
			if (pattern) out.pattern = pattern;
			if (path) out.path = path;
			return out;
		}
		default: {
			// Unknown/generic card: surface the raw input verbatim, plus the
			// server's title as intent so the working line has context.
			const out: Record<string, unknown> = raw ? { ...raw } : {};
			const title = update.title?.trim();
			if (title) out[INTENT_FIELD] = title;
			return out;
		}
	}
}

function firstDiff(update: { content?: unknown }): { oldText?: string; newText?: string } | undefined {
	if (!Array.isArray(update.content)) return undefined;
	for (const item of update.content) {
		const rec = asRecord(item);
		if (!rec) continue;
		if (rec.type === "diff" || typeof rec.newText === "string") {
			return {
				oldText: typeof rec.oldText === "string" ? rec.oldText : undefined,
				newText: typeof rec.newText === "string" ? rec.newText : undefined,
			};
		}
	}
	return undefined;
}

/** Flatten ACP `rawOutput` (string or structured object) into display text. */
function resultText(rawOutput: unknown): string | undefined {
	if (typeof rawOutput === "string") return rawOutput.trim() || undefined;
	const rec = asRecord(rawOutput);
	if (!rec) return undefined;
	for (const key of ["combinedOutput", "formatted_output", "output", "CommandOutput", "rawOutput"]) {
		const value = rec[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function strOf(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
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
		const turn = session.activeTurn;
		if (turn) {
			const state = turn.state;
			if (!state.stream.done) {
				state.output.stopReason = "error";
				state.output.errorMessage = "The Antigravity server process exited mid-turn.";
				turn.flushUnfinished();
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
	turn: AntigravityAcpTurn,
	reason: "stop" | "length" | "aborted",
): void {
	endText(state);
	endThinking(state);
	// Every mirrored block needs toolcall_end + a paired result, or the
	// rebuild strips the whole interaction as an unanswered call.
	turn.flushUnfinished();
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
