import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let configPath: string;

const NOW = new Date("2026-04-21T14:00:00Z").getTime();
const ONE_DAY_SEC = 86_400;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "check-auth-test-"));
	configPath = join(tempDir, "config.json");
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("checkAuth", () => {
	test("returns ok when LB_TOKEN env var is set", async () => {
		const { checkAuth } = await import("../src/check-auth");
		const result = await checkAuth({
			env: { LB_TOKEN: "tok-123" },
			configPath,
			now: NOW,
		});
		expect(result.state).toBe("ok");
	});

	test("returns ok when LB_API_KEY env var is set", async () => {
		const { checkAuth } = await import("../src/check-auth");
		const result = await checkAuth({
			env: { LB_API_KEY: "key-123" },
			configPath,
			now: NOW,
		});
		expect(result.state).toBe("ok");
	});

	test("returns missing when no env var and no config file", async () => {
		const { checkAuth } = await import("../src/check-auth");
		const result = await checkAuth({ env: {}, configPath, now: NOW });
		expect(result.state).toBe("missing");
		expect(result.message).toContain("not logged in");
		expect(result.message).toContain("/lb:login");
	});

	test("returns ok when config file is valid and not expired", async () => {
		const config = {
			api_url: "https://api.loombrain.com",
			access_token: "a",
			refresh_token: "r",
			expires_at: Math.floor(NOW / 1000) + 3600,
		};
		await writeFile(configPath, JSON.stringify(config));
		const { checkAuth } = await import("../src/check-auth");
		const result = await checkAuth({ env: {}, configPath, now: NOW });
		expect(result.state).toBe("ok");
	});

	test("returns ok when access token expired but refresh token still valid (< 30d past expiry)", async () => {
		const config = {
			api_url: "https://api.loombrain.com",
			access_token: "a",
			refresh_token: "r",
			expires_at: Math.floor(NOW / 1000) - 5 * ONE_DAY_SEC,
		};
		await writeFile(configPath, JSON.stringify(config));
		const { checkAuth } = await import("../src/check-auth");
		const result = await checkAuth({ env: {}, configPath, now: NOW });
		expect(result.state).toBe("ok");
	});

	test("returns stale when config expired more than 30 days ago", async () => {
		const config = {
			api_url: "https://api.loombrain.com",
			access_token: "a",
			refresh_token: "r",
			expires_at: Math.floor(NOW / 1000) - 31 * ONE_DAY_SEC,
		};
		await writeFile(configPath, JSON.stringify(config));
		const { checkAuth } = await import("../src/check-auth");
		const result = await checkAuth({ env: {}, configPath, now: NOW });
		expect(result.state).toBe("stale");
		expect(result.message).toContain("/lb:login");
	});

	test("returns missing when config file is malformed JSON", async () => {
		await writeFile(configPath, "not json {");
		const { checkAuth } = await import("../src/check-auth");
		const result = await checkAuth({ env: {}, configPath, now: NOW });
		expect(result.state).toBe("missing");
	});

	test("returns missing when config file lacks expires_at", async () => {
		await writeFile(configPath, JSON.stringify({ api_url: "x", access_token: "a" }));
		const { checkAuth } = await import("../src/check-auth");
		const result = await checkAuth({ env: {}, configPath, now: NOW });
		expect(result.state).toBe("missing");
	});

	test("env var takes priority over stale config", async () => {
		const config = {
			api_url: "https://api.loombrain.com",
			access_token: "a",
			refresh_token: "r",
			expires_at: Math.floor(NOW / 1000) - 365 * ONE_DAY_SEC,
		};
		await writeFile(configPath, JSON.stringify(config));
		const { checkAuth } = await import("../src/check-auth");
		const result = await checkAuth({
			env: { LB_TOKEN: "override" },
			configPath,
			now: NOW,
		});
		expect(result.state).toBe("ok");
	});

	test("empty env var strings are treated as unset", async () => {
		const { checkAuth } = await import("../src/check-auth");
		const result = await checkAuth({
			env: { LB_TOKEN: "", LB_API_KEY: "" },
			configPath,
			now: NOW,
		});
		expect(result.state).toBe("missing");
	});
});

describe("shouldWarnOnce", () => {
	test("warns on first call for a session", async () => {
		const { shouldWarnOnce } = await import("../src/check-auth");
		const markerDir = join(tempDir, "markers");
		const result = await shouldWarnOnce("sess-abc", markerDir);
		expect(result).toBe(true);
	});

	test("does not warn again for the same session", async () => {
		const { shouldWarnOnce } = await import("../src/check-auth");
		const markerDir = join(tempDir, "markers");
		await shouldWarnOnce("sess-abc", markerDir);
		const second = await shouldWarnOnce("sess-abc", markerDir);
		expect(second).toBe(false);
	});

	test("warns for a different session", async () => {
		const { shouldWarnOnce } = await import("../src/check-auth");
		const markerDir = join(tempDir, "markers");
		await shouldWarnOnce("sess-abc", markerDir);
		const other = await shouldWarnOnce("sess-xyz", markerDir);
		expect(other).toBe(true);
	});

	test("creates marker file in markerDir", async () => {
		const { shouldWarnOnce } = await import("../src/check-auth");
		const markerDir = join(tempDir, "markers");
		await shouldWarnOnce("sess-abc", markerDir);
		const marker = join(markerDir, "auth-warned-sess-abc");
		expect(existsSync(marker)).toBe(true);
	});

	test("treats empty session_id as fresh each call", async () => {
		const { shouldWarnOnce } = await import("../src/check-auth");
		const markerDir = join(tempDir, "markers");
		// Empty session_id should still warn (caller may pass "" when id unavailable)
		const first = await shouldWarnOnce("", markerDir);
		expect(first).toBe(true);
	});

	test("refuses path-traversal attempts in session_id", async () => {
		const { shouldWarnOnce } = await import("../src/check-auth");
		const markerDir = join(tempDir, "markers");
		// Must NOT escape markerDir; treat unsafe id as non-persistent warn
		const result = await shouldWarnOnce("../../etc/passwd", markerDir);
		expect(result).toBe(true);
		// Ensure no file was written outside markerDir
		expect(existsSync(join(tempDir, "etc"))).toBe(false);
	});
});
