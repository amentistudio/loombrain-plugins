import { describe, expect, test } from "bun:test";
import { splitIntoChunks } from "../src/splitter";
import type { EpisodeEvent } from "../src/types";

function makeEvent(seq: number, contentSize = 10): EpisodeEvent {
	return {
		seq,
		role: "user",
		content: "x".repeat(contentSize),
		occurred_at: "2026-04-09T10:00:00.000Z",
	};
}

describe("splitIntoChunks", () => {
	test("single chunk when ≤250 events and ≤1.8MB", () => {
		const events = Array.from({ length: 100 }, (_, i) => makeEvent(i));
		const chunks = splitIntoChunks(events, "sess-1");
		expect(chunks).toHaveLength(1);
		expect(chunks[0].session_id).toBe("sess-1");
		expect(chunks[0].events).toHaveLength(100);
		expect(chunks[0].title).toBe("Claude Code session");
	});

	test("exactly 250 events stays as one chunk", () => {
		const events = Array.from({ length: 250 }, (_, i) => makeEvent(i));
		const chunks = splitIntoChunks(events, "sess-2");
		expect(chunks).toHaveLength(1);
	});

	test("251 events splits to 250 + 1", () => {
		const events = Array.from({ length: 251 }, (_, i) => makeEvent(i));
		const chunks = splitIntoChunks(events, "sess-3");
		expect(chunks).toHaveLength(2);
		expect(chunks[0].events).toHaveLength(250);
		expect(chunks[1].events).toHaveLength(1);
		expect(chunks[0].session_id).toBe("sess-3-part-1");
		expect(chunks[1].session_id).toBe("sess-3-part-2");
	});

	test("500 events splits into 2 chunks of 250", () => {
		const events = Array.from({ length: 500 }, (_, i) => makeEvent(i));
		const chunks = splitIntoChunks(events, "sess-4");
		expect(chunks).toHaveLength(2);
		expect(chunks[0].events).toHaveLength(250);
		expect(chunks[1].events).toHaveLength(250);
	});

	test("splits at byte boundary when events are large", () => {
		// Each event ~8000 bytes of content. 1.8MB / 8000 ≈ 225 events per chunk.
		const events = Array.from({ length: 300 }, (_, i) => makeEvent(i, 8000));
		const chunks = splitIntoChunks(events, "sess-5");
		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			const bytes = new TextEncoder().encode(JSON.stringify(chunk.events)).length;
			expect(bytes).toBeLessThanOrEqual(1.8 * 1024 * 1024);
			expect(chunk.events.length).toBeLessThanOrEqual(250);
		}
	});

	test("session_id has no suffix for single-chunk sessions", () => {
		const events = [makeEvent(0)];
		const chunks = splitIntoChunks(events, "sess-6");
		expect(chunks[0].session_id).toBe("sess-6");
	});

	test("multi-chunk titles include part numbers", () => {
		const events = Array.from({ length: 300 }, (_, i) => makeEvent(i));
		const chunks = splitIntoChunks(events, "sess-7");
		expect(chunks[0].title).toBe("Claude Code session (part 1 of 2)");
		expect(chunks[1].title).toBe("Claude Code session (part 2 of 2)");
	});

	test("single chunk with paraHint includes repo name in title", () => {
		const events = Array.from({ length: 10 }, (_, i) => makeEvent(i));
		const chunks = splitIntoChunks(events, "sess-8", "loombrain");
		expect(chunks).toHaveLength(1);
		expect(chunks[0].title).toBe("loombrain: Claude Code session");
	});

	test("multi-chunk with paraHint includes repo name in title", () => {
		const events = Array.from({ length: 300 }, (_, i) => makeEvent(i));
		const chunks = splitIntoChunks(events, "sess-9", "myrepo");
		expect(chunks[0].title).toBe("myrepo: Claude Code session (part 1 of 2)");
		expect(chunks[1].title).toBe("myrepo: Claude Code session (part 2 of 2)");
	});

	test("no paraHint leaves title unchanged (backward compat)", () => {
		const events = Array.from({ length: 10 }, (_, i) => makeEvent(i));
		const chunks = splitIntoChunks(events, "sess-10");
		expect(chunks[0].title).toBe("Claude Code session");
	});

	test("undefined paraHint leaves title unchanged", () => {
		const events = Array.from({ length: 10 }, (_, i) => makeEvent(i));
		const chunks = splitIntoChunks(events, "sess-11", undefined);
		expect(chunks[0].title).toBe("Claude Code session");
	});
});
