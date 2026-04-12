import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processSession, countMeaningfulEvents, readHookInput, parseMode, runSessionEnd } from "../src/capture-hook";
import type { EpisodeEvent, SessionHookInput } from "../src/types";

describe("countMeaningfulEvents", () => {
	test("counts only user and assistant events", () => {
		const events: EpisodeEvent[] = [
			{ seq: 0, role: "user", content: "q", occurred_at: "2026-04-09T10:00:00.000Z" },
			{ seq: 1, role: "assistant", content: "a", occurred_at: "2026-04-09T10:00:01.000Z" },
			{
				seq: 2,
				role: "tool_call",
				content: "{}",
				occurred_at: "2026-04-09T10:00:02.000Z",
				tool_name: "Read",
			},
			{
				seq: 3,
				role: "tool_result",
				content: "result",
				occurred_at: "2026-04-09T10:00:03.000Z",
				tool_call_id: "c1",
			},
			{ seq: 4, role: "system", content: "sys", occurred_at: "2026-04-09T10:00:04.000Z" },
			{ seq: 5, role: "user", content: "q2", occurred_at: "2026-04-09T10:00:05.000Z" },
		];
		expect(countMeaningfulEvents(events)).toBe(3);
	});

	test("returns 0 for empty array", () => {
		expect(countMeaningfulEvents([])).toBe(0);
	});
});

describe("processSession", () => {
	const TS = "2026-04-09T10:00:00.000Z";

	function makeLine(obj: Record<string, unknown>): string {
		return JSON.stringify(obj);
	}

	function makeTranscript(lineCount: number): string {
		const lines: string[] = [];
		for (let i = 0; i < lineCount; i++) {
			if (i % 2 === 0) {
				lines.push(
					makeLine({
						type: "user",
						timestamp: TS,
						message: { role: "user", content: `question ${i}` },
					}),
				);
			} else {
				lines.push(
					makeLine({
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

	test("returns skip reason for sessions with <5 meaningful events", async () => {
		const transcript = makeTranscript(4); // 2 user + 2 assistant = 4 meaningful
		const result = await processSession("sess-1", transcript, "/tmp/test-cwd");
		expect(result.skipped).toBe(true);
		expect(result.reason).toContain("meaningful");
	});

	test("parses and returns chunks for valid session", async () => {
		const transcript = makeTranscript(12); // 6 user + 6 assistant = 12 meaningful
		const result = await processSession("sess-2", transcript, "/tmp/test-cwd");
		expect(result.skipped).toBe(false);
		expect(result.chunks?.length).toBe(1);
		expect(result.chunks?.[0].session_id).toBe("sess-2");
	});

	test("splits large sessions into multiple chunks", async () => {
		const transcript = makeTranscript(600); // 300 user + 300 assistant
		const result = await processSession("sess-3", transcript, "/tmp/test-cwd");
		expect(result.skipped).toBe(false);
		const chunks = result.chunks;
		expect(chunks).toBeDefined();
		expect(chunks!.length).toBeGreaterThan(1);
	});
});

describe("readHookInput", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "hook-input-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("reads from --stdin-file when argument is present", async () => {
		const inputData = JSON.stringify({ session_id: "sess-42", transcript_path: "/tmp/t.jsonl", cwd: "/tmp" });
		const filePath = join(tempDir, "input.json");
		await writeFile(filePath, inputData);

		const result = await readHookInput(["--stdin-file", filePath]);
		expect(result.raw).toBe(inputData);
		expect(result.tempFile).toBe(filePath);
	});

	test("cleans up temp file after reading", async () => {
		const filePath = join(tempDir, "cleanup-test.json");
		await writeFile(filePath, '{"session_id":"s1"}');

		await readHookInput(["--stdin-file", filePath]);
		expect(existsSync(filePath)).toBe(false);
	});

	test("falls back to stdin when --stdin-file has no following value", async () => {
		const testPayload = '{"session_id":"from-stdin","cwd":"/tmp"}';
		const stream = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(testPayload));
				controller.close();
			},
		});

		const result = await readHookInput(["--stdin-file"], stream);
		expect(result.tempFile).toBeUndefined();
		expect(result.raw).toBe(testPayload);
	});
});

describe("parseMode", () => {
	test("returns 'end' as default when --mode not present", () => {
		expect(parseMode([])).toBe("end");
	});

	test("returns 'start' when --mode start is passed", () => {
		expect(parseMode(["--mode", "start"])).toBe("start");
	});

	test("returns 'end' when --mode end is passed", () => {
		expect(parseMode(["--mode", "end"])).toBe("end");
	});

	test("returns 'end' for invalid mode values", () => {
		expect(parseMode(["--mode", "invalid"])).toBe("end");
	});
});

describe("markCaptured bug fix (FR-7)", () => {
	let tempDir: string;

	function makeTranscript(lineCount: number): string {
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

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "fr7-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	test("does not mark root session as captured when some chunks fail", async () => {
		// Write a transcript file
		const transcriptPath = join(tempDir, "sess-root.jsonl");
		const transcript = makeTranscript(12);
		await writeFile(transcriptPath, transcript);

		// Write captured-sessions file (empty — none captured)
		const capturedFile = join(tempDir, "captured-sessions");
		await writeFile(capturedFile, "");

		// Mock api-client to succeed for first chunk, fail for second
		// We need processSession to return 2 chunks — use 600 lines
		const bigTranscript = makeTranscript(600);
		await writeFile(transcriptPath, bigTranscript);

		const input: SessionHookInput = {
			session_id: "sess-root-fr7a",
			transcript_path: transcriptPath,
			cwd: tempDir,
		};

		// Track markCaptured calls
		const capturedKeys: string[] = [];
		let callCount = 0;

		await runSessionEnd(input, {
			stateDir: tempDir,
			postCaptureFn: async () => {
				callCount++;
				// Succeed for first chunk, fail for second
				if (callCount === 1) return { id: "ok", session_id: "chunk-1" } as any;
				return null;
			},
			markCapturedFn: async (key: string) => {
				capturedKeys.push(key);
			},
			isAlreadyCapturedFn: async () => false,
			resolveAuthFn: async () => ({ header: "ApiKey test", apiUrl: "http://localhost" }),
		});

		// Root session should NOT be marked captured (not all chunks succeeded)
		expect(capturedKeys).not.toContain("sess-root-fr7a");
		// The successful chunk IS marked captured
		expect(capturedKeys.length).toBe(1);
	});

	test("marks root session as captured when all chunks succeed", async () => {
		const transcriptPath = join(tempDir, "sess-root2.jsonl");
		const bigTranscript = makeTranscript(600);
		await writeFile(transcriptPath, bigTranscript);

		const input: SessionHookInput = {
			session_id: "sess-root-fr7b",
			transcript_path: transcriptPath,
			cwd: tempDir,
		};

		const capturedKeys: string[] = [];

		await runSessionEnd(input, {
			stateDir: tempDir,
			postCaptureFn: async () => ({ id: "ok", session_id: "chunk" } as any),
			markCapturedFn: async (key: string) => {
				capturedKeys.push(key);
			},
			isAlreadyCapturedFn: async () => false,
			resolveAuthFn: async () => ({ header: "ApiKey test", apiUrl: "http://localhost" }),
		});

		// Root session SHOULD be marked captured (all chunks succeeded)
		expect(capturedKeys).toContain("sess-root-fr7b");
	});
});
