/**
 * Managed install of the official Antigravity ACP server binary.
 *
 * Downloads the pinned release from Google's CDN, verifies the manifest
 * sha256, and extracts into `<config>/antigravity-acp/versions/<version>/`.
 * The binary is Google's unmodified artifact — the ToS-compliant surface for
 * Antigravity models. Auth profiles live beside installs and survive removal.
 */
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { $, which } from "bun";
import * as logger from "../logger";
import {
	ANTIGRAVITY_ACP_VERSION,
	antigravityAcpExecutableName,
	antigravityAcpHarnessName,
	resolveAntigravityAcpTarget,
	type AntigravityAcpTarget,
} from "./release";
import { antigravityConfigRoot } from "./auth";

/** Effective install location for one account. */
export interface AntigravityAcpInstall {
	version: string;
	root: string;
	executablePath: string;
	harnessPath: string | null;
	/** Profile home (GEMINI_HOME) the install should run with. */
	profileDir: string;
}

/** Install state summary for CLI/status surfaces. */
export interface AntigravityAcpStatus {
	installed: boolean;
	version?: string;
	executablePath?: string;
	expectedVersion: string;
	upToDate: boolean;
	source: "override" | "managed" | "none";
}

/** Env override: full path to a user-managed agy_acp_server binary. */
export const ANTIGRAVITY_ACP_PATH_ENV = "OMP_ANTIGRAVITY_ACP_PATH";

export function antigravityAcpRootOverride(): string | null {
	const value = process.env[ANTIGRAVITY_ACP_PATH_ENV]?.trim();
	return value ? value : null;
}

function versionsRoot(): string {
	return path.join(antigravityConfigRoot(), "versions");
}

function versionDir(version: string): string {
	return path.join(versionsRoot(), version);
}

async function readInstalledVersion(): Promise<string | null> {
	try {
		const state = await Bun.file(path.join(antigravityConfigRoot(), "state.json")).json();
		const version = (state as { version?: unknown }).version;
		return typeof version === "string" ? version : null;
	} catch {
		return null;
	}
}

function existsNow(p: string): string | null {
	// Synchronous probe keeps the install snapshot atomic for callers.
	return fsSync.existsSync(p) ? p : null;
}

function harnessBeside(executablePath: string, platform: NodeJS.Platform): string {
	return path.join(path.dirname(executablePath), antigravityAcpHarnessName(platform));
}

/** Resolves the effective install without touching the network. */
export async function getAntigravityAcpInstall(): Promise<AntigravityAcpInstall | null> {
	const override = antigravityAcpRootOverride();
	if (override) {
		if (!fsSync.existsSync(override)) return null;
		return {
			version: "override",
			root: path.dirname(override),
			executablePath: override,
			harnessPath: existsNow(harnessBeside(override, process.platform)),
			profileDir: "",
		};
	}
	const version = await readInstalledVersion();
	if (!version) return null;
	const executablePath = path.join(versionDir(version), antigravityAcpExecutableName());
	if (!fsSync.existsSync(executablePath)) return null;
	return {
		version,
		root: versionDir(version),
		executablePath,
		harnessPath: existsNow(harnessBeside(executablePath, process.platform)),
		profileDir: "",
	};
}

/** Status snapshot for `omp antigravity status` and diagnostics. */
export async function getAntigravityAcpStatus(): Promise<AntigravityAcpStatus> {
	const install = await getAntigravityAcpInstall();
	if (!install) {
		return { installed: false, expectedVersion: ANTIGRAVITY_ACP_VERSION, upToDate: false, source: "none" };
	}
	return {
		installed: true,
		version: install.version,
		executablePath: install.executablePath,
		expectedVersion: ANTIGRAVITY_ACP_VERSION,
		upToDate: install.version === "override" || install.version === ANTIGRAVITY_ACP_VERSION,
		source: antigravityAcpRootOverride() ? "override" : "managed",
	};
}

/** sha256 over a file without buffering it fully. */
async function sha256File(file: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	const reader = Bun.file(file).stream().getReader();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			hasher.update(value);
		}
	} finally {
		reader.releaseLock();
	}
	return hasher.digest("hex");
}

/** Lists archive members via zipinfo/unzip/tar; empty when no lister exists. */
async function listZipMembers(archive: string): Promise<string[]> {
	const zipinfo = which("zipinfo");
	if (zipinfo) {
		const result = await $`${zipinfo} -1 ${archive}`.nothrow().quiet();
		if (result.exitCode === 0)
			return result
				.text()
				.split("\n")
				.filter(line => line.length > 0);
	}
	const unzip = which("unzip");
	if (unzip) {
		const result = await $`${unzip} -Z1 ${archive}`.nothrow().quiet();
		if (result.exitCode === 0)
			return result
				.text()
				.split("\n")
				.filter(line => line.length > 0);
	}
	const tar = which("tar");
	if (tar) {
		const result = await $`${tar} -tf ${archive}`.nothrow().quiet();
		if (result.exitCode === 0)
			return result
				.text()
				.split("\n")
				.filter(line => line.length > 0);
	}
	// No lister available: rely on the extractor, then require the expected
	// executable to land inside dest (findExecutable fails closed otherwise).
	return [];
}

/** Extracts `archive` into `dest`, rejecting member paths that escape it. */
async function extractZip(archive: string, dest: string, onProgress?: (message: string) => void): Promise<void> {
	await fs.mkdir(dest, { recursive: true });
	for (const member of await listZipMembers(archive)) {
		const resolved = path.resolve(dest, member);
		if (resolved !== dest && !resolved.startsWith(dest + path.sep)) {
			throw new Error(`Refusing zip entry outside target directory: ${member}`);
		}
	}
	onProgress?.("Extracting Antigravity ACP server...");
	const unzip = which("unzip");
	if (unzip) {
		const result = await $`${unzip} -q -o ${archive} -d ${dest}`.quiet().nothrow();
		if (result.exitCode !== 0) throw new Error(`unzip failed with exit code ${result.exitCode}`);
		return;
	}
	const tar = which("tar");
	if (tar) {
		const result = await $`${tar} -xf ${archive} -C ${dest}`.quiet().nothrow();
		if (result.exitCode !== 0) throw new Error(`tar extraction failed with exit code ${result.exitCode}`);
		return;
	}
	throw new Error("Neither unzip nor tar is available to extract the Antigravity ACP archive");
}

/** Locates the executable at the extraction root or one directory deep. */
async function findExecutable(root: string, name: string): Promise<string | null> {
	if (fsSync.existsSync(path.join(root, name))) return path.join(root, name);
	for (const entry of await fs.readdir(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const candidate = path.join(root, entry.name, name);
		if (fsSync.existsSync(candidate)) return candidate;
	}
	return null;
}

/** Downloads + verifies + extracts the pinned release. */
export async function installAntigravityAcp(opts?: {
	onProgress?: (message: string) => void;
	force?: boolean;
	fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	platform?: NodeJS.Platform;
	arch?: string;
	/** DI seam: override the pinned manifest target (tests); unset in production. */
	target?: AntigravityAcpTarget;
}): Promise<AntigravityAcpInstall> {
	const platform = opts?.platform ?? process.platform;
	const arch = opts?.arch ?? process.arch;
	const target = opts?.target ?? resolveAntigravityAcpTarget(platform, arch);
	if (!target) {
		throw new Error(`Antigravity ACP has no pinned build for ${platform}-${arch}`);
	}
	const existing = await getAntigravityAcpInstall();
	if (existing && !opts?.force && existing.version === ANTIGRAVITY_ACP_VERSION) {
		return existing;
	}

	const fetchImpl = opts?.fetchImpl ?? fetch;
	const dest = versionDir(ANTIGRAVITY_ACP_VERSION);
	const staging = `${dest}.staging-${process.pid}`;
	await fs.rm(staging, { recursive: true, force: true });
	await fs.mkdir(staging, { recursive: true });
	const archive = path.join(staging, "agy-acp-server.zip");
	let executablePath: string;
	try {
		opts?.onProgress?.(`Downloading Antigravity ACP server ${ANTIGRAVITY_ACP_VERSION}...`);
		const response = await fetchImpl(target.archive);
		if (!response.ok || !response.body) {
			throw new Error(`Download failed: HTTP ${response.status}`);
		}
		await Bun.write(archive, response.body);
		opts?.onProgress?.("Verifying archive checksum...");
		const actual = await sha256File(archive);
		if (actual !== target.sha256) {
			throw new Error(`Checksum mismatch: expected ${target.sha256}, got ${actual}`);
		}
		await extractZip(archive, staging, opts?.onProgress);
		const found = await findExecutable(staging, antigravityAcpExecutableName(platform));
		if (!found) {
			throw new Error(`Archive did not contain ${antigravityAcpExecutableName(platform)}`);
		}
		if (platform !== "win32") {
			await fs.chmod(found, 0o755);
			await fs.chmod(path.join(path.dirname(found), antigravityAcpHarnessName(platform)), 0o755).catch(() => {});
		}
		await fs.rm(archive, { force: true });
		await fs.rm(dest, { recursive: true, force: true });
		await fs.rename(staging, dest);
		await Bun.write(
			path.join(antigravityConfigRoot(), "state.json"),
			`${JSON.stringify({ version: ANTIGRAVITY_ACP_VERSION }, null, 2)}\n`,
		);
		executablePath = path.join(dest, path.relative(staging, found));
		opts?.onProgress?.("Antigravity ACP server installed.");
	} catch (err) {
		await fs.rm(staging, { recursive: true, force: true });
		throw err;
	}

	// Remove superseded installs; auth profiles are never touched.
	if (existing && existing.version !== "override" && existing.version !== ANTIGRAVITY_ACP_VERSION) {
		await fs.rm(versionDir(existing.version), { recursive: true, force: true }).catch(() => {});
	}

	return {
		version: ANTIGRAVITY_ACP_VERSION,
		root: dest,
		executablePath,
		harnessPath: existsNow(path.join(dest, antigravityAcpHarnessName(platform))),
		profileDir: "",
	};
}

/** Installs when missing or stale; no-op when the pinned version is present. */
export async function ensureAntigravityAcpInstalled(opts?: {
	onProgress?: (message: string) => void;
	fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}): Promise<AntigravityAcpInstall> {
	const install = await getAntigravityAcpInstall();
	if (install && (install.version === ANTIGRAVITY_ACP_VERSION || install.version === "override")) {
		return install;
	}
	return installAntigravityAcp(opts);
}

/** Updates to the pinned version even when an older one is installed. */
export async function updateAntigravityAcp(opts?: {
	onProgress?: (message: string) => void;
	fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}): Promise<AntigravityAcpInstall> {
	return installAntigravityAcp({ ...opts, force: true });
}

/** Removes managed installs (auth profiles are preserved). */
export async function removeAntigravityAcp(): Promise<void> {
	if (antigravityAcpRootOverride()) {
		logger.warn("OMP_ANTIGRAVITY_ACP_PATH is set; managed removal leaves the override binary alone");
	}
	await fs.rm(versionsRoot(), { recursive: true, force: true });
	await fs.rm(path.join(antigravityConfigRoot(), "state.json"), { force: true });
}

let leaseChain: Promise<void> = Promise.resolve();

/**
 * In-process promise chain so one omp process serializes install/spawn churn
 * across sessions. Cross-process races are bounded: installs stage in a
 * private temp dir and only the final rename is shared.
 */
export async function withAntigravityAcpLease<T>(fn: () => Promise<T>): Promise<T> {
	const turn = leaseChain.then(fn);
	leaseChain = turn.then(
		() => undefined,
		() => undefined,
	);
	return turn;
}
