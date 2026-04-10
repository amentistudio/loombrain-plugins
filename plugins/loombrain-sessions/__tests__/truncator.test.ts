import { describe, expect, test } from "bun:test";
import { truncateContent } from "../src/truncator";

const encoder = new TextEncoder();

describe("truncateContent", () => {
	test("passes through content under 10KB unchanged", () => {
		const content = "Hello, world!";
		expect(truncateContent(content)).toBe(content);
	});

	test("passes through content at exactly 10240 bytes", () => {
		const content = "a".repeat(10240);
		expect(truncateContent(content)).toBe(content);
	});

	test("truncates content over 10KB with suffix", () => {
		const content = "a".repeat(10241);
		const result = truncateContent(content);
		expect(result).not.toBe(content);
		expect(result.endsWith("\n... [truncated]")).toBe(true);
		expect(encoder.encode(result).length).toBeLessThanOrEqual(10240);
	});

	test("does not split multi-byte UTF-8 characters", () => {
		// Each emoji is 4 bytes. Fill up close to limit then add emoji at boundary.
		const padding = "a".repeat(10236); // 10236 bytes
		const content = `${padding}\u{1F600}`; // +4 bytes = 10240 exactly
		const result = truncateContent(content);
		// Should pass through since exactly 10240 bytes
		expect(result).toBe(content);

		// Now exceed by 1 byte
		const overContent = `${padding}\u{1F600}x`; // 10241 bytes
		const overResult = truncateContent(overContent);
		expect(overResult.endsWith("\n... [truncated]")).toBe(true);
		// Must not contain broken UTF-8
		expect(encoder.encode(overResult).length).toBeLessThanOrEqual(10240);
	});

	test("handles empty string", () => {
		expect(truncateContent("")).toBe("");
	});

	test("respects custom maxBytes parameter", () => {
		const content = "a".repeat(200);
		const result = truncateContent(content, 100);
		expect(result.endsWith("\n... [truncated]")).toBe(true);
		expect(encoder.encode(result).length).toBeLessThanOrEqual(100);
	});

	test("truncated result always has room for suffix", () => {
		// Content that's just barely over the limit
		const content = "a".repeat(10241);
		const result = truncateContent(content);
		const suffix = "\n... [truncated]";
		const resultBytes = encoder.encode(result).length;
		const suffixBytes = encoder.encode(suffix).length;
		// The body portion should leave room for the suffix
		expect(resultBytes).toBeLessThanOrEqual(10240);
		expect(result.endsWith(suffix)).toBe(true);
		// Body is maxBytes - suffixBytes
		const bodyBytes = resultBytes - suffixBytes;
		expect(bodyBytes).toBe(10240 - suffixBytes);
	});
});
