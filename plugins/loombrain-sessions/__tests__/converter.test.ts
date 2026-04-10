import { describe, expect, test } from "bun:test";
import { parseSessionLines } from "../src/converter";

function line(obj: Record<string, unknown>): string {
	return JSON.stringify(obj);
}

const TS = "2026-04-09T10:00:00.000Z";
const TS2 = "2026-04-09T10:01:00.000Z";

describe("parseSessionLines", () => {
	test("skips file-history-snapshot lines", () => {
		const lines = [line({ type: "file-history-snapshot", timestamp: TS, files: [] })];
		expect(parseSessionLines(lines)).toEqual([]);
	});

	test("skips attachment lines", () => {
		const lines = [line({ type: "attachment", timestamp: TS, content: "mcp stuff" })];
		expect(parseSessionLines(lines)).toEqual([]);
	});

	test("skips isMeta user lines", () => {
		const lines = [
			line({
				type: "user",
				timestamp: TS,
				isMeta: true,
				message: { role: "user", content: "system injected" },
			}),
		];
		expect(parseSessionLines(lines)).toEqual([]);
	});

	test("maps user message with string content", () => {
		const lines = [
			line({
				type: "user",
				timestamp: TS,
				message: { role: "user", content: "hello world" },
			}),
		];
		const events = parseSessionLines(lines);
		expect(events).toHaveLength(1);
		expect(events[0].role).toBe("user");
		expect(events[0].content).toBe("hello world");
		expect(events[0].seq).toBe(0);
		expect(events[0].occurred_at).toBe(TS);
	});

	test("maps user message with array content (text blocks)", () => {
		const lines = [
			line({
				type: "user",
				timestamp: TS,
				message: {
					role: "user",
					content: [{ type: "text", text: "part one" }, { type: "text", text: "part two" }],
				},
			}),
		];
		const events = parseSessionLines(lines);
		expect(events).toHaveLength(1);
		expect(events[0].content).toBe("part one\npart two");
	});

	test("extracts tool_result blocks from user content arrays", () => {
		const lines = [
			line({
				type: "user",
				timestamp: TS,
				message: {
					role: "user",
					content: [
						{ type: "text", text: "check this" },
						{
							type: "tool_result",
							tool_use_id: "call_123",
							content: "result data",
						},
					],
				},
			}),
		];
		const events = parseSessionLines(lines);
		expect(events).toHaveLength(2);
		expect(events[0].role).toBe("user");
		expect(events[0].content).toBe("check this");
		expect(events[1].role).toBe("tool_result");
		expect(events[1].tool_call_id).toBe("call_123");
		expect(events[1].content).toBe("result data");
	});

	test("maps assistant text blocks, merging contiguous", () => {
		const lines = [
			line({
				type: "assistant",
				timestamp: TS,
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "first part" },
						{ type: "text", text: "second part" },
					],
				},
			}),
		];
		const events = parseSessionLines(lines);
		expect(events).toHaveLength(1);
		expect(events[0].role).toBe("assistant");
		expect(events[0].content).toBe("first part\nsecond part");
	});

	test("maps assistant tool_use blocks with tool_name and tool_call_id", () => {
		const lines = [
			line({
				type: "assistant",
				timestamp: TS,
				message: {
					role: "assistant",
					content: [
						{
							type: "tool_use",
							id: "call_456",
							name: "Read",
							input: { file_path: "/foo.ts" },
						},
					],
				},
			}),
		];
		const events = parseSessionLines(lines);
		expect(events).toHaveLength(1);
		expect(events[0].role).toBe("tool_call");
		expect(events[0].tool_name).toBe("Read");
		expect(events[0].tool_call_id).toBe("call_456");
		expect(events[0].content).toBe(JSON.stringify({ file_path: "/foo.ts" }));
	});

	test("skips assistant thinking blocks", () => {
		const lines = [
			line({
				type: "assistant",
				timestamp: TS,
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "let me think..." },
						{ type: "text", text: "the answer" },
					],
				},
			}),
		];
		const events = parseSessionLines(lines);
		expect(events).toHaveLength(1);
		expect(events[0].role).toBe("assistant");
		expect(events[0].content).toBe("the answer");
	});

	test("preserves interleaving: text-tool-text becomes 3 events", () => {
		const lines = [
			line({
				type: "assistant",
				timestamp: TS,
				message: {
					role: "assistant",
					content: [
						{ type: "text", text: "before tool" },
						{ type: "tool_use", id: "c1", name: "Bash", input: { command: "ls" } },
						{ type: "text", text: "after tool" },
					],
				},
			}),
		];
		const events = parseSessionLines(lines);
		expect(events).toHaveLength(3);
		expect(events[0].role).toBe("assistant");
		expect(events[0].content).toBe("before tool");
		expect(events[1].role).toBe("tool_call");
		expect(events[1].tool_name).toBe("Bash");
		expect(events[2].role).toBe("assistant");
		expect(events[2].content).toBe("after tool");
	});

	test("maps system messages", () => {
		const lines = [
			line({ type: "system", timestamp: TS, content: "system prompt text" }),
		];
		const events = parseSessionLines(lines);
		expect(events).toHaveLength(1);
		expect(events[0].role).toBe("system");
		expect(events[0].content).toBe("system prompt text");
	});

	test("maps tool_result messages", () => {
		const lines = [
			line({
				type: "tool_result",
				timestamp: TS,
				tool_use_id: "call_789",
				content: "output text",
			}),
		];
		const events = parseSessionLines(lines);
		expect(events).toHaveLength(1);
		expect(events[0].role).toBe("tool_result");
		expect(events[0].tool_call_id).toBe("call_789");
		expect(events[0].content).toBe("output text");
	});

	test("assigns monotonic seq numbers", () => {
		const lines = [
			line({ type: "user", timestamp: TS, message: { role: "user", content: "q1" } }),
			line({ type: "assistant", timestamp: TS2, message: { role: "assistant", content: [{ type: "text", text: "a1" }] } }),
			line({ type: "user", timestamp: TS2, message: { role: "user", content: "q2" } }),
		];
		const events = parseSessionLines(lines);
		expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
	});

	test("handles missing timestamp — falls back to previous event", () => {
		const lines = [
			line({ type: "user", timestamp: TS, message: { role: "user", content: "with ts" } }),
			line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "no ts" }] } }),
		];
		const events = parseSessionLines(lines);
		expect(events[1].occurred_at).toBe(TS);
	});

	test("skips malformed JSON lines gracefully", () => {
		const lines = [
			"not valid json",
			line({ type: "user", timestamp: TS, message: { role: "user", content: "valid" } }),
		];
		const events = parseSessionLines(lines);
		expect(events).toHaveLength(1);
		expect(events[0].content).toBe("valid");
	});

	test("truncates content exceeding 10KB", () => {
		const bigContent = "x".repeat(11000);
		const lines = [
			line({ type: "user", timestamp: TS, message: { role: "user", content: bigContent } }),
		];
		const events = parseSessionLines(lines);
		expect(events[0].content.length).toBeLessThan(bigContent.length);
		expect(events[0].content.endsWith("\n... [truncated]")).toBe(true);
	});
});
