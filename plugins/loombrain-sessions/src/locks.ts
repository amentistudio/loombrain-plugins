import { mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logError, logInfo, getStateDir } from "./logger";

/**
 * Execute fn while holding an exclusive lock for the given sessionId.
 * Returns null if the lock could not be acquired (another live process holds it).
 * The lock is automatically released when fn completes (or throws).
 */
export async function withSessionLock<T>(
	sessionId: string,
	fn: () => Promise<T>,
	stateDir?: string,
): Promise<T | null> {
	const dir = stateDir ?? getStateDir();
	const lockPath = join(dir, `.lock.${sessionId}`);

	try {
		await mkdir(dir, { recursive: true });
		await acquireLock(sessionId, lockPath);
	} catch (err) {
		// Lock acquisition failed — either held by a live process or unexpected error
		await logInfo(sessionId, `withSessionLock: skipping — ${(err as Error).message}`);
		return null;
	}

	// Lock acquired — run fn, release in finally
	try {
		const result = await fn();
		return result;
	} finally {
		await releaseLock(sessionId, lockPath);
	}
}

/**
 * Attempt to acquire the lock at lockPath.
 * Throws if the lock is held by a live process.
 * Reclaims the lock if the previous holder is dead.
 */
async function acquireLock(sessionId: string, lockPath: string): Promise<void> {
	const content = `${process.pid} ${new Date().toISOString()}`;

	// Try atomic creation first (O_EXCL — fails if file exists)
	let fh: Awaited<ReturnType<typeof open>> | null = null;
	try {
		fh = await open(lockPath, "wx");
		await fh.writeFile(content);
		return; // Lock acquired
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
			throw err;
		}
		// File exists — check if holder is alive
	} finally {
		await fh?.close();
	}

	// EEXIST: read existing lock and check PID
	let existingContent: string;
	try {
		existingContent = await Bun.file(lockPath).text();
	} catch {
		// File vanished between creation and read — try once more
		fh = null;
		try {
			fh = await open(lockPath, "wx");
			await fh.writeFile(content);
			return;
		} finally {
			await fh?.close();
		}
	}

	const pid = parsePid(existingContent);
	if (pid !== null && isProcessAlive(pid)) {
		throw new Error(`lock held by live process ${pid}`);
	}

	// Previous holder is dead — reclaim via tmp+rename (atomic on POSIX)
	const tmpPath = `${lockPath}.tmp.${process.pid}`;
	await writeFile(tmpPath, content);
	try {
		await rename(tmpPath, lockPath);
	} catch {
		// Rename failed (race) — try to clean up tmp, then throw so caller gets null
		await unlink(tmpPath).catch(() => {});
		throw new Error("lock reclaim race — another process won");
	}

	// Verify we actually won the race — another process may have also renamed
	try {
		const verification = await Bun.file(lockPath).text();
		const verifiedPid = parsePid(verification);
		if (verifiedPid !== process.pid) {
			throw new Error(`lock reclaim race — process ${verifiedPid} won`);
		}
	} catch (err) {
		if ((err as Error).message.includes("lock reclaim race")) throw err;
		throw new Error("lock verification failed after reclaim");
	}

	await logInfo(sessionId, `withSessionLock: reclaimed lock from dead process ${pid}`);
}

async function releaseLock(sessionId: string, lockPath: string): Promise<void> {
	try {
		await unlink(lockPath);
	} catch (err) {
		// Not found is fine (already cleaned up), log other errors
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			await logError(sessionId, `withSessionLock: failed to release lock — ${(err as Error).message}`);
		}
	}
}

function parsePid(content: string): number | null {
	const pidStr = content.split(" ")[0];
	const pid = Number.parseInt(pidStr, 10);
	return Number.isNaN(pid) ? null : pid;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
