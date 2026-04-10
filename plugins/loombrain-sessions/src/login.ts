#!/usr/bin/env bun
/**
 * Standalone login script for LoomBrain.
 * Implements the same browser-based OAuth flow as `lb login`:
 * 1. Start local callback server on random port
 * 2. Open browser to app.loombrain.com/auth/login
 * 3. Receive tokens via redirect
 * 4. Write to ~/.config/loombrain/config.json
 *
 * Run: bun run src/login.ts
 */

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile, rename, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const API_URL = process.env.LB_API_URL ?? "https://api.loombrain.com";
const DASHBOARD_URL = process.env.LB_DASHBOARD_URL ?? "https://app.loombrain.com";
const CONFIG_DIR = join(homedir(), ".config", "loombrain");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface Tokens {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	state?: string | null;
}

// ── Check existing auth ──────────────────────────────────────────────

async function isAlreadyLoggedIn(): Promise<boolean> {
	if (process.env.LB_TOKEN || process.env.LB_API_KEY) {
		return true;
	}
	try {
		if (!existsSync(CONFIG_FILE)) return false;
		const raw = await readFile(CONFIG_FILE, "utf-8");
		const config = JSON.parse(raw);
		return Boolean(config.access_token);
	} catch {
		return false;
	}
}

// ── Callback HTML ────────────────────────────────────────────────────

function buildCallbackHtml(nonce: string): string {
	return `<html><body><script>
const hash = window.location.hash.substring(1);
if (!hash) {
  document.body.textContent = 'Waiting for login...';
} else {
  window.history.replaceState({}, '', window.location.pathname);
  const params = new URLSearchParams(hash);
  const error = params.get('error');
  if (error) {
    fetch('/callback/receive', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ error, state: params.get('state'), nonce: '${nonce}' })
    }).then(function(r) {
      document.body.textContent = r.ok ? 'Error: ' + error : 'Failed to deliver error.';
    });
  } else {
    fetch('/callback/receive', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        access_token: params.get('access_token'),
        refresh_token: params.get('refresh_token'),
        expires_in: Number(params.get('expires_in')),
        state: params.get('state'),
        nonce: '${nonce}'
      })
    }).then(function(r) {
      document.body.textContent = r.ok
        ? 'Login successful! You can close this tab.'
        : 'Failed to deliver tokens.';
    });
  }
}
</script></body></html>`;
}

// ── Read POST body ───────────────────────────────────────────────────

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		req.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > 64 * 1024) {
				req.destroy();
				reject(new Error("Body too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}

// ── Write config ─────────────────────────────────────────────────────

async function writeConfig(tokens: Tokens): Promise<void> {
	const config = {
		api_url: API_URL,
		access_token: tokens.access_token,
		refresh_token: tokens.refresh_token,
		expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
	};
	await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
	const tmp = join(CONFIG_DIR, `.config.json.${Date.now()}.tmp`);
	await writeFile(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
	await rename(tmp, CONFIG_FILE);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	// Check if already logged in
	if (await isAlreadyLoggedIn()) {
		console.log("Already logged in to LoomBrain.");
		console.log(`Config: ${CONFIG_FILE}`);
		process.exit(0);
	}

	console.log("Logging in to LoomBrain...\n");

	const nonce = randomBytes(16).toString("hex");
	let received = false;

	const { promise, resolve, reject } = Promise.withResolvers<Tokens>();

	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");

		if (req.method === "GET" && url.pathname === "/callback") {
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(buildCallbackHtml(nonce));
			return;
		}

		if (req.method === "POST" && url.pathname === "/callback/receive") {
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(await readBody(req)) as Record<string, unknown>;
			} catch {
				res.writeHead(400);
				res.end("Bad Request");
				return;
			}

			if (body.nonce !== nonce) {
				res.writeHead(403);
				res.end("Forbidden");
				return;
			}

			if (received) {
				res.writeHead(409);
				res.end("Already received");
				return;
			}
			received = true;
			res.writeHead(200);
			res.end("OK");
			setTimeout(() => server.close(), 100);

			if (body.error) {
				reject(new Error(String(body.error)));
				return;
			}

			if (
				typeof body.access_token !== "string" ||
				!body.access_token ||
				typeof body.refresh_token !== "string" ||
				!body.refresh_token ||
				typeof body.expires_in !== "number" ||
				!Number.isFinite(body.expires_in)
			) {
				reject(new Error("Received invalid tokens"));
				return;
			}

			resolve({
				access_token: body.access_token as string,
				refresh_token: body.refresh_token as string,
				expires_in: body.expires_in as number,
				state: body.state != null ? String(body.state) : null,
			});
			return;
		}

		res.writeHead(404);
		res.end("Not Found");
	});

	// Clean up on Ctrl+C
	process.once("SIGINT", () => {
		server.close();
		process.exit(1);
	});

	await new Promise<void>((res, rej) => {
		server.listen(0, "127.0.0.1", () => res());
		server.on("error", rej);
	});

	const addr = server.address();
	if (!addr || typeof addr === "string") {
		console.error("Failed to start callback server");
		process.exit(1);
	}

	const port = addr.port;
	const loginUrl = `${DASHBOARD_URL}/auth/login?redirect_uri=${encodeURIComponent(`http://127.0.0.1:${port}/callback`)}&state=${nonce}`;

	// Timeout
	const timeout = setTimeout(() => {
		server.close();
		reject(new Error("Login timed out (5 minutes). Try again."));
	}, TIMEOUT_MS);

	// Open browser
	console.log(`Opening browser...\n`);
	console.log(`  ${loginUrl}\n`);
	console.log("If the browser doesn't open, copy the URL above and paste it in your browser.\n");
	console.log("Waiting for login...");

	try {
		const { default: open } = await import("open");
		await open(loginUrl);
	} catch {
		console.log("Could not open browser automatically. Please open the URL above manually.");
	}

	try {
		const tokens = promise;
		const result = await tokens;

		if (result.state !== nonce) {
			throw new Error("State mismatch. Please try again.");
		}

		await writeConfig(result);
		clearTimeout(timeout);
		console.log("\nLogged in successfully!");
		console.log(`Config saved to: ${CONFIG_FILE}`);
	} catch (err) {
		clearTimeout(timeout);
		console.error(`\nLogin failed: ${err instanceof Error ? err.message : err}`);
		process.exit(1);
	}
}

main();
