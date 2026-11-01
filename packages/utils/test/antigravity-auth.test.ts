import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ANTIGRAVITY_AUTH_BROWSER_MARKER,
	ANTIGRAVITY_AUTH_STDOUT_PREFIX,
	buildAntigravityAcpEnv,
	ensureAntigravityProfile,
	isValidAntigravityAuthUrl,
	parseAntigravityAcpAuthUrl,
	scrubAntigravityAcpEnv,
} from "../src/antigravity";

const VALID_URL =
	"https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A8791%2F&state=s";

describe("antigravity env scrub", () => {
	it("removes ambient Google credentials case-insensitively but keeps unrelated vars", () => {
		const scrubbed = scrubAntigravityAcpEnv({
			GEMINI_API_KEY: "k",
			google_api_key: "k",
			GOOGLE_CLOUD_PROJECT: "p",
			Path: "/usr/bin",
			HOME: "/home/u",
		});
		expect(scrubbed.GEMINI_API_KEY).toBeUndefined();
		expect(scrubbed.google_api_key).toBeUndefined();
		expect(scrubbed.GOOGLE_CLOUD_PROJECT).toBeUndefined();
		expect(scrubbed.Path).toBe("/usr/bin");
		expect(scrubbed.HOME).toBe("/home/u");
	});
});

describe("antigravity auth URL parsing", () => {
	it("extracts the URL after the documented stdout prefix", () => {
		const text = `starting...\n${ANTIGRAVITY_AUTH_STDOUT_PREFIX}${VALID_URL}\nmore`;
		expect(parseAntigravityAcpAuthUrl(text)).toBe(VALID_URL);
	});

	it("decodes the BROWSER helper marker line on stderr", () => {
		const text = `${ANTIGRAVITY_AUTH_BROWSER_MARKER}${JSON.stringify(VALID_URL)}\n`;
		expect(parseAntigravityAcpAuthUrl(text)).toBe(VALID_URL);
	});

	it("falls back to any https URL line that validates", () => {
		const text = `visit ${VALID_URL} to continue\n`;
		expect(parseAntigravityAcpAuthUrl(text)).toBe(VALID_URL);
	});

	it("rejects non-accounts.google.com origins, non-loopback redirects, and low ports", () => {
		expect(isValidAntigravityAuthUrl("https://evil.example/o?redirect_uri=http://127.0.0.1:9911/")).toBe(false);
		expect(
			isValidAntigravityAuthUrl("https://accounts.google.com/o?redirect_uri=http%3A%2F%2F10.0.0.5%3A9911%2F"),
		).toBe(false);
		expect(
			isValidAntigravityAuthUrl("https://accounts.google.com/o?redirect_uri=http%3A%2F%2F127.0.0.1%3A80%2F"),
		).toBe(false);
		expect(parseAntigravityAcpAuthUrl("no url here at all")).toBeNull();
	});
});

describe("antigravity profile + spawn env", () => {
	let configDir: string;
	let previousConfigDir: string | undefined;

	beforeEach(async () => {
		previousConfigDir = process.env.PI_CONFIG_DIR;
		configDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agy-auth-"));
		process.env.PI_CONFIG_DIR = configDir;
	});

	afterEach(async () => {
		if (previousConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
		else process.env.PI_CONFIG_DIR = previousConfigDir;
		await fs.rm(configDir, { recursive: true, force: true });
	});

	it("writes settings.json pinning the auth mode, and gcp block for business", async () => {
		const home = await ensureAntigravityProfile("oauth-personal");
		const settings = await Bun.file(path.join(home, "antigravity-acp", "settings.json")).json();
		expect(settings.auth.type).toBe("oauth-personal");
		expect(settings.gcp).toBeUndefined();

		const bizHome = await ensureAntigravityProfile("oauth-business", { instanceId: "acct2", gcpProject: "proj-x" });
		const biz = await Bun.file(path.join(bizHome, "antigravity-acp", "settings.json")).json();
		expect(biz.auth.type).toBe("oauth-business");
		expect(biz.gcp.project).toBe("proj-x");
		// Distinct instances never share a profile directory.
		expect(bizHome).not.toBe(home);
	});

	it("builds an isolated env: profile home, file storage, private TMPDIR, ambient creds scrubbed", async () => {
		process.env.GOOGLE_CLOUD_PROJECT = "leaky-project";
		const home = await ensureAntigravityProfile("oauth-personal");
		const env = await buildAntigravityAcpEnv({ authType: "oauth-personal", profileHome: home, harnessPath: null });
		expect(env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
		expect(env.GEMINI_HOME).toBe(home);
		expect(env.AGY_ACP_FORCE_FILE_STORAGE).toBe("1");
		expect(env.TMPDIR).toBe(path.join(home, "tmp"));
		await fs.stat(env.TMPDIR!);
	});
});
