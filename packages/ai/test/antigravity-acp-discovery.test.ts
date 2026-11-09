/**
 * Contract: the `antigravity` model browser shows the roster the installed
 * official binary actually advertises in its `configOptions` — not the frozen
 * bundled seed — while a signed-out or missing binary keeps the bundled rows.
 * A consumer that selects `gemini-3.5-flash` from an account whose binary
 * offers it must see the row (and only rows the binary reports), so selection
 * cannot strand the user on a SKU the binary would reject.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { fetchAntigravityAcpModels } from "@oh-my-pi/pi-catalog/discovery/antigravity-acp";
import { ANTIGRAVITY_ACP_PATH_ENV } from "@oh-my-pi/pi-utils/antigravity";
import { Effort } from "@oh-my-pi/pi-catalog/effort";

let configDir: string;
let previousConfigDir: string | undefined;
let previousFakePath: string | undefined;
let previousChoiceStyle: string | undefined;

beforeAll(async () => {
	configDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-antigravity-discovery-test-"));
	previousConfigDir = process.env.PI_CONFIG_DIR;
	previousFakePath = process.env[ANTIGRAVITY_ACP_PATH_ENV];
	previousChoiceStyle = process.env.ANTIGRAVITY_FAKE_CHOICE_STYLE;
	process.env.PI_CONFIG_DIR = configDir;
});

afterAll(async () => {
	if (previousConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
	else process.env.PI_CONFIG_DIR = previousConfigDir;
	if (previousFakePath === undefined) delete process.env[ANTIGRAVITY_ACP_PATH_ENV];
	else process.env[ANTIGRAVITY_ACP_PATH_ENV] = previousFakePath;
	if (previousChoiceStyle === undefined) delete process.env.ANTIGRAVITY_FAKE_CHOICE_STYLE;
	else process.env.ANTIGRAVITY_FAKE_CHOICE_STYLE = previousChoiceStyle;
	await fs.rm(configDir, { recursive: true, force: true });
});

beforeEach(() => {
	process.env[ANTIGRAVITY_ACP_PATH_ENV] = path.join(import.meta.dir, "fixtures", "antigravity-acp-fake-agent.ts");
	delete process.env.ANTIGRAVITY_FAKE_MODE;
	delete process.env.ANTIGRAVITY_FAKE_CHOICE_STYLE;
});

afterEach(() => {
	delete process.env[ANTIGRAVITY_ACP_PATH_ENV];
	delete process.env.ANTIGRAVITY_FAKE_MODE;
	delete process.env.ANTIGRAVITY_FAKE_CHOICE_STYLE;
});

describe("antigravity-acp discovery", () => {
	it("mirrors the binary's tiered-SKU select as catalog rows with thought_level efforts", async () => {
		// Fixture default: models gemini-3.7-flash-high/-medium/-low + gemini-pro-agent,
		// thought_level low/high.
		const models = await fetchAntigravityAcpModels({ cwd: configDir });
		expect(models).not.toBeNull();
		const byId = new Map(models!.map(model => [model.id, model]));
		expect([...byId.keys()]).toEqual([
			"gemini-3.7-flash-high",
			"gemini-3.7-flash-medium",
			"gemini-3.7-flash-low",
			"gemini-pro-agent",
		]);
		const row = byId.get("gemini-3.7-flash-high");
		expect(row?.name).toBe("Gemini 3.7 Flash (High)");
		expect(row?.api).toBe("antigravity-acp");
		expect(row?.provider).toBe("antigravity");
		expect(row?.reasoning).toBe(true);
		expect(row?.thinking?.efforts).toEqual([Effort.Low, Effort.High]);
	});

	it("keeps family-base ids when the binary lists them (thought_level selects the tier)", async () => {
		process.env.ANTIGRAVITY_FAKE_CHOICE_STYLE = "base";
		const models = await fetchAntigravityAcpModels({ cwd: configDir });
		expect(models).not.toBeNull();
		expect(models!.map(model => model.id)).toEqual(["gemini-3.7-flash", "gemini-pro-agent"]);
	});

	it("returns null for a signed-out binary so the bundled roster survives", async () => {
		process.env.ANTIGRAVITY_FAKE_MODE = "signed-out";
		expect(await fetchAntigravityAcpModels({ cwd: configDir })).toBeNull();
	});

	it("returns null when no binary is installed", async () => {
		delete process.env[ANTIGRAVITY_ACP_PATH_ENV];
		expect(await fetchAntigravityAcpModels({ cwd: configDir })).toBeNull();
	});
});
