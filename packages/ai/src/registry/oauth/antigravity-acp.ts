/**
 * Sign-in for the `antigravity` provider. omp does NOT run its own OAuth flow
 * and never sees Google tokens: it installs the pinned official `antigravity-
 * acp` binary, starts it under a private profile home, and relays the URL the
 * binary itself prints for `authenticate {methodId: "oauth-personal"}`. The
 * binary performs the browser sign-in and persists the tokens in its own
 * profile (ToS: the unmodified official client owns the credential).
 *
 * The stored credential is a marker (see placeholder below): its presence is
 * what marks the provider as signed in for omp's registry; refresh is a no-op
 * passthrough because there is nothing on omp's side to refresh.
 */
import {
	ensureAntigravityAcpInstalled,
	ensureAntigravityProfile,
	getAntigravityAcpInstall,
	parseAntigravityAcpAuthUrl,
	withAntigravityAcpLease,
	connectAntigravityAcp,
	type AntigravityAcpConnection,
} from "@oh-my-pi/pi-utils/antigravity";
import { logger } from "@oh-my-pi/pi-utils";
import type { LoginHook, RefreshHook } from "../hooks/types";
import type { OAuthController, OAuthCredentials } from "./types";

/** Marker access value; the real Google grant lives in the binary's profile. */
export const ANTIGRAVITY_ACP_MARKER_ACCESS = "antigravity-acp";
/** The only sign-in method omp drives (personal plan; business/Vertex out of scope). */
const AUTH_METHOD_ID = "oauth-personal";
/**
 * No expiry: the marker never expires on omp's side. The binary reports an
 * expired Google session as an authenticate failure, surfaced as a
 * re-login hint at use time.
 */
const MARKER_EXPIRES = Number.MAX_SAFE_INTEGER;

function markerCredentials(): OAuthCredentials {
	return {
		refresh: "",
		access: ANTIGRAVITY_ACP_MARKER_ACCESS,
		expires: MARKER_EXPIRES,
	};
}

export const loginAntigravityAcpHook: LoginHook = async (callbacks: OAuthController): Promise<OAuthCredentials> => {
	callbacks.onProgress?.("Installing the official Antigravity ACP server...");
	await ensureAntigravityAcpInstalled({ onProgress: message => callbacks.onProgress?.(message) });

	callbacks.onProgress?.("Starting Antigravity sign-in...");
	const credentials = await withAntigravityAcpLease(() => runSignIn(callbacks));
	callbacks.onProgress?.("Antigravity signed in.");
	return credentials;
};

async function runSignIn(callbacks: OAuthController): Promise<OAuthCredentials> {
	const install = await getAntigravityAcpInstall();
	if (!install) {
		throw new Error("Antigravity ACP install vanished during sign-in; re-run `omp antigravity install`.");
	}
	const profileHome = await ensureAntigravityProfile("oauth-personal");

	let seenText = "";
	let resolvedAuthUrl: string | undefined;
	const reportAuthUrl = (): void => {
		if (resolvedAuthUrl) return;
		const url = parseAntigravityAcpAuthUrl(seenText);
		if (!url) return;
		resolvedAuthUrl = url;
		callbacks.onAuth?.({
			url,
			instructions: "Complete the Google sign-in in your browser. The Antigravity server finishes on its own.",
		});
	};

	let connection: AntigravityAcpConnection | undefined;
	try {
		connection = await connectAntigravityAcp({
			executablePath: install.executablePath,
			profileHome,
			authType: "oauth-personal",
			workspaceDir: process.cwd(),
			harnessPath: install.harnessPath,
			onAuthText: text => {
				seenText += text;
				reportAuthUrl();
			},
			client: () => ({
				async requestPermission(params) {
					const reject = params.options.find(option => option.kind === "reject_once");
					return reject
						? { outcome: { outcome: "selected", optionId: reject.optionId } }
						: { outcome: { outcome: "cancelled" } };
				},
				sessionUpdate() {},
			}),
		});
		const initialized = await connection.connection.initialize({
			protocolVersion: 1,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
		});
		const advertised = initialized.authMethods?.some(method => method.id === AUTH_METHOD_ID);
		if (initialized.authMethods && !advertised) {
			logger.debug("Antigravity authenticate: method not advertised, sending anyway", {
				methods: initialized.authMethods.map(method => method.id),
			});
		}
		// `authenticate` blocks until the browser flow finishes; the URL only
		// appears after the call starts, so drive it unawaited and watch text.
		const authResult = connection.connection.authenticate({ methodId: AUTH_METHOD_ID });
		let abortWatcher: Promise<never> | undefined;
		if (callbacks.signal) {
			const resolvers = Promise.withResolvers<never>();
			callbacks.signal.addEventListener(
				"abort",
				() => resolvers.reject(new Error("Antigravity sign-in cancelled.")),
				{ once: true },
			);
			abortWatcher = resolvers.promise;
		}
		await Promise.race([authResult, ...(abortWatcher ? [abortWatcher] : [])]);
		// A signed-in binary answers authenticate immediately without a URL.
		return markerCredentials();
	} catch (error) {
		if (callbacks.signal?.aborted) throw new Error("Antigravity sign-in cancelled.");
		throw error;
	} finally {
		if (connection) {
			connection.kill();
			const grace = Promise.withResolvers<void>();
			setTimeout(grace.resolve, 3_000);
			await Promise.race([connection.exited, grace.promise]);
		}
	}
}

/** The binary owns its tokens; omp's stored marker never rotates. */
export const refreshAntigravityAcpHook: RefreshHook = async (
	credentials: OAuthCredentials,
): Promise<OAuthCredentials> =>
	credentials.access === ANTIGRAVITY_ACP_MARKER_ACCESS ? credentials : markerCredentials();
