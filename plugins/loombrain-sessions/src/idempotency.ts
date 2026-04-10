import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getStateDir } from "./logger";
import { join } from "node:path";

const CAPTURED_FILE = join(getStateDir(), "captured-sessions");
const MAX_ENTRIES = 1000;
const KEEP_ENTRIES = 500;

/**
 * Check if a chunk key has already been captured.
 */
export async function isAlreadyCaptured(chunkKey: string): Promise<boolean> {
	try {
		if (!existsSync(CAPTURED_FILE)) return false;
		const content = await readFile(CAPTURED_FILE, "utf-8");
		return content.split("\n").includes(chunkKey);
	} catch {
		return false;
	}
}

/**
 * Record a chunk key as successfully captured.
 */
export async function markCaptured(chunkKey: string): Promise<void> {
	try {
		await mkdir(getStateDir(), { recursive: true });
		await appendFile(CAPTURED_FILE, `${chunkKey}\n`);
		await rotateIfNeeded();
	} catch {
		// Must never throw
	}
}

async function rotateIfNeeded(): Promise<void> {
	try {
		const content = await readFile(CAPTURED_FILE, "utf-8");
		const lines = content.split("\n").filter(Boolean);
		if (lines.length > MAX_ENTRIES) {
			const kept = lines.slice(-KEEP_ENTRIES);
			await writeFile(CAPTURED_FILE, `${kept.join("\n")}\n`);
		}
	} catch {
		// Must never throw
	}
}
