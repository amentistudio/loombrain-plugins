import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { CaptureApiPayload, CaptureApiResponse, CaptureChunk, CliConfig } from "./types";
import { logError } from "./logger";

const DEFAULT_API_URL = "https://api.loombrain.com";
const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "loombrain", "config.json");

export interface AuthResult {
	header: string;
	apiUrl: string;
}

/**
 * Resolve authentication from env vars or config file.
 * Returns null if no auth source is available.
 */
export async function resolveAuth(configPath = DEFAULT_CONFIG_PATH): Promise<AuthResult | null> {
	const apiUrl = process.env.LB_API_URL ?? DEFAULT_API_URL;

	// Priority 1: env var
	const token = process.env.LB_TOKEN ?? process.env.LB_API_KEY;
	if (token) {
		return { header: `ApiKey ${token}`, apiUrl };
	}

	// Priority 2: config file
	try {
		if (!existsSync(configPath)) return null;
		const raw = await readFile(configPath, "utf-8");
		const config: CliConfig = JSON.parse(raw);

		// Check if token needs refresh (within 60s of expiry)
		if (config.expires_at * 1000 < Date.now() + 60_000) {
			const refreshed = await refreshToken(config, configPath);
			if (refreshed) {
				return {
					header: `Bearer ${refreshed.access_token}`,
					apiUrl: refreshed.api_url ?? apiUrl,
				};
			}
			return null;
		}

		return {
			header: `Bearer ${config.access_token}`,
			apiUrl: config.api_url ?? apiUrl,
		};
	} catch {
		return null;
	}
}

async function refreshToken(
	config: CliConfig,
	configPath: string,
): Promise<CliConfig | null> {
	try {
		const res = await fetch(`${config.api_url}/api/v1/auth/refresh`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refresh_token: config.refresh_token }),
		});

		if (!res.ok) return null;

		const data = (await res.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		const updated: CliConfig = {
			api_url: config.api_url,
			access_token: data.access_token,
			refresh_token: data.refresh_token,
			expires_at: Math.floor(Date.now() / 1000) + data.expires_in,
		};

		// Atomic write
		const dir = dirname(configPath);
		await mkdir(dir, { recursive: true });
		const tmp = `${configPath}.tmp.${Date.now()}`;
		await writeFile(tmp, JSON.stringify(updated, null, 2), { mode: 0o600 });
		await rename(tmp, configPath);

		return updated;
	} catch {
		return null;
	}
}

/**
 * Build a CaptureApiPayload from a CaptureChunk.
 */
export function buildCapturePayload(chunk: CaptureChunk): CaptureApiPayload {
	const payload: CaptureApiPayload = {
		title: chunk.title,
		content_type: "session",
		source: "agent",
		captured_at: new Date().toISOString(),
		why: "Auto-captured Claude Code session",
		session_id: chunk.session_id,
		episode_events: chunk.events,
	};
	if (chunk.para_hint) {
		payload.para_hint = chunk.para_hint;
	}
	return payload;
}

/**
 * Post a capture to the LoomBrain API.
 * Retries once on 429. Returns the response or null on failure.
 */
export async function postCapture(
	payload: CaptureApiPayload,
	auth: AuthResult,
	sessionId: string,
): Promise<CaptureApiResponse | null> {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const res = await fetch(`${auth.apiUrl}/api/v1/captures`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: auth.header,
				},
				body: JSON.stringify(payload),
			});

			if (res.ok) {
				return (await res.json()) as CaptureApiResponse;
			}

			if (res.status === 429 && attempt === 0) {
				const retryAfter = Number(res.headers.get("Retry-After") ?? "2");
				await new Promise((r) => setTimeout(r, retryAfter * 1000));
				continue;
			}

			if (res.status === 403) {
				const body = await res.text();
				if (body.includes("episodic_memory")) {
					await logError(sessionId, "Episodic memory not enabled for this tenant");
				} else {
					await logError(sessionId, `Auth failed (403): ${body.slice(0, 200)}`);
				}
				return null;
			}

			await logError(sessionId, `API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
			return null;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			await logError(sessionId, `Network error: ${msg}`);
			if (attempt === 0) {
				await new Promise((r) => setTimeout(r, 2000));
				continue;
			}
			return null;
		}
	}
	return null;
}
