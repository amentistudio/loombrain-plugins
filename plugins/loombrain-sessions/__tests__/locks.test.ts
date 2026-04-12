import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSessionLock } from "../src/locks";

let tempDir: string;

beforeEach(async () => {
	tempDir = await mkdtemp(join(tmpdir(), "locks-test-"));
});

afterEach(async () => {
	await rm(tempDir, { recursive: true, force: true });
});

describe("withSessionLock", () => {
	test("acquires lock and runs fn successfully", async () => {
		let ran = false;
		const result = await withSessionLock(
			"sess-1",
			async () => {
				ran = true;
				return 42;
			},
			tempDir,
		);

		expect(ran).toBe(true);
		expect(result).toBe(42);

		// Lockfile should be cleaned up after fn completes
		const lockPath = join(tempDir, ".lock.sess-1");
		expect(existsSync(lockPath)).toBe(false);
	});

	test("cleans up lockfile even when fn throws", async () => {
		let threw = false;
		try {
			await withSessionLock(
				"sess-throw",
				async () => {
					throw new Error("fn error");
				},
				tempDir,
			);
		} catch (err) {
			threw = true;
			expect((err as Error).message).toBe("fn error");
		}

		expect(threw).toBe(true);

		// Lockfile should be cleaned up despite the throw
		const lockPath = join(tempDir, ".lock.sess-throw");
		expect(existsSync(lockPath)).toBe(false);
	});

	test("returns null when lock already held by live process", async () => {
		// Current process is live — write its PID as the lock holder
		const lockPath = join(tempDir, ".lock.sess-live");
		const livePid = process.pid;
		await Bun.write(lockPath, `${livePid} ${new Date().toISOString()}`);

		let fnRan = false;
		const result = await withSessionLock(
			"sess-live",
			async () => {
				fnRan = true;
				return "should not reach";
			},
			tempDir,
		);

		expect(result).toBeNull();
		expect(fnRan).toBe(false);
	});

	test("reclaims lock from dead process", async () => {
		// PID 99999999 is virtually guaranteed to be dead
		const lockPath = join(tempDir, ".lock.sess-dead");
		const deadPid = 99999999;
		await Bun.write(lockPath, `${deadPid} ${new Date().toISOString()}`);

		let ran = false;
		const result = await withSessionLock(
			"sess-dead",
			async () => {
				ran = true;
				return "reclaimed";
			},
			tempDir,
		);

		expect(ran).toBe(true);
		expect(result).toBe("reclaimed");

		// Lockfile cleaned up
		expect(existsSync(lockPath)).toBe(false);
	});

	test("handles concurrent calls for same session — one succeeds, one returns null", async () => {
		const results: Array<string | null> = [];

		// Both calls start nearly simultaneously. One should win the lock, the other should get null.
		const [r1, r2] = await Promise.all([
			withSessionLock(
				"sess-concurrent",
				async () => {
					// Hold the lock for a moment to ensure overlap
					await new Promise((resolve) => setTimeout(resolve, 50));
					return "winner";
				},
				tempDir,
			),
			withSessionLock(
				"sess-concurrent",
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 50));
					return "also-winner";
				},
				tempDir,
			),
		]);

		results.push(r1, r2);

		// One should have succeeded, the other should be null
		const winners = results.filter((r) => r !== null);
		const nulls = results.filter((r) => r === null);

		expect(winners).toHaveLength(1);
		expect(nulls).toHaveLength(1);

		// Lockfile should be cleaned up
		const lockPath = join(tempDir, ".lock.sess-concurrent");
		expect(existsSync(lockPath)).toBe(false);
	});
});
