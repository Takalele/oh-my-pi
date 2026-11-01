/**
 * Pinned release manifest for the official Google Antigravity ACP server.
 *
 * ToS compliance: Antigravity models may only be reached by driving Google's
 * unmodified `antigravity-acp` binary from the ACP Registry
 * (https://github.com/agentclientprotocol/registry, antigravity-acp/agent.json).
 * These pins mirror the upstream manifest verbatim — bump by re-reading the
 * registry, never by inventing URLs or hashes.
 */

/** Pinned upstream manifest version (antigravity-acp/agent.json). */
export const ANTIGRAVITY_ACP_VERSION = "1.4.5";

/** One platform's binary distribution entry. */
export interface AntigravityAcpTarget {
	/** Zip archive download URL. */
	readonly archive: string;
	/** sha256 of the archive bytes. */
	readonly sha256: string;
	/** Executable to spawn inside the extracted tree. */
	readonly cmd: string;
	/** Fixed spawn arguments (Linux requires `--uid=`). */
	readonly args?: readonly string[];
}

const TARGETS: Readonly<Partial<Record<`${NodeJS.Platform}-${string}`, AntigravityAcpTarget>>> = {
	"darwin-arm64": {
		archive: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip",
		sha256: "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f",
		cmd: "./agy_acp_server.par",
	},
	"darwin-x64": {
		archive: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-x86_64.zip",
		sha256: "b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a",
		cmd: "./agy_acp_server.par",
	},
	"linux-x64": {
		archive: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-x86_64.zip",
		sha256: "923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b",
		cmd: "./agy_acp_server.par",
		args: ["--uid="],
	},
	"linux-arm64": {
		archive: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-arm64.zip",
		sha256: "7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056",
		cmd: "./agy_acp_server.par",
		args: ["--uid="],
	},
	"win32-x64": {
		archive: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-x86_64.zip",
		sha256: "d24f4c73c9f96d4f44384e281c855a56c72d8eaa9c5b0fad7ccb1635c6b63f50",
		cmd: "./agy_acp_server.exe",
	},
	"win32-arm64": {
		archive: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-arm64.zip",
		sha256: "ab0a9aac8349e08ef289be6d16da8f89e3abe60eba5158032ef78c4a1220261c",
		cmd: "./agy_acp_server.exe",
	},
};

/** Resolves the pinned distribution for a platform/arch, or null when unsupported. */
export function resolveAntigravityAcpTarget(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): AntigravityAcpTarget | null {
	return TARGETS[`${platform}-${arch}`] ?? null;
}

/** Executable file name inside the archive for a platform. */
export function antigravityAcpExecutableName(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par";
}

/** Harness executable the ACP server forks beside itself. */
export function antigravityAcpHarnessName(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "localharness_external.exe" : "localharness_external";
}
