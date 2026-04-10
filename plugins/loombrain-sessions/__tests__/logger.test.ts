import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We'll test logInfo, logError, and the shared appendLog via the public API.
// The logger module uses a hardcoded STATE_DIR, so we test the exported functions
// that accept an optional logPath for testability.

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "logger-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("logInfo", () => {
	test("writes INFO entry to log file", async () => {
		const { logInfo } = await import("../src/logger");
		const logPath = join(tempDir, "capture.log");
		await logInfo("sess-1", "Hook started", logPath);

		const content = await readFile(logPath, "utf-8");
		expect(content).toContain("[sess-1]");
		expect(content).toContain("INFO:");
		expect(content).toContain("Hook started");
	});

	test("appends multiple entries", async () => {
		const { logInfo } = await import("../src/logger");
		const logPath = join(tempDir, "capture.log");
		await logInfo("sess-1", "First", logPath);
		await logInfo("sess-2", "Second", logPath);

		const content = await readFile(logPath, "utf-8");
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("First");
		expect(lines[1]).toContain("Second");
	});

	test("creates parent directory if it does not exist", async () => {
		const { logInfo } = await import("../src/logger");
		const nested = join(tempDir, "sub", "deep", "capture.log");
		await logInfo("sess-1", "nested test", nested);

		const content = await readFile(nested, "utf-8");
		expect(content).toContain("nested test");
	});

	test("includes ISO timestamp", async () => {
		const { logInfo } = await import("../src/logger");
		const logPath = join(tempDir, "capture.log");
		await logInfo("sess-1", "timestamp check", logPath);

		const content = await readFile(logPath, "utf-8");
		// ISO 8601 pattern: 2026-04-10T...
		expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});
});

describe("logError", () => {
	test("writes ERROR entry to log file", async () => {
		const { logError } = await import("../src/logger");
		const logPath = join(tempDir, "capture.log");
		await logError("sess-1", "Something failed", logPath);

		const content = await readFile(logPath, "utf-8");
		expect(content).toContain("[sess-1]");
		expect(content).toContain("ERROR:");
		expect(content).toContain("Something failed");
	});

	test("never throws even with invalid path", async () => {
		const { logError } = await import("../src/logger");
		// /dev/null/impossible is not a valid path on any OS
		await expect(logError("sess-1", "msg", "/dev/null/impossible/capture.log")).resolves.toBeUndefined();
	});
});

describe("log rotation", () => {
	test("truncates log file when exceeding max size", async () => {
		const { logInfo } = await import("../src/logger");
		const logPath = join(tempDir, "capture.log");

		// Write >100KB of log entries to trigger rotation
		const bigMessage = "X".repeat(10_000);
		for (let i = 0; i < 15; i++) {
			await logInfo(`sess-${i}`, bigMessage, logPath);
		}

		const content = await readFile(logPath, "utf-8");
		const bytes = new TextEncoder().encode(content).length;
		// After rotation, should be roughly half of max (100KB)
		expect(bytes).toBeLessThan(100 * 1024);
	});
});
