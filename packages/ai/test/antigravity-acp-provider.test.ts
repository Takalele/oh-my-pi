import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ANTIGRAVITY_ACP_PATH_ENV } from "@oh-my-pi/pi-utils/antigravity";
import { streamAntigravityAcp } from "@oh-my-pi/pi-ai/providers/antigravity-acp";
import type { Context, Model, ProviderSessionState } from "@oh-my-pi/pi-ai/types";

const model: Model<"antigravity-acp"> = buildModel({
	id: "gemini-3.7-flash-high",
	name: "Gemini 3.7 Flash (High)",
	api: "antigravity-acp",
	provider: "antigravity",
	baseUrl: "https://antigravity.google",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
	supportsTools: true,
});

const context: Context = { messages: [{ role: "user", content: "hello agent", timestamp: Date.now() }] };

let configDir: string;
let previousConfigDir: string | undefined;
let previousFakePath: string | undefined;
let previousFakeMode: string | undefined;

beforeAll(async () => {
	configDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-antigravity-test-"));
	previousConfigDir = process.env.PI_CONFIG_DIR;
	previousFakePath = process.env[ANTIGRAVITY_ACP_PATH_ENV];
	previousFakeMode = process.env.ANTIGRAVITY_FAKE_MODE;
	process.env.PI_CONFIG_DIR = configDir;
});

afterAll(async () => {
	if (previousConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = previousConfigDir;
	if (previousFakePath === undefined) delete process.env[ANTIGRAVITY_ACP_PATH_ENV];
	else process.env[ANTIGRAVITY_ACP_PATH_ENV] = previousFakePath;
	if (previousFakeMode === undefined) delete process.env.ANTIGRAVITY_FAKE_MODE;
	else process.env.ANTIGRAVITY_FAKE_MODE = previousFakeMode;
	delete process.env.ANTIGRAVITY_FAKE_CHOICE_STYLE;
	delete process.env.ANTIGRAVITY_FAKE_ECHO;
	await fs.rm(configDir, { recursive: true, force: true });
});

function useFakeAgent(mode?: string): void {
	process.env[ANTIGRAVITY_ACP_PATH_ENV] = path.join(import.meta.dir, "fixtures", "antigravity-acp-fake-agent.ts");
	if (mode === undefined) delete process.env.ANTIGRAVITY_FAKE_MODE;
	else process.env.ANTIGRAVITY_FAKE_MODE = mode;
	delete process.env.ANTIGRAVITY_FAKE_CHOICE_STYLE;
	delete process.env.ANTIGRAVITY_FAKE_ECHO;
}

describe("antigravity-acp provider", () => {
	it("maps a fake ACP turn to thinking/text deltas and never emits toolCall blocks", async () => {
		useFakeAgent();
		const sessions = new Map<string, ProviderSessionState>();
		const events: string[] = [];
		const stream = streamAntigravityAcp(model, context, {
			cwd: configDir,
			sessionId: "omp-session-1",
			providerSessionState: sessions,
		});
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();

		// Order: thought ("plan first") + tool activity summaries close BEFORE
		// the text chunks arrive (direction A: agent tool calls are summaries).
		expect(events.slice(1, -1)).toEqual([
			"thinking_start",
			"thinking_delta",
			"thinking_delta",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_delta",
			"text_end",
		]);
		expect(result.stopReason).toBe("stop");
		expect(result.content.map(block => block.type)).toEqual(["thinking", "text"]);
		const thinking = result.content.find(block => block.type === "thinking");
		const text = result.content.find(block => block.type === "text");
		expect(thinking?.type === "thinking" && thinking.thinking).toContain("plan first");
		expect(thinking?.type === "thinking" && thinking.thinking).toContain("[in_progress] Edit src/a.ts");
		expect(text?.type === "text" && text.text).toBe("Hello world");
		// Usage from the PromptResponse; cost stays zero (plan subscription).
		expect(result.usage).toMatchObject({
			input: 40,
			output: 2,
			cacheRead: 5,
			totalTokens: 42,
			cost: { total: 0 },
		});
		for (const state of sessions.values()) state.close();
		sessions.clear();
	});

	it("missing runtime surfaces the install hint instead of an implicit download", async () => {
		delete process.env[ANTIGRAVITY_ACP_PATH_ENV];
		delete process.env.ANTIGRAVITY_FAKE_MODE;
		const sessions = new Map<string, ProviderSessionState>();
		const result = await streamAntigravityAcp(model, context, {
			cwd: configDir,
			sessionId: "omp-session-missing",
			providerSessionState: sessions,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("omp antigravity install");
	});

	it("signed-out binary surfaces the sign-in link and points at /login", async () => {
		useFakeAgent("signed-out");
		const sessions = new Map<string, ProviderSessionState>();
		const result = await streamAntigravityAcp(model, context, {
			cwd: configDir,
			sessionId: "omp-session-signedout",
			providerSessionState: sessions,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("/login antigravity");
		expect(result.errorMessage).toContain("accounts.google.com/o/oauth2");
	});

	it("exact model id is selected when the agent lists it", async () => {
		useFakeAgent();
		process.env.ANTIGRAVITY_FAKE_CHOICE_STYLE = "sku";
		process.env.ANTIGRAVITY_FAKE_ECHO = "1";
		const proModel: Model<"antigravity-acp"> = { ...model, id: "gemini-pro-agent" };
		const sessions = new Map<string, ProviderSessionState>();
		const result = await streamAntigravityAcp(proModel, context, {
			cwd: configDir,
			sessionId: "omp-session-pro",
			providerSessionState: sessions,
		}).result();
		expect(result.stopReason).toBe("stop");
		const text = result.content.find(block => block.type === "text");
		expect(text?.type === "text" && text.text).toContain("model=gemini-pro-agent");
		for (const state of sessions.values()) state.close();
		sessions.clear();
	});

	it("tiered SKU falls back to the family base id and carries the tier in thought_level", async () => {
		useFakeAgent();
		process.env.ANTIGRAVITY_FAKE_CHOICE_STYLE = "base";
		process.env.ANTIGRAVITY_FAKE_ECHO = "1";
		const lowModel: Model<"antigravity-acp"> = { ...model, id: "gemini-3.7-flash-low" };
		const sessions = new Map<string, ProviderSessionState>();
		const result = await streamAntigravityAcp(lowModel, context, {
			cwd: configDir,
			sessionId: "omp-session-low",
			providerSessionState: sessions,
		}).result();
		expect(result.stopReason).toBe("stop");
		const text = result.content.find(block => block.type === "text");
		// Runtime 1.4 lists family bases; the tier travels as thought_level=low.
		expect(text?.type === "text" && text.text).toContain("model=gemini-3.7-flash;level=low");
		for (const state of sessions.values()) state.close();
		sessions.clear();
	});

	it("a model the account does not serve fails with an account-scoped error", async () => {
		useFakeAgent();
		process.env.ANTIGRAVITY_FAKE_CHOICE_STYLE = "sku";
		const missingModel: Model<"antigravity-acp"> = { ...model, id: "gemini-3.8-flash-high" };
		const sessions = new Map<string, ProviderSessionState>();
		const result = await streamAntigravityAcp(missingModel, context, {
			cwd: configDir,
			sessionId: "omp-session-missing-model",
			providerSessionState: sessions,
		}).result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("unavailable for this Google account");
	});

	it("caller abort cancels the prompt and ends the stream aborted", async () => {
		useFakeAgent("cancel");
		const sessions = new Map<string, ProviderSessionState>();
		const controller = new AbortController();
		const stream = streamAntigravityAcp(model, context, {
			cwd: configDir,
			sessionId: "omp-session-cancel",
			providerSessionState: sessions,
			signal: controller.signal,
		});
		// Abort at the first streamed event — the fake agent emits its opening
		// thought before holding the prompt, so "prompt is running" is an
		// awaited signal, not a guessed sleep.
		let aborted = false;
		for await (const event of stream) {
			if (!aborted && event.type === "thinking_delta") {
				aborted = true;
				controller.abort();
			}
		}
		expect(aborted).toBe(true);
		const result = await stream.result();
		expect(result.stopReason).toBe("aborted");
		for (const state of sessions.values()) state.close();
		sessions.clear();
	});
});
