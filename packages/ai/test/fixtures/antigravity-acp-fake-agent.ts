#!/usr/bin/env bun
/**
 * Stdio JSON-RPC stand-in for the official `agy_acp_server` binary, driven by
 * antigravity-acp provider tests through OMP_ANTIGRAVITY_ACP_PATH. Modes via
 * ANTIGRAVITY_FAKE_MODE:
 *   signed-out — print the sign-in prompt line, then fail authenticate
 *   cancel     — hold the prompt until session/cancel, then answer cancelled
 *   (default)  — full happy turn with thought/text/tool updates + usage
 */
import * as readline from "node:readline";

const AUTH_URL =
	"https://accounts.google.com/o/oauth2/v2/auth?client_id=fake&redirect_uri=http%3A%2F%2F127.0.0.1%3A8123%2Fcallback&response_type=code";
const mode = process.env.ANTIGRAVITY_FAKE_MODE ?? "happy";
// Runtime 1.4 lists family BASE ids; some builds list tiered SKUs. Tests pick
// the shape via ANTIGRAVITY_FAKE_CHOICE_STYLE.
const choiceStyle = process.env.ANTIGRAVITY_FAKE_CHOICE_STYLE ?? "sku";

const out = (msg: Record<string, unknown>) => {
	process.stdout.write(`${JSON.stringify(msg)}\n`);
};
const respond = (id: number | string, result: unknown) => out({ jsonrpc: "2.0", id, result });
const fail = (id: number | string, code: number, message: string) =>
	out({ jsonrpc: "2.0", id, error: { code, message } });
const notify = (method: string, params: unknown) => out({ jsonrpc: "2.0", method, params });

const configOptions = (currentModel: string, currentLevel: string) => [
	{
		id: "model",
		name: "Model",
		type: "select",
		currentValue: currentModel,
		options:
			choiceStyle === "base"
				? [
						{ value: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
						{ value: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
					]
				: [
						{ value: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
						{ value: "gemini-3.7-flash-medium", name: "Gemini 3.7 Flash (Medium)" },
						{ value: "gemini-3.7-flash-low", name: "Gemini 3.7 Flash (Low)" },
						{ value: "gemini-pro-agent", name: "Gemini 3.1 Pro (High)" },
					],
	},
	{
		id: "thinking_level",
		name: "Thinking Level",
		category: "thought_level",
		type: "select",
		currentValue: currentLevel,
		options: [
			{ value: "low", name: "Low" },
			{ value: "high", name: "High" },
		],
	},
];

let currentModel = "gemini-3.7-flash-high";
let currentLevel = "high";
let promptResolver: ((stopReason: string) => void) | undefined;

async function main(): Promise<void> {
	const rl = readline.createInterface({ input: process.stdin });
	for await (const line of rl) {
		if (!line.trimStart().startsWith("{")) continue;
		const msg = JSON.parse(line) as {
			id?: number | string;
			method?: string;
			params?: Record<string, unknown>;
		};
		if (!msg.method) continue;
		if (msg.method === "session/cancel") {
			promptResolver?.("cancelled");
			continue;
		}
		if (msg.id === undefined) continue;
		const { id, method, params = {} } = msg;
		switch (method) {
			case "initialize":
				respond(id, {
					protocolVersion: 1,
					agentInfo: { name: "fake-agy", version: "1.4.5" },
					authMethods: [{ id: "oauth-personal", name: "Google sign-in" }],
				});
				break;
			case "authenticate":
				if (mode === "signed-out") {
					process.stdout.write(`Open the following link to authenticate the ACP server: ${AUTH_URL}\n`);
					fail(id, -32000, "Authentication required");
				} else {
					respond(id, {});
				}
				break;
			case "session/new":
				respond(id, {
					sessionId: "sess-fake-1",
					modes: {
						currentModeId: "default",
						availableModes: [
							{ id: "default", name: "Default" },
							{ id: "auto_edit", name: "Auto accept edits" },
							{ id: "yolo", name: "YOLO" },
						],
					},
					configOptions: configOptions(currentModel, currentLevel),
				});
				break;
			case "session/set_config_option": {
				const configId = String(params.configId ?? "");
				const value = String(params.value ?? "");
				if (configId === "model") currentModel = value;
				if (configId === "thinking_level") currentLevel = value;
				respond(id, { configOptions: configOptions(currentModel, currentLevel) });
				break;
			}
			case "session/set_mode":
				respond(id, {});
				break;
			case "session/request_permission":
				// Should never arrive: the provider is the client here.
				fail(id, -32601, "fake agent does not request permission");
				break;
			case "session/prompt": {
				const sessionId = String(params.sessionId ?? "");
				if (mode === "cancel") {
					notify("session/update", {
						sessionId,
						update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "starting" } },
					});
					const stopReason = await new Promise<string>(resolve => {
						promptResolver = resolve;
						setTimeout(() => resolve("end_turn"), 3000);
					});
					respond(id, { stopReason });
					if (stopReason === "cancelled") setTimeout(() => process.exit(0), 50);
					break;
				}
				if (mode === "denied") {
					// Approval-mode echo: pending frame (also carried in the
					// request_permission request), then the approval never
					// executed under this id, then a re-run under another id.
					notify("session/update", {
						sessionId,
						update: {
							sessionUpdate: "tool_call",
							toolCallId: "tc-denied",
							title: "Run edit_file?",
							kind: "edit",
							status: "pending",
							content: [{ type: "diff", path: "src/b.ts", oldText: "a\n", newText: "b\n" }],
							locations: [{ path: "/tmp/src/b.ts" }],
							rawInput: { TargetFile: "/tmp/src/b.ts", ReplacementContent: "b\n" },
						},
					});
					notify("session/update", {
						sessionId,
						update: {
							sessionUpdate: "tool_call_update",
							toolCallId: "tc-denied",
							status: "failed",
							rawOutput: "Tool call was approved but never executed.",
						},
					});
					notify("session/update", {
						sessionId,
						update: {
							sessionUpdate: "tool_call",
							toolCallId: "tc-retry",
							title: "Running edit_file",
							kind: "edit",
							status: "in_progress",
							rawInput: { file_path: "/tmp/src/b.ts" },
						},
					});
					notify("session/update", {
						sessionId,
						update: {
							sessionUpdate: "tool_call_update",
							toolCallId: "tc-retry",
							status: "completed",
							rawOutput: "Edited src/b.ts",
						},
					});
					respond(id, { stopReason: "end_turn" });
					break;
				}
				if (mode === "auto") {
					// Auto-approved run (captured wire): the approval echo (hex
					// id, carries the diff) is answered by execution under a
					// DIFFERENT `<sid>:1` id whose frames carry only the path,
					// then the echo closes with a failed "never executed"
					// tombstone. The card must appear once, under `:1`, with
					// the echo's diff, and the tombstone must not open a second.
					notify("session/update", {
						sessionId,
						update: {
							sessionUpdate: "tool_call",
							toolCallId: "tc-auto-echo",
							title: "Run create_file?",
							kind: "edit",
							status: "pending",
							content: [{ type: "diff", path: "hello.py", newText: 'print("Hello, World!")\n' }],
							locations: [{ path: "/tmp/hello.py" }],
							rawInput: { TargetFile: "/tmp/hello.py", CodeContent: 'print("Hello, World!")\n' },
						},
					});
					notify("session/update", {
						sessionId,
						update: {
							sessionUpdate: "tool_call",
							toolCallId: "sess-fake-1:1",
							title: "Running edit_file",
							kind: "edit",
							status: "in_progress",
							locations: [{ path: "/tmp/hello.py" }],
							rawInput: { file_path: "/tmp/hello.py" },
						},
					});
					notify("session/update", {
						sessionId,
						update: {
							sessionUpdate: "tool_call_update",
							toolCallId: "sess-fake-1:1",
							status: "completed",
							rawOutput: "Create hello.py",
						},
					});
					notify("session/update", {
						sessionId,
						update: {
							sessionUpdate: "tool_call_update",
							toolCallId: "tc-auto-echo",
							status: "failed",
							rawOutput: "Tool call was approved but never executed.",
						},
					});
					respond(id, { stopReason: "end_turn" });
					break;
				}
				if (process.env.ANTIGRAVITY_FAKE_ECHO === "1") {
					notify("session/update", {
						sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: `model=${currentModel};level=${currentLevel}` },
						},
					});
				}
				notify("session/update", {
					sessionId,
					update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "plan first" } },
				});
				// Mirror the official runtime's tool frames (captured wire):
				// kind + rawInput + diff content, then rawOutput on completion.
				notify("session/update", {
					sessionId,
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "tc-1",
						title: "Run create_file?",
						kind: "edit",
						status: "pending",
						content: [{ type: "diff", path: "src/a.ts", newText: "console.log(1)\n" }],
						locations: [{ path: "/tmp/src/a.ts" }],
						rawInput: { TargetFile: "/tmp/src/a.ts", CodeContent: "console.log(1)\n" },
					},
				});
				notify("session/update", {
					sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "tc-1",
						status: "completed",
						rawOutput: "Created src/a.ts",
					},
				});
				notify("session/update", {
					sessionId,
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } },
				});
				notify("session/update", {
					sessionId,
					update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } },
				});
				respond(id, {
					stopReason: "end_turn",
					usage: { totalTokens: 42, inputTokens: 40, outputTokens: 2, cachedReadTokens: 5 },
				});
				break;
			}
			default:
				fail(id, -32601, `method not found: ${method}`);
		}
	}
}

await main();
