import { afterEach, expect, test, vi } from "bun:test";
import { streamGoogleGeminiCli } from "@oh-my-pi/pi-ai/providers/google-gemini-cli";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const CCA_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const FLASH_FIRST_EVENT_TIMEOUT_MS = 60_000;
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
const cliModel: Model<"google-gemini-cli"> = buildModel({
	id: "gemini-3-flash",
	name: "Gemini 3 Flash (CCA)",
	api: "google-gemini-cli",
	provider: "google-gemini-cli",
	baseUrl: CCA_ENDPOINT,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_000,
});

function responseWithUrl(response: Response): Response {
	Object.defineProperty(response, "url", { value: `${CCA_ENDPOINT}/v1internal:streamGenerateContent?alt=sse` });
	return response;
}

afterEach(() => {
	vi.useRealTimers();
});

test("Cloud Code Assist stream times out when headers arrive without a first SSE event", async () => {
	const bodyReadStarted = Promise.withResolvers<void>();
	const bodyStall = Promise.withResolvers<void>();
	let bodyCancelled = false;
	vi.useFakeTimers();

	const fetchMock: FetchImpl = async () =>
		responseWithUrl(
			new Response(
				new ReadableStream({
					pull() {
						bodyReadStarted.resolve();
						return bodyStall.promise;
					},
					cancel() {
						bodyStall.resolve();
						bodyCancelled = true;
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			),
		);

	const stream = streamGoogleGeminiCli(cliModel, context, {
		apiKey: JSON.stringify({ token: "token", projectId: "proj-123" }),
		streamFirstEventTimeoutMs: FLASH_FIRST_EVENT_TIMEOUT_MS,
		fetch: fetchMock,
	});
	const resultPromise = stream.result();
	await bodyReadStarted.promise;
	expect(vi.getTimerCount()).toBeGreaterThan(0);
	vi.advanceTimersByTime(FLASH_FIRST_EVENT_TIMEOUT_MS * 2);
	const result = await resultPromise;

	expect(bodyCancelled).toBe(true);
	expect(result.stopReason).toBe("error");
	expect(result.errorMessage).toContain("Cloud Code Assist stream timed out while waiting for the first event");
});
