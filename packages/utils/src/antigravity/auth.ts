/**
 * Auth profile, environment hygiene, and sign-in URL capture for the official
 * Antigravity ACP server.
 *
 * The binary owns Google's real OAuth tokens: omp only tells it WHICH auth
 * mode a profile uses (settings.json) and keeps the process environment clean
 * so ambient cloud credentials never leak into the agent's tool sandbox. omp
 * never reads, copies, or proxies Google tokens — single-user interactive use
 * per the Antigravity ToS.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";
import { getBaseConfigRoot } from "../dirs";
import { $which } from "../which";
/** Auth mode written to the profile's `antigravity-acp/settings.json`. */
export type AntigravityAuthType = "oauth-personal" | "oauth-business" | "gemini-api-key" | "agent-platform";

/** Prefix the binary prints before its sign-in URL (verified against v1.4.x stdout). */
export const ANTIGRAVITY_AUTH_STDOUT_PREFIX = "Open the following link to authenticate the ACP server: ";

/** Marker our BROWSER helper writes to stderr when the binary invokes a browser. */
export const ANTIGRAVITY_AUTH_BROWSER_MARKER = "__OMP_ANTIGRAVITY_AUTH_URL__";

/** Config root for all Antigravity ACP installs/profiles. */
export function antigravityConfigRoot(): string {
	return path.join(getBaseConfigRoot(), "antigravity-acp");
}

/** Profiles live beside installs; `instanceId` partitions multiple sign-ins. */
export function antigravityProfileDir(authType: AntigravityAuthType, instanceId?: string): string {
	const identity = instanceId ?? `${authType}:default`;
	const hash = new Bun.CryptoHasher("sha256").update(identity).digest("hex").slice(0, 32);
	return path.join(antigravityConfigRoot(), "profiles", hash);
}

/** Written settings document for one profile. */
export interface AntigravityProfileSettings {
	auth: { type: AntigravityAuthType };
	gcp?: { project?: string; location?: string };
}

/**
 * Creates (idempotently) a profile whose `antigravity-acp/settings.json` pins
 * the auth mode; the binary keeps its own token state under the same home.
 * Returns the profile home (what `GEMINI_HOME` must point at).
 */
export async function ensureAntigravityProfile(
	authType: AntigravityAuthType,
	opts?: { instanceId?: string; gcpProject?: string; gcpLocation?: string },
): Promise<string> {
	const home = antigravityProfileDir(authType, opts?.instanceId);
	const acpDir = path.join(home, "antigravity-acp");
	await fs.mkdir(acpDir, { recursive: true, mode: 0o700 });
	await fs.chmod(home, 0o700).catch(() => {});
	const settings: AntigravityProfileSettings = {
		auth: { type: authType },
		...(authType === "oauth-business" || authType === "agent-platform"
			? {
					gcp: {
						...(opts?.gcpProject ? { project: opts.gcpProject } : undefined),
						...(opts?.gcpLocation ? { location: opts.gcpLocation } : undefined),
					},
				}
			: undefined),
	};
	await Bun.write(path.join(acpDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
	await fs.chmod(path.join(acpDir, "settings.json"), 0o600).catch(() => {});
	return home;
}

/** Environment keys scrubbed (case-insensitively) from the spawned process. */
export const ANTIGRAVITY_REMOVED_ENV_KEYS: readonly string[] = [
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_QUOTA_PROJECT",
	"GOOGLE_GENAI_USE_VERTEXAI",
	"GCLOUD_PROJECT",
	"CLOUDSDK_CORE_PROJECT",
	"AGY_ACP_CCPA_PROJECT",
	"AGY_ACP_ENABLE_OAUTH",
	"GEMINI_HOME",
	"AGY_ACP_FORCE_FILE_STORAGE",
	"ANTIGRAVITY_HARNESS_PATH",
	"BROWSER",
	"PYTHONUNBUFFERED",
	"ELECTRON_RUN_AS_NODE",
];

/** Copies the env without any key on the scrub list (case-insensitive). */
export function scrubAntigravityAcpEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const scrubbed = new Set(ANTIGRAVITY_REMOVED_ENV_KEYS.map(key => key.toLowerCase()));
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (!scrubbed.has(key.toLowerCase())) out[key] = value;
	}
	return out;
}

/** Linux system CA bundle, when present (the Go binary ignores the OS store on some distros). */
const LINUX_CA_BUNDLES = ["/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"];

/**
 * Full spawn environment for the ACP server: scrubbed ambient env plus the
 * profile wiring (GEMINI_HOME, file storage, harness path, private TMPDIR,
 * BROWSER capture helper on POSIX, CA bundle on Linux).
 */
export async function buildAntigravityAcpEnv(opts: {
	authType: AntigravityAuthType;
	profileHome: string;
	harnessPath: string | null;
	captureMarkerStream?: undefined;
}): Promise<Record<string, string>> {
	const env = scrubAntigravityAcpEnv(process.env) as Record<string, string>;
	env.GEMINI_HOME = opts.profileHome;
	env.AGY_ACP_FORCE_FILE_STORAGE = "1";
	if (opts.harnessPath) env.ANTIGRAVITY_HARNESS_PATH = opts.harnessPath;
	const tmp = path.join(opts.profileHome, "tmp");
	await fs.mkdir(tmp, { recursive: true, mode: 0o700 });
	env.TMPDIR = tmp;
	if (process.platform === "linux") {
		for (const bundle of LINUX_CA_BUNDLES) {
			try {
				await fs.access(bundle);
				env.SSL_CERT_FILE = bundle;
				break;
			} catch {
				// try next
			}
		}
	}
	return env;
}

/**
 * BROWSER value that captures the sign-in URL instead of launching a browser:
 * a tiny node one-liner echoing `marker + JSON.stringify(url)` to stderr, so
 * the parent (omp) reads it off the child's stderr stream. Python/Go browser
 * invocation passes the URL as argv, so this is interpreter-agnostic.
 */
export function antigravityAuthBrowserHelper(): string {
	return (
		`${process.execPath} -e ` +
		`'process.stderr.on("error",()=>process.exit(0)).write(` +
		`"${ANTIGRAVITY_AUTH_BROWSER_MARKER}"+JSON.stringify(process.argv[1])+"\\n",()=>process.exit(0))'`
	);
}

/** Validates an Antigravity sign-in URL: accounts.google.com + loopback redirect. */
export function isValidAntigravityAuthUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:" || parsed.hostname !== "accounts.google.com") return false;
	const redirect = parsed.searchParams.get("redirect_uri");
	if (!redirect) return false;
	let redirectUrl: URL;
	try {
		redirectUrl = new URL(redirect);
	} catch {
		return false;
	}
	if (redirectUrl.hostname !== "127.0.0.1") return false;
	const port = Number(redirectUrl.port);
	return Number.isInteger(port) && port >= 1024 && port <= 65_535;
}

/**
 * Extracts the validated sign-in URL from ACP-server stdout/stderr text:
 * first the documented prefix, then any BROWSER-marker line, then any
 * otherwise-unclaimed https URL that passes validation. Returns null when no
 * candidate validates.
 */
export function parseAntigravityAcpAuthUrl(text: string): string | null {
	const candidates: string[] = [];
	for (const line of text.split("\n")) {
		const prefixIdx = line.indexOf(ANTIGRAVITY_AUTH_STDOUT_PREFIX);
		if (prefixIdx >= 0) {
			candidates.push(
				line
					.slice(prefixIdx + ANTIGRAVITY_AUTH_STDOUT_PREFIX.length)
					.trim()
					.split(/\s+/)[0] ?? "",
			);
			continue;
		}
		const markerIdx = line.indexOf(ANTIGRAVITY_AUTH_BROWSER_MARKER);
		if (markerIdx >= 0) {
			const payload = line.slice(markerIdx + ANTIGRAVITY_AUTH_BROWSER_MARKER.length).trim();
			try {
				const decoded = JSON.parse(payload);
				if (typeof decoded === "string") candidates.push(decoded);
			} catch {
				// malformed marker line; ignore
			}
			continue;
		}
		for (const match of line.matchAll(/https:\/\/[^\s"'<>]+/g)) candidates.push(match[0]);
	}
	for (const candidate of candidates) {
		if (isValidAntigravityAuthUrl(candidate)) return candidate;
	}
	return null;
}

/** Fixed spawn arguments for the server binary (Linux requires `--uid=`). */
export function spawnArgsForAntigravityAcp(args: readonly string[] | undefined): string[] {
	return [...(args ?? [])];
}

/** True when the platform has a usable BROWSER env hook (POSIX shells). */
export function antigravityBrowserHookSupported(platform: NodeJS.Platform = process.platform): boolean {
	return platform !== "win32" && $which("sh") !== null;
}

/** Best-effort open of a URL in the user's browser for interactive hosts. */
export async function openAntigravityAuthUrl(url: string): Promise<boolean> {
	const opener =
		process.platform === "darwin"
			? $`open ${url}`.quiet().nothrow()
			: antigravityBrowserHookSupported()
				? $`xdg-open ${url}`.quiet().nothrow()
				: null;
	if (!opener) return false;
	const result = await opener;
	return result.exitCode === 0;
}
