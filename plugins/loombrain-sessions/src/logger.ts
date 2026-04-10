import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = join(homedir(), ".loombrain-sessions");
const LOG_FILE = join(STATE_DIR, "capture.log");
const MAX_LOG_BYTES = 100 * 1024; // 100KB

/**
 * Append a timestamped error to the persistent log file.
 * Creates the directory and file if they don't exist.
 * Truncates oldest entries when file exceeds 100KB.
 */
export async function logError(sessionId: string, message: string): Promise<void> {
	try {
		await mkdir(STATE_DIR, { recursive: true });
		const entry = `[${new Date().toISOString()}] [${sessionId}] ERROR: ${message}\n`;
		await appendFile(LOG_FILE, entry);

		// Truncate if too large
		const content = await readFile(LOG_FILE, "utf-8");
		const bytes = new TextEncoder().encode(content).length;
		if (bytes > MAX_LOG_BYTES) {
			// Keep last ~50KB
			const half = content.slice(content.length / 2);
			const firstNewline = half.indexOf("\n");
			await writeFile(LOG_FILE, half.slice(firstNewline + 1));
		}
	} catch {
		// Logging must never throw
	}
}

export function getLogPath(): string {
	return LOG_FILE;
}

export function getStateDir(): string {
	return STATE_DIR;
}
