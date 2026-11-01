import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ANTIGRAVITY_ACP_VERSION,
	ensureAntigravityAcpInstalled,
	getAntigravityAcpStatus,
	installAntigravityAcp,
	removeAntigravityAcp,
	resolveAntigravityAcpTarget,
} from "../src/antigravity";
import { $which } from "../src/which";

describe("antigravity release pins", () => {
	it("carries a verified sha256 for every supported platform", () => {
		for (const [platform, arch] of [
			["darwin", "arm64"],
			["darwin", "x64"],
			["linux", "x64"],
			["linux", "arm64"],
			["win32", "x64"],
			["win32", "arm64"],
		] as const) {
			const target = resolveAntigravityAcpTarget(platform, arch);
			expect(target, `${platform}-${arch}`).not.toBeNull();
			expect(target!.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(target!.archive.startsWith("https://dl.google.com/agy-extensions/releases/")).toBe(true);
			expect(target!.cmd.includes("agy_acp_server")).toBe(true);
		}
	});

	it("requires --uid= on Linux", () => {
		expect(resolveAntigravityAcpTarget("linux", "x64")!.args).toEqual(["--uid="]);
	});
});

describe("antigravity managed install", () => {
	let configDir: string;
	let previousConfigDir: string | undefined;
	const zipTool = $which("zip");

	beforeEach(async () => {
		previousConfigDir = process.env.PI_CONFIG_DIR;
		configDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agy-install-"));
		process.env.PI_CONFIG_DIR = configDir;
	});

	afterEach(async () => {
		if (previousConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
		else process.env.PI_CONFIG_DIR = previousConfigDir;
		await fs.rm(configDir, { recursive: true, force: true });
	});

	async function makeArchive(entries: Record<string, string>): Promise<Uint8Array> {
		if (!zipTool) throw new Error("zip unavailable");
		const stage = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agy-zipsrc-"));
		for (const [name, body] of Object.entries(entries)) {
			const target = path.join(stage, name);
			await fs.mkdir(path.dirname(target), { recursive: true });
			await Bun.write(target, body);
		}
		await $`${zipTool} -qr out.zip .`.cwd(stage).quiet();
		const bytes = await Bun.file(path.join(stage, "out.zip")).bytes();
		await fs.rm(stage, { recursive: true, force: true });
		return bytes;
	}

	function serveArchive(bytes: Uint8Array): {
		fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
		calls: () => number;
	} {
		let calls = 0;
		return {
			calls: () => calls,
			fetchImpl: (async () => {
				calls += 1;
				return new Response(new Blob([bytes]), { status: 200 });
			}) as (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
		};
	}

	function targetFor(bytes: Uint8Array) {
		return {
			archive: "https://example.invalid/agy.zip",
			sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
			cmd: "./agy_acp_server.par",
			args: ["--uid="] as const,
		};
	}

	it("installs idempotently with the pinned version and an executable layout", async () => {
		const archive = await makeArchive({
			"agy_acp_server.par": "#!/bin/sh\necho fake\n",
			localharness_external: "#!/bin/sh\necho harness\n",
		});
		const install = await installAntigravityAcp({
			fetchImpl: serveArchive(archive).fetchImpl,
			target: targetFor(archive),
			platform: "linux",
			arch: "x64",
		});
		expect(install.version).toBe(ANTIGRAVITY_ACP_VERSION);
		await fs.stat(install.executablePath);
		expect(install.harnessPath).not.toBeNull();
		const status = await getAntigravityAcpStatus();
		expect(status.upToDate).toBe(true);
		expect(status.source).toBe("managed");

		// Second call must not re-fetch: ensure-installed short-circuits.
		const counted = serveArchive(archive);
		const again = await ensureAntigravityAcpInstalled({ fetchImpl: counted.fetchImpl });
		expect(counted.calls()).toBe(0);
		expect(again.executablePath).toBe(install.executablePath);
	});

	it("fails closed when the archive sha256 does not match the manifest", async () => {
		const archive = await makeArchive({ "agy_acp_server.par": "tampered" });
		let message = "";
		try {
			await installAntigravityAcp({
				fetchImpl: serveArchive(archive).fetchImpl,
				target: {
					archive: "https://example.invalid/agy.zip",
					sha256: "0".repeat(64),
					cmd: "./agy_acp_server.par",
				},
				platform: "linux",
				arch: "x64",
			});
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain("Checksum mismatch");
		expect(message).toContain("0".repeat(64));
		// Nothing half-installed may remain.
		const status = await getAntigravityAcpStatus();
		expect(status.installed).toBe(false);
	});

	it("rejects archives whose members escape the target directory", async () => {
		// python zipfile stores arbitrary member names the `zip` CLI refuses.
		const stage = await fs.mkdtemp(path.join(os.tmpdir(), "omp-agy-slip-"));
		const zipPath = path.join(stage, "out.zip");
		const child = Bun.spawn([
			"python3",
			"-c",
			"import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('../escape','nope'); z.writestr('agy_acp_server.par','x')",
			zipPath,
		]);
		await child.exited;
		const archive = await Bun.file(zipPath).bytes();
		await fs.rm(stage, { recursive: true, force: true });
		let message = "";
		try {
			await installAntigravityAcp({
				fetchImpl: serveArchive(archive).fetchImpl,
				target: targetFor(archive),
				platform: "linux",
				arch: "x64",
			});
		} catch (err) {
			message = (err as Error).message;
		}
		expect(message).toContain("outside target directory");
		const status = await getAntigravityAcpStatus();
		expect(status.installed).toBe(false);
	});

	it("removes installs while preserving auth profiles", async () => {
		const archive = await makeArchive({ "agy_acp_server.par": "#!/bin/sh\n" });
		await installAntigravityAcp({
			fetchImpl: serveArchive(archive).fetchImpl,
			target: targetFor(archive),
			platform: "linux",
			arch: "x64",
		});
		const profiles = path.join(configDir, "antigravity-acp", "profiles", "keepme");
		await fs.mkdir(profiles, { recursive: true });
		await Bun.write(path.join(profiles, "marker"), "x");
		await removeAntigravityAcp();
		const status = await getAntigravityAcpStatus();
		expect(status.installed).toBe(false);
		await fs.stat(path.join(profiles, "marker"));
	});
});
