import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	resolveAuth,
	buildCapturePayload,
	type AuthResult,
} from "../src/api-client";
import type { CaptureChunk } from "../src/types";

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
