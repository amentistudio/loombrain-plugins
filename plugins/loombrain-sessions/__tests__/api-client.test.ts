import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveAuth,
	buildCapturePayload,
	postCapture,
	type AuthResult,
} from "../src/api-client";
import type { CaptureChunk, CaptureApiPayload } from "../src/types";

describe("resolveAuth", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	test("uses LB_TOKEN env var when set", async () => {
		process.env.LB_TOKEN = "test-token-123";
		const auth = await resolveAuth();
		expect(auth).not.toBeNull();
		expect(auth?.header).toBe("ApiKey test-token-123");
	});

	test("uses LB_API_KEY as alias for LB_TOKEN", async () => {
		delete process.env.LB_TOKEN;
		process.env.LB_API_KEY = "api-key-456";
		const auth = await resolveAuth();
		expect(auth).not.toBeNull();
		expect(auth?.header).toBe("ApiKey api-key-456");
	});

	test("LB_API_URL overrides default API URL", async () => {
		process.env.LB_TOKEN = "tok";
		process.env.LB_API_URL = "https://custom.api.com";
		const auth = await resolveAuth();
		expect(auth?.apiUrl).toBe("https://custom.api.com");
	});

	test("returns null when no auth source available and no config file", async () => {
		delete process.env.LB_TOKEN;
		delete process.env.LB_API_KEY;
		// resolveAuth reads config file — if it doesn't exist, returns null
		const auth = await resolveAuth("/tmp/nonexistent-loombrain-config.json");
		expect(auth).toBeNull();
	});
});

describe("buildCapturePayload", () => {
	test("builds correct payload from chunk", () => {
		const chunk: CaptureChunk = {
			session_id: "sess-1",
			title: "Claude Code session",
			events: [
				{
					seq: 0,
					role: "user",
					content: "hello",
					occurred_at: "2026-04-09T10:00:00.000Z",
				},
			],
			para_hint: "loombrain.com",
		};

		const payload = buildCapturePayload(chunk);
		expect(payload.title).toBe("Claude Code session");
		expect(payload.content_type).toBe("session");
		expect(payload.source).toBe("agent");
		expect(payload.why).toBe("Auto-captured Claude Code session");
		expect(payload.session_id).toBe("sess-1");
		expect(payload.episode_events).toHaveLength(1);
		expect(payload.para_hint).toBe("loombrain.com");
		expect(payload.captured_at).toBeDefined();
	});

	test("omits para_hint when not provided", () => {
		const chunk: CaptureChunk = {
			session_id: "sess-2",
			title: "Claude Code session",
			events: [
				{
					seq: 0,
					role: "user",
					content: "hello",
					occurred_at: "2026-04-09T10:00:00.000Z",
				},
			],
		};

		const payload = buildCapturePayload(chunk);
		expect(payload.para_hint).toBeUndefined();
	});
});

describe("postCapture success marker", () => {
	let stateDir: string;
	const originalEnv = { ...process.env };

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "api-client-test-"));
		process.env.LB_STATE_DIR = stateDir;
	});

	afterEach(async () => {
		process.env = { ...originalEnv };
		await rm(stateDir, { recursive: true, force: true });
	});

	function makePayload(sessionId: string): CaptureApiPayload {
		return {
			title: "Test session",
			content_type: "session",
			source: "agent",
			captured_at: new Date().toISOString(),
			why: "test",
			session_id: sessionId,
			episode_events: [],
		};
	}

	test("writes .success.<session_id> marker after successful upload", async () => {
		const sessionId = "test-success-marker-sess";
		const payload = makePayload(sessionId);
		const auth: AuthResult = { header: "ApiKey test", apiUrl: "https://example.com" };

		// Mock fetch to return 200 ok
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ id: "cap-1", status: "ok" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		try {
			const result = await postCapture(payload, auth, sessionId);
			expect(result).not.toBeNull();
			const markerPath = join(stateDir, `.success.${sessionId}`);
			expect(existsSync(markerPath)).toBe(true);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("does not write .success marker on 403 failure", async () => {
		const sessionId = "test-fail-403-sess";
		const payload = makePayload(sessionId);
		const auth: AuthResult = { header: "ApiKey bad", apiUrl: "https://example.com" };

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response("Unauthorized", { status: 403 });

		try {
			const result = await postCapture(payload, auth, sessionId);
			expect(result).toBeNull();
			const markerPath = join(stateDir, `.success.${sessionId}`);
			expect(existsSync(markerPath)).toBe(false);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("403 returns null even when body mentions episodic_memory", async () => {
		const sessionId = "test-403-generic-sess";
		const payload = makePayload(sessionId);
		const auth: AuthResult = { header: "ApiKey bad", apiUrl: "https://example.com" };

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () =>
			new Response("episodic_memory feature not enabled", { status: 403 });

		try {
			const result = await postCapture(payload, auth, sessionId);
			expect(result).toBeNull();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
