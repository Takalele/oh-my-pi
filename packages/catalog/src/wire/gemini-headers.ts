/**
 * Build a User-Agent string that identifies as Gemini CLI to unlock higher rate limits.
 * Uses the same format as the official Gemini CLI (v0.35+):
 * GeminiCLI/VERSION/MODEL (PLATFORM; ARCH; SURFACE)
 */
export function getGeminiCliUserAgent(modelId = "gemini-3.1-pro-preview"): string {
	const version = process.env.PI_AI_GEMINI_CLI_VERSION || "0.46.0";
	const platform = process.platform === "win32" ? "win32" : process.platform;
	const arch = process.arch === "x64" ? "x64" : process.arch;
	return `GeminiCLI/${version}/${modelId} (${platform}; ${arch}; terminal)`;
}

export const getGeminiCliHeaders = (modelId?: string) => ({
	"User-Agent": getGeminiCliUserAgent(modelId),
	"Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
});
