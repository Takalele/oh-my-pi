/**
 * Spawns the official Antigravity ACP server and binds omp's ACP client to
 * its stdio pipes. Deliberately thin: the protocol conversation (initialize,
 * authenticate, sessions, prompts) lives with the caller; this module owns
 * process lifecycle only, so cancel/teardown semantics have one owner.
 */
import type { Subprocess } from "bun";
import { ClientSideConnection, ndJsonStream, type Client } from "../acp";
import { buildAntigravityAcpEnv, antigravityAuthBrowserHelper, antigravityBrowserHookSupported } from "./auth";
import type { AntigravityAuthType } from "./auth";
import { resolveAntigravityAcpTarget } from "./release";

/** Live Antigravity ACP server process bound to a client connection. */
export interface AntigravityAcpConnection {
	connection: ClientSideConnection;
	child: Subprocess<"pipe", "pipe", "pipe">;
	/** Accumulated stderr tail (auth URL marker lines land here). */
	stderrText(): string;
	/** Kills the server and every harness child it forked. */
	kill(): void;
	/** Resolves once the process has exited. */
	exited: Promise<void>;
}

/**
 * Bun hands subprocess stdin as a FileSink, not a WritableStream. Never
 * await write/flush: a stalled child drains at its own pace and parked
 * awaits would hang the RPC writer (same lesson as the MCP stdio transport).
 */
function fileSinkToWritable(sink: Bun.FileSink): WritableStream<Uint8Array> {
	return new WritableStream<Uint8Array>({
		write(chunk) {
			try {
				const wrote = sink.write(chunk);
				if (wrote instanceof Promise) wrote.catch(() => {});
				const flushed = sink.flush();
				if (flushed instanceof Promise) flushed.catch(() => {});
			} catch {
				// EPIPE after child exit: the readable side closes and the
				// RpcConnection tears down; writes during teardown are moot.
			}
		},
		close() {
			try {
				sink.end();
			} catch {
				// already closed
			}
		},
	});
}
/**
 * Splits stdout into lines and routes them: JSON-RPC lines (`{…}`) pass
 * through untouched to the ndJsonStream parser; every other line is the
 * server's human-readable chatter — the `Open the following link …` sign-in
 * prompt among them — and is fed to `onAuthText` instead of reaching the
 * parser, which would JSON.parse-fail and tear down the connection.
 */
function teeStdoutForAuthText(
	stdout: ReadableStream<Uint8Array>,
	onAuthText: (text: string) => void,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	let buffered = "";
	return stdout.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffered += decoder.decode(chunk, { stream: true });
				let newline = buffered.indexOf("\n");
				while (newline >= 0) {
					const line = buffered.slice(0, newline);
					buffered = buffered.slice(newline + 1);
					if (line.trimStart().startsWith("{")) {
						controller.enqueue(encoder.encode(`${line}\n`));
					} else {
						onAuthText(`${line}\n`);
					}
					newline = buffered.indexOf("\n");
				}
			},
			flush(controller) {
				buffered += decoder.decode();
				const line = buffered.trimEnd();
				buffered = "";
				if (!line) return;
				if (line.trimStart().startsWith("{")) {
					controller.enqueue(encoder.encode(`${line}\n`));
				} else {
					onAuthText(`${line}\n`);
				}
			},
		}),
	);
}

/**
 * Starts the pinned server for `profileHome`. `executablePath` must come from
 * a verified install (or the documented OMP_ANTIGRAVITY_ACP_PATH override).
 */
export async function connectAntigravityAcp(options: {
	executablePath: string;
	profileHome: string;
	authType: AntigravityAuthType;
	workspaceDir: string;
	client: (connection: ClientSideConnection) => Client;
	harnessPath?: string | null;
	/**
	 * Receives raw text that carries the sign-in prompt. Runtime 1.4.5 prints
	 * `Open the following link to authenticate the ACP server: <url>` on
	 * **stderr** during `authenticate`; older/alternate builds may put it on
	 * stdout, which is the ndJsonStream input — the prompt line would fail
	 * JSON.parse and tear down the connection, so stdout is tee'd: JSON-RPC
	 * lines pass to the parser, every other line is handed here instead.
	 * Both channels arrive here; the parser only ever sees stdout JSON.
	 */
	onAuthText?: (text: string) => void;
}): Promise<AntigravityAcpConnection> {
	const env = await buildAntigravityAcpEnv({
		authType: options.authType,
		profileHome: options.profileHome,
		harnessPath: options.harnessPath ?? null,
	});
	// Capture the sign-in URL via BROWSER instead of launching a browser.
	if (antigravityBrowserHookSupported()) {
		env.BROWSER = antigravityAuthBrowserHelper();
	}
	const target = resolveAntigravityAcpTarget();
	const args = [...(target?.args ?? [])];

	const child = Bun.spawn([options.executablePath, ...args], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		cwd: options.workspaceDir,
		env,
		// Own process group so the forked localharness_external dies with it.
		detached: process.platform !== "win32",
	});

	let stderrBuffer = "";
	const stderrTask = (async () => {
		const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true });
			stderrBuffer += text;
			// The official binary's sign-in link lands on stderr, not stdout.
			options.onAuthText?.(text);
			// Bound retention: keep the tail; auth markers appear early.
			if (stderrBuffer.length > 256 * 1024) stderrBuffer = stderrBuffer.slice(-128 * 1024);
		}
	})();
	void stderrTask.catch(() => {});

	const stdout = child.stdout as ReadableStream<Uint8Array>;
	const stream = ndJsonStream(
		fileSinkToWritable(child.stdin),
		options.onAuthText ? teeStdoutForAuthText(stdout, options.onAuthText) : stdout,
	);
	const connection = new ClientSideConnection(options.client, stream);
	const exited = child.exited.then(() => undefined);

	return {
		connection,
		child,
		stderrText: () => stderrBuffer,
		kill: () => killAntigravityAcpProcess(child),
		exited,
	};
}

/** Kills the whole process group; falls back to the direct child on Windows. */
export function killAntigravityAcpProcess(child: Subprocess<"pipe", "pipe", "pipe">): void {
	if (child.killed || child.exitCode !== null) return;
	if (process.platform !== "win32") {
		try {
			// detached spawn puts the server in its own group led by its pid.
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// group already gone or not a leader: fall through
		}
	}
	child.kill();
}
