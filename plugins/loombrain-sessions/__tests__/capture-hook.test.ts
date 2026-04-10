import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { processSession, countMeaningfulEvents } from "../src/capture-hook";
import type { EpisodeEvent } from "../src/types";

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
