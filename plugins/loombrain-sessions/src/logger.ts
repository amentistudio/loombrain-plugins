import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_DIR = join(homedir(), ".loombrain-sessions");
const LOG_FILE = join(STATE_DIR, "capture.log");
const MAX_LOG_BYTES = 100 * 1024; // 100KB

/**
 * Shared log writer. Creates directories, appends entry, rotates if too large.
 * Never throws.
 */
async function appendLog(
	sessionId: string,
	level: "INFO" | "ERROR",
	message: string,
	logPath = LOG_FILE,
): Promise<void> {
	try {
		await mkdir(dirname(logPath), { recursive: true });
		const entry = `[${new Date().toISOString()}] [${sessionId}] ${level}: ${message}\n`;
		await appendFile(logPath, entry);

		// Truncate if too large — use stat() to avoid reading entire file on every log line
		const fileStats = await stat(logPath);
		if (fileStats.size > MAX_LOG_BYTES) {
			// Keep last ~50KB
			const content = await readFile(logPath, "utf-8");
			const half = content.slice(content.length / 2);
			const firstNewline = half.indexOf("\n");
			await writeFile(logPath, half.slice(firstNewline + 1));
		}
	} catch {
		// Logging must never throw
	}
}

/**
 * Append a timestamped error to the persistent log file.
 */
export async function logError(sessionId: string, message: string, logPath?: string): Promise<void> {
	await appendLog(sessionId, "ERROR", message, logPath);
}

/**
 * Append a timestamped info entry to the persistent log file.
 */
export async function logInfo(sessionId: string, message: string, logPath?: string): Promise<void> {
	await appendLog(sessionId, "INFO", message, logPath);
}

export function getLogPath(): string {
	return LOG_FILE;
}

export function getStateDir(): string {
	return process.env.LB_STATE_DIR ?? STATE_DIR;
}
