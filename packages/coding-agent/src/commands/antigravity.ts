/**
 * Manage the official Antigravity ACP runtime omp drives as a model provider.
 *
 * `omp antigravity install` downloads + verifies the pinned release,
 * `omp antigravity update` re-checks it against the pinned version,
 * `omp antigravity remove` deletes the managed install (auth profiles stay),
 * `omp antigravity status` reports what is installed.
 *
 * Google sign-in itself lives with the binary: use `/login antigravity` in a
 * session (or `omp login antigravity`), never an omp-side token.
 */
import {
	getAntigravityAcpStatus,
	installAntigravityAcp,
	removeAntigravityAcp,
	updateAntigravityAcp,
} from "@oh-my-pi/pi-utils/antigravity";
import { Args, CliUsageError, Command } from "@oh-my-pi/pi-utils/cli";
import { antigravityHelp as commandHelp } from "../cli/command-help";

const ACTIONS = ["install", "update", "remove", "status"] as const;
type AntigravityAction = (typeof ACTIONS)[number];

function isAction(value: string): value is AntigravityAction {
	return ACTIONS.some(action => action === value);
}

function report(message: string): void {
	process.stderr.write(`${message}\n`);
}

export default class Antigravity extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({ description: ACTIONS.join(", "), required: true, options: ACTIONS }),
	};

	static examples = [
		"# Download + verify the pinned official ACP server\n  omp antigravity install",
		"# Check what is installed\n  omp antigravity status",
	];

	async run(): Promise<void> {
		const { args } = await this.parse(Antigravity);
		const action = args.action ?? "";
		if (!isAction(action)) {
			throw new CliUsageError(`Unknown action: ${action}. Expected one of: ${ACTIONS.join(", ")}.`);
		}

		switch (action) {
			case "install": {
				const install = await installAntigravityAcp({ onProgress: report });
				process.stdout.write(
					`Antigravity ACP ${install.version} installed at ${install.root}\nSign in with /login antigravity.\n`,
				);
				return;
			}
			case "update": {
				const install = await updateAntigravityAcp({ onProgress: report });
				process.stdout.write(`Antigravity ACP updated to ${install.version}.\n`);
				return;
			}
			case "remove": {
				await removeAntigravityAcp();
				process.stdout.write("Antigravity ACP runtime removed (auth profiles kept).\n");
				return;
			}
			case "status": {
				const status = await getAntigravityAcpStatus();
				if (!status.installed) {
					process.stdout.write(
						`Not installed. Pinned version: ${status.expectedVersion}. Run: omp antigravity install\n`,
					);
					return;
				}
				const state = status.upToDate ? "up to date" : `outdated (pinned ${status.expectedVersion})`;
				const source = status.source === "override" ? " (OMP_ANTIGRAVITY_ACP_PATH override)" : "";
				process.stdout.write(
					`Antigravity ACP ${status.version ?? "unknown"} — ${state}${source}\n  ${status.executablePath ?? ""}\n`,
				);
				return;
			}
		}
	}
}
