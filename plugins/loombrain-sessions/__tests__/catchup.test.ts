import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extractSessionIdFromPath,
	deriveCwdFromProjectDir,
	isAuthCooldownActive,
	setAuthCooldown,
	clearAuthCooldown,
	findOrphanTranscripts,
	runCatchup,
	CATCHUP_MAX_UPLOADS_PER_RUN,
} from "../src/catchup";
import type { CaptureApiResponse } from "../src/types";
import type { AuthResult } from "../src/api-client";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTranscriptContent(lineCount: number): string {
	const TS = "2026-04-09T10:00:00.000Z";
	const lines: string[] = [];
	for (let i = 0; i < lineCount; i++) {
		if (i % 2 === 0) {
			lines.push(
				JSON.stringify({
					type: "user",
					timestamp: TS,
					message: { role: "user", content: `question ${i}` },
				}),
			);
		} else {
			lines.push(
				JSON.stringify({
					type: "assistant",
					timestamp: TS,
					message: {
						role: "assistant",
						content: [{ type: "text", text: `answer ${i}` }],
					},
				}),
			);
		}
	}
	return lines.join("\n");
}

/** Set file mtime to `daysAgo` days before now (plus optional extra seconds offset). */
async function setMtime(filePath: string, daysAgo: number, secondsAgo = 0): Promise<void> {
	const ms = Date.now() - daysAgo * 24 * 60 * 60 * 1000 - secondsAgo * 1000;
	const t = new Date(ms);
	await utimes(filePath, t, t);
}

// ---------------------------------------------------------------------------
// extractSessionIdFromPath
// ---------------------------------------------------------------------------

describe("extractSessionIdFromPath", () => {
	test("extracts session ID from standard path", () => {
		const result = extractSessionIdFromPath("/Users/x/.claude/projects/-Users-x-project/abc123.jsonl");
		expect(result).toBe("abc123");
	});

	test("handles paths with hyphens in session ID", () => {
		const result = extractSessionIdFromPath("/some/dir/sess-abc-123.jsonl");
		expect(result).toBe("sess-abc-123");
	});
});

// ---------------------------------------------------------------------------
// deriveCwdFromProjectDir
// ---------------------------------------------------------------------------

describe("deriveCwdFromProjectDir", () => {
	test("reverses encoded path", () => {
		const result = deriveCwdFromProjectDir("-Users-x-project");
		expect(result).toBe("/Users/x/project");
	});

	test("returns null for empty string", () => {
		const result = deriveCwdFromProjectDir("");
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// isAuthCooldownActive / setAuthCooldown / clearAuthCooldown
// ---------------------------------------------------------------------------

describe("isAuthCooldownActive / setAuthCooldown / clearAuthCooldown", () => {
	let stateDir: string;

	beforeEach(async () => {
		stateDir = await mkdtemp(join(tmpdir(), "catchup-cooldown-"));
	});

	afterEach(async () => {
		await rm(stateDir, { recursive: true, force: true });
	});

	test("returns false when no cooldown file exists", async () => {
		const active = await isAuthCooldownActive(stateDir);
		expect(active).toBe(false);
	});

	test("returns true when cooldown is in the future", async () => {
		await setAuthCooldown(60_000, stateDir); // 60 seconds from now
		const active = await isAuthCooldownActive(stateDir);
		expect(active).toBe(true);
	});

	test("returns false when cooldown has expired", async () => {
		// Write a timestamp in the past
		const past = new Date(Date.now() - 1000).toISOString();
		await Bun.write(join(stateDir, ".auth-cooldown-until"), past);
		const active = await isAuthCooldownActive(stateDir);
		expect(active).toBe(false);
	});

	test("clearAuthCooldown removes the file", async () => {
		await setAuthCooldown(60_000, stateDir);
		await clearAuthCooldown(stateDir);
		const filePath = join(stateDir, ".auth-cooldown-until");
		expect(existsSync(filePath)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// findOrphanTranscripts
// ---------------------------------------------------------------------------

describe("findOrphanTranscripts", () => {
	let projectsDir: string;

	beforeEach(async () => {
		projectsDir = await mkdtemp(join(tmpdir(), "catchup-projects-"));
	});

	afterEach(async () => {
		await rm(projectsDir, { recursive: true, force: true });
	});

	test("finds files within lookback window", async () => {
		await mkdir(join(projectsDir, "project-a"), { recursive: true });
		const filePath = join(projectsDir, "project-a", "sess001.jsonl");
		await Bun.write(filePath, makeTranscriptContent(10));
		await setMtime(filePath, 3); // 3 days ago — within 7-day window

		const orphans = await findOrphanTranscripts({
			lookbackDays: 7,
			quiescenceMs: 30_000,
			activeSessionId: null,
			capturedSessions: new Set(),
			projectsDir,
		});

		expect(orphans.length).toBe(1);
		expect(orphans[0].sessionId).toBe("sess001");
	});

	test("skips files outside lookback window", async () => {
		await mkdir(join(projectsDir, "project-a"), { recursive: true });
		const filePath = join(projectsDir, "project-a", "old-sess.jsonl");
		await Bun.write(filePath, makeTranscriptContent(10));
		await setMtime(filePath, 10); // 10 days ago, lookback=7

		const orphans = await findOrphanTranscripts({
			lookbackDays: 7,
			quiescenceMs: 30_000,
			activeSessionId: null,
			capturedSessions: new Set(),
			projectsDir,
		});

		expect(orphans.length).toBe(0);
	});

	test("defers files within quiescence window", async () => {
		await mkdir(join(projectsDir, "project-a"), { recursive: true });
		const filePath = join(projectsDir, "project-a", "recent-sess.jsonl");
		await Bun.write(filePath, makeTranscriptContent(10));
		// mtime is 30 seconds ago, quiescence is 2 minutes
		await setMtime(filePath, 0, 30);

		const orphans = await findOrphanTranscripts({
			lookbackDays: 7,
			quiescenceMs: 120_000,
			activeSessionId: null,
			capturedSessions: new Set(),
			projectsDir,
		});

		expect(orphans.length).toBe(0);
	});

	test("skips files in capturedSessions set", async () => {
		await mkdir(join(projectsDir, "project-a"), { recursive: true });
		const filePath = join(projectsDir, "project-a", "already-done.jsonl");
		await Bun.write(filePath, makeTranscriptContent(10));
		await setMtime(filePath, 2);

		const orphans = await findOrphanTranscripts({
			lookbackDays: 7,
			quiescenceMs: 30_000,
			activeSessionId: null,
			capturedSessions: new Set(["already-done"]),
			projectsDir,
		});

		expect(orphans.length).toBe(0);
	});

	test("skips active session", async () => {
		await mkdir(join(projectsDir, "project-a"), { recursive: true });
		const filePath = join(projectsDir, "project-a", "active-sess.jsonl");
		await Bun.write(filePath, makeTranscriptContent(10));
		await setMtime(filePath, 1);

		const orphans = await findOrphanTranscripts({
			lookbackDays: 7,
			quiescenceMs: 30_000,
			activeSessionId: "active-sess",
			capturedSessions: new Set(),
			projectsDir,
		});

		expect(orphans.length).toBe(0);
	});

	test("skips empty files", async () => {
		await mkdir(join(projectsDir, "project-a"), { recursive: true });
		const filePath = join(projectsDir, "project-a", "empty-sess.jsonl");
		await Bun.write(filePath, "");
		await setMtime(filePath, 1);

		const orphans = await findOrphanTranscripts({
			lookbackDays: 7,
			quiescenceMs: 30_000,
			activeSessionId: null,
			capturedSessions: new Set(),
			projectsDir,
		});

		expect(orphans.length).toBe(0);
	});

	test("returns sorted by mtime descending", async () => {
		await mkdir(join(projectsDir, "project-a"), { recursive: true });

		const file1 = join(projectsDir, "project-a", "older.jsonl");
		const file2 = join(projectsDir, "project-a", "newer.jsonl");
		await Bun.write(file1, makeTranscriptContent(10));
		await Bun.write(file2, makeTranscriptContent(10));
		await setMtime(file1, 5); // 5 days ago
		await setMtime(file2, 2); // 2 days ago

		const orphans = await findOrphanTranscripts({
			lookbackDays: 7,
			quiescenceMs: 30_000,
			activeSessionId: null,
			capturedSessions: new Set(),
			projectsDir,
		});

		expect(orphans.length).toBe(2);
		expect(orphans[0].sessionId).toBe("newer");
		expect(orphans[1].sessionId).toBe("older");
	});
});

// ---------------------------------------------------------------------------
// runCatchup
// ---------------------------------------------------------------------------

describe("runCatchup", () => {
	let projectsDir: string;
	let stateDir: string;

	const fakeAuth: AuthResult = { header: "ApiKey test-key", apiUrl: "https://test.example.com" };

	const fakeResolveAuth = async () => fakeAuth;
	const fakePostCapture = async (): Promise<CaptureApiResponse | null> => ({
		id: "cap-001",
		status: "ok",
	});

	beforeEach(async () => {
		projectsDir = await mkdtemp(join(tmpdir(), "catchup-run-projects-"));
		stateDir = await mkdtemp(join(tmpdir(), "catchup-run-state-"));
	});

	afterEach(async () => {
		await rm(projectsDir, { recursive: true, force: true });
		await rm(stateDir, { recursive: true, force: true });
	});

	async function plantOrphan(
		sessionId: string,
		daysAgo: number,
		content = makeTranscriptContent(12),
	): Promise<string> {
		const dir = join(projectsDir, "project-a");
		await mkdir(dir, { recursive: true });
		const filePath = join(dir, `${sessionId}.jsonl`);
		await Bun.write(filePath, content);
		await setMtime(filePath, daysAgo);
		return filePath;
	}

	test("uploads orphan transcripts and marks them captured", async () => {
		await plantOrphan("sess-orphan-1", 2);
		await plantOrphan("sess-orphan-2", 3);

		const captured = new Set<string>();
		const markCapturedFn = async (key: string) => { captured.add(key); };
		const isAlreadyCapturedFn = async (key: string) => captured.has(key);

		const result = await runCatchup({
			activeSessionId: "sess-active",
			isFirstRun: false,
			stateDir,
			projectsDir,
			resolveAuthFn: fakeResolveAuth,
			postCaptureFn: fakePostCapture,
			markCapturedFn,
			isAlreadyCapturedFn,
		});

		expect(result.uploaded).toBeGreaterThanOrEqual(1);
		expect(result.failed).toBe(0);
		expect(result.cooledDown).toBe(false);
		expect(result.capped).toBe(false);
	});

	test("skips already-captured sessions", async () => {
		await plantOrphan("sess-already-captured", 2);

		let processCount = 0;
		const captured = new Set(["sess-already-captured"]);
		const markCapturedFn = async (key: string) => { captured.add(key); };
		const isAlreadyCapturedFn = async (key: string) => captured.has(key);

		const fakeProcessSession = async () => {
			processCount++;
			return { skipped: false, chunks: [{ session_id: "sess-already-captured", title: "Test", events: [] }] };
		};

		const result = await runCatchup({
			activeSessionId: "sess-active",
			isFirstRun: false,
			stateDir,
			projectsDir,
			resolveAuthFn: fakeResolveAuth,
			postCaptureFn: fakePostCapture,
			processSessionFn: fakeProcessSession,
			markCapturedFn,
			isAlreadyCapturedFn,
		});

		expect(processCount).toBe(0); // findOrphanTranscripts filters it out
		expect(result.orphans).toBe(0);
	});

	test("skips active session", async () => {
		await plantOrphan("sess-active", 2);

		let processCount = 0;
		const fakeProcessSession = async () => {
			processCount++;
			return { skipped: false, chunks: [] };
		};

		const captured = new Set<string>();
		const result = await runCatchup({
			activeSessionId: "sess-active",
			isFirstRun: false,
			stateDir,
			projectsDir,
			resolveAuthFn: fakeResolveAuth,
			postCaptureFn: fakePostCapture,
			processSessionFn: fakeProcessSession,
			markCapturedFn: async () => {},
			isAlreadyCapturedFn: async (key) => captured.has(key),
		});

		expect(processCount).toBe(0);
		expect(result.orphans).toBe(0);
	});

	test("respects batch cap of CATCHUP_MAX_UPLOADS_PER_RUN", async () => {
		// Plant more orphans than the cap
		for (let i = 0; i < CATCHUP_MAX_UPLOADS_PER_RUN + 5; i++) {
			await plantOrphan(`sess-cap-${i}`, 2 + (i % 5));
		}

		let processCallCount = 0;
		const captured = new Set<string>();
		const fakeProcessSession = async (sessionId: string) => {
			processCallCount++;
			return {
				skipped: false,
				chunks: [{ session_id: sessionId, title: "Test", events: [] }],
			};
		};

		await runCatchup({
			activeSessionId: "sess-active",
			isFirstRun: false,
			stateDir,
			projectsDir,
			resolveAuthFn: fakeResolveAuth,
			postCaptureFn: fakePostCapture,
			processSessionFn: fakeProcessSession,
			markCapturedFn: async (key) => { captured.add(key); },
			isAlreadyCapturedFn: async (key) => captured.has(key),
		});

		expect(processCallCount).toBeLessThanOrEqual(CATCHUP_MAX_UPLOADS_PER_RUN);
	});

	test("handles processSession failure gracefully", async () => {
		await plantOrphan("sess-fail", 2);

		const fakeProcessSessionThrowing = async (): Promise<never> => {
			throw new Error("processSession failed");
		};

		const captured = new Set<string>();
		const result = await runCatchup({
			activeSessionId: "sess-active",
			isFirstRun: false,
			stateDir,
			projectsDir,
			resolveAuthFn: fakeResolveAuth,
			postCaptureFn: fakePostCapture,
			processSessionFn: fakeProcessSessionThrowing,
			markCapturedFn: async (key) => { captured.add(key); },
			isAlreadyCapturedFn: async (key) => captured.has(key),
		});

		expect(result.failed).toBe(1);
		expect(result.uploaded).toBe(0);
	});

	test("writes .v3-marker on first successful run", async () => {
		await plantOrphan("sess-first-run", 2);

		const captured = new Set<string>();

		const result = await runCatchup({
			activeSessionId: "sess-active",
			isFirstRun: true,
			stateDir,
			projectsDir,
			resolveAuthFn: fakeResolveAuth,
			postCaptureFn: fakePostCapture,
			markCapturedFn: async (key) => { captured.add(key); },
			isAlreadyCapturedFn: async (key) => captured.has(key),
		});

		expect(result.uploaded).toBeGreaterThanOrEqual(1);
		const markerPath = join(stateDir, ".v3-marker");
		expect(existsSync(markerPath)).toBe(true);
	});

	test("does not write .v3-marker when no uploads succeed", async () => {
		// Plant a file that will be skipped (too few events)
		await plantOrphan("sess-short", 2, makeTranscriptContent(2));

		const captured = new Set<string>();
		const result = await runCatchup({
			activeSessionId: "sess-active",
			isFirstRun: true,
			stateDir,
			projectsDir,
			resolveAuthFn: fakeResolveAuth,
			postCaptureFn: fakePostCapture,
			markCapturedFn: async (key) => { captured.add(key); },
			isAlreadyCapturedFn: async (key) => captured.has(key),
		});

		expect(result.uploaded).toBe(0);
		const markerPath = join(stateDir, ".v3-marker");
		expect(existsSync(markerPath)).toBe(false);
	});

	test("returns cooledDown when auth cooldown is active", async () => {
		await plantOrphan("sess-cooldown", 2);

		// Set a cooldown that expires in the future
		await setAuthCooldown(60_000, stateDir);

		const captured = new Set<string>();
		const result = await runCatchup({
			activeSessionId: "sess-active",
			isFirstRun: false,
			stateDir,
			projectsDir,
			resolveAuthFn: fakeResolveAuth,
			postCaptureFn: fakePostCapture,
			markCapturedFn: async (key) => { captured.add(key); },
			isAlreadyCapturedFn: async (key) => captured.has(key),
		});

		expect(result.cooledDown).toBe(true);
		expect(result.uploaded).toBe(0);
	});

	test("sets capped when orphans exceed batch limit", async () => {
		for (let i = 0; i < CATCHUP_MAX_UPLOADS_PER_RUN + 3; i++) {
			await plantOrphan(`sess-capped-${i}`, 2 + (i % 5));
		}

		const captured = new Set<string>();
		const result = await runCatchup({
			activeSessionId: "sess-active",
			isFirstRun: false,
			stateDir,
			projectsDir,
			resolveAuthFn: fakeResolveAuth,
			postCaptureFn: fakePostCapture,
			markCapturedFn: async (key) => { captured.add(key); },
			isAlreadyCapturedFn: async (key) => captured.has(key),
		});

		expect(result.capped).toBe(true);
	});

	test("sets auth cooldown when auth fails", async () => {
		await plantOrphan("sess-auth-fail", 2);

		const captured = new Set<string>();
		const result = await runCatchup({
			activeSessionId: "sess-active",
			isFirstRun: false,
			stateDir,
			projectsDir,
			resolveAuthFn: async () => null, // auth fails
			postCaptureFn: fakePostCapture,
			markCapturedFn: async (key) => { captured.add(key); },
			isAlreadyCapturedFn: async (key) => captured.has(key),
		});

		expect(result.uploaded).toBe(0);
		// Verify cooldown was set
		const { isAuthCooldownActive: checkCooldown } = await import("../src/catchup");
		const active = await checkCooldown(stateDir);
		expect(active).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// resurrection scan
// ---------------------------------------------------------------------------

describe("resurrection scan", () => {
	let projectsDir: string;
	let stateDir: string;

	const fakeAuth: AuthResult = { header: "ApiKey test-key", apiUrl: "https://test.example.com" };
	const fakeResolveAuth = async () => fakeAuth;

	beforeEach(async () => {
		projectsDir = await mkdtemp(join(tmpdir(), "catchup-resurrect-projects-"));
		stateDir = await mkdtemp(join(tmpdir(), "catchup-resurrect-state-"));
	});

	afterEach(async () => {
		await rm(projectsDir, { recursive: true, force: true });
		await rm(stateDir, { recursive: true, force: true });
	});

	async function plantJsonl(
		sessionId: string,
		daysAgo: number,
		content = makeTranscriptContent(12),
	): Promise<string> {
		const dir = join(projectsDir, "project-a");
		await mkdir(dir, { recursive: true });
		const filePath = join(dir, `${sessionId}.jsonl`);
		await Bun.write(filePath, content);
		await setMtime(filePath, daysAgo);
		return filePath;
	}

	async function writeCapturedSessions(sessionIds: string[]): Promise<void> {
		await mkdir(stateDir, { recursive: true });
		await writeFile(join(stateDir, "captured-sessions"), sessionIds.join("\n") + "\n", "utf-8");
	}

	async function writeSuccessMarker(sessionId: string): Promise<void> {
		await writeFile(join(stateDir, `.success.${sessionId}`), new Date().toISOString(), "utf-8");
	}

	test("re-uploads sessions in captured-sessions that lack .success marker", async () => {
		const sessionId = "sess-false-captured";
		await plantJsonl(sessionId, 5);
		await writeCapturedSessions([sessionId]);
		// No .success marker written — simulates pre-v0.3.0 false-captured entry

		const uploadedSessions: string[] = [];
		const fakePostCapture = async (
			payload: Parameters<typeof import("../src/api-client").postCapture>[0],
		): Promise<CaptureApiResponse | null> => {
			uploadedSessions.push(payload.session_id);
			return { id: "cap-resurrected", status: "ok" };
		};

		const captured = new Set([sessionId]);
		await runCatchup({
			activeSessionId: "sess-active",
			isFirstRun: true,
			stateDir,
			projectsDir,
			resolveAuthFn: fakeResolveAuth,
			postCaptureFn: fakePostCapture,
			markCapturedFn: async () => {},
			isAlreadyCapturedFn: async (key) => captured.has(key),
		});

		expect(uploadedSessions.some((id) => id.startsWith(sessionId))).toBe(true);
	});

	test("skips sessions that already have .success marker", async () => {
		const sessionId = "sess-truly-captured";
		await plantJsonl(sessionId, 5);
		await writeCapturedSessions([sessionId]);
		await writeSuccessMarker(sessionId); // Already has success marker

		const uploadedSessions: string[] = [];
		const fakePostCapture = async (
			payload: Parameters<typeof import("../src/api-client").postCapture>[0],
		): Promise<CaptureApiResponse | null> => {
			uploadedSessions.push(payload.session_id);
			return { id: "cap-001", status: "ok" };
		};

		const captured = new Set([sessionId]);
		await runCatchup({
			activeSessionId: "sess-active",
			isFirstRun: true,
			stateDir,
			projectsDir,
			resolveAuthFn: fakeResolveAuth,
			postCaptureFn: fakePostCapture,
			markCapturedFn: async () => {},
			isAlreadyCapturedFn: async (key) => captured.has(key),
		});

		expect(uploadedSessions.length).toBe(0);
	});

	test("resurrection scan only runs on first run", async () => {
		const sessionId = "sess-not-resurrected";
		await plantJsonl(sessionId, 5);
		await writeCapturedSessions([sessionId]);
		// No .success marker — but isFirstRun=false

		const uploadedSessions: string[] = [];
		const fakePostCapture = async (
			payload: Parameters<typeof import("../src/api-client").postCapture>[0],
		): Promise<CaptureApiResponse | null> => {
			uploadedSessions.push(payload.session_id);
			return { id: "cap-001", status: "ok" };
		};

		const captured = new Set([sessionId]);
		await runCatchup({
			activeSessionId: "sess-active",
			isFirstRun: false,
			stateDir,
			projectsDir,
			resolveAuthFn: fakeResolveAuth,
			postCaptureFn: fakePostCapture,
			markCapturedFn: async () => {},
			isAlreadyCapturedFn: async (key) => captured.has(key),
		});

		expect(uploadedSessions.length).toBe(0);
	});
});
