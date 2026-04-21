import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type AuthState = "ok" | "missing" | "stale";

export interface AuthStatus {
	state: AuthState;
	message?: string;
}

export interface CheckAuthOpts {
	env: { LB_TOKEN?: string; LB_API_KEY?: string };
	configPath: string;
	now: number;
}

const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

const MISSING_MESSAGE =
	"LoomBrain session capture INACTIVE — not logged in. Sessions will NOT be saved. Run /lb:login to enable capture.";

const STALE_MESSAGE =
	"LoomBrain token expired more than 30 days ago — refresh will fail. Run /lb:login to re-authenticate.";

export async function checkAuth(opts: CheckAuthOpts): Promise<AuthStatus> {
	if (opts.env.LB_TOKEN || opts.env.LB_API_KEY) {
		return { state: "ok" };
	}

	if (!existsSync(opts.configPath)) {
		return { state: "missing", message: MISSING_MESSAGE };
	}

	let config: { expires_at?: unknown };
	try {
		const raw = await readFile(opts.configPath, "utf-8");
		config = JSON.parse(raw);
	} catch {
		return { state: "missing", message: MISSING_MESSAGE };
	}

	if (typeof config.expires_at !== "number") {
		return { state: "missing", message: MISSING_MESSAGE };
	}

	const expiresAtMs = config.expires_at * 1000;
	const msPastExpiry = opts.now - expiresAtMs;

	if (msPastExpiry > REFRESH_TOKEN_LIFETIME_MS) {
		return { state: "stale", message: STALE_MESSAGE };
	}

	return { state: "ok" };
}

export function resolveDefaultConfigPath(home: string): string {
	return join(home, ".config", "loombrain", "config.json");
}

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Returns true the first time called for a given session id within markerDir,
 * false on subsequent calls. Used by UserPromptSubmit hook to avoid repeat
 * warnings across prompts in the same session.
 *
 * Unsafe ids (path traversal, shell metachars, empty) return true but do NOT
 * persist a marker — caller will warn but repeat warnings that session.
 */
export async function shouldWarnOnce(sessionId: string, markerDir: string): Promise<boolean> {
	if (!SAFE_SESSION_ID_RE.test(sessionId)) {
		return true;
	}
	const marker = join(markerDir, `auth-warned-${sessionId}`);
	if (existsSync(marker)) {
		return false;
	}
	try {
		await mkdir(markerDir, { recursive: true });
		await writeFile(marker, "");
	} catch {
		// Best-effort — fall back to warning each time if we can't persist
	}
	return true;
}

export function resolveDefaultMarkerDir(home: string): string {
	return process.env.LB_STATE_DIR ?? join(home, ".loombrain-sessions");
}

async function readStdinJson(): Promise<{ session_id?: string; hook_event_name?: string }> {
	try {
		const raw = await new Response(Bun.stdin.stream()).text();
		if (!raw.trim()) return {};
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

export async function main(): Promise<number> {
	const home = process.env.HOME ?? "";
	const status = await checkAuth({
		env: {
			LB_TOKEN: process.env.LB_TOKEN,
			LB_API_KEY: process.env.LB_API_KEY,
		},
		configPath: resolveDefaultConfigPath(home),
		now: Date.now(),
	});

	if (status.state === "ok" || !status.message) {
		return 0;
	}

	const input = await readStdinJson();
	// Dedupe repeat warnings within one session for UserPromptSubmit.
	// SessionStart always warns (no dedupe) so it shows as the banner.
	if (input.hook_event_name === "UserPromptSubmit" && input.session_id) {
		const shouldWarn = await shouldWarnOnce(
			input.session_id,
			resolveDefaultMarkerDir(home),
		);
		if (!shouldWarn) return 0;
	}

	process.stdout.write(`⚠️  ${status.message}\n`);
	return 0;
}

if (import.meta.main) {
	main()
		.then((code) => process.exit(code))
		.catch(() => process.exit(0));
}
