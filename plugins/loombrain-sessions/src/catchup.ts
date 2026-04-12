import { readFile, writeFile, unlink, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { processSession } from "./capture-hook";
import { buildCapturePayload, postCapture, resolveAuth, type AuthResult } from "./api-client";
import { markCaptured } from "./idempotency";
import { withSessionLock } from "./locks";
import { logInfo, logError, getStateDir } from "./logger";
import type { CaptureApiResponse } from "./types";
import type { ProcessResult } from "./capture-hook";

export interface OrphanFile {
	path: string;
	sessionId: string;
	mtime: Date;
}

export interface CatchupResult {
	scanned: number;
	orphans: number;
	uploaded: number;
	deferred: number;
	failed: number;
	capped: boolean;
	cooledDown: boolean;
}

export const CATCHUP_LOOKBACK_DAYS = 7;
export const CATCHUP_FIRST_RUN_LOOKBACK_DAYS = 30;
export const CATCHUP_MAX_UPLOADS_PER_RUN = 20;
export const CATCHUP_QUIESCENCE_MS = 120_000;
export const CATCHUP_MAX_FILE_BYTES = 50 * 1024 * 1024; // 50MB — skip oversized transcripts to prevent OOM

const COOLDOWN_FILE = ".auth-cooldown-until";
const V3_MARKER_FILE = ".v3-marker";

/**
 * Extract session_id from a JSONL file path.
 * The filename (without .jsonl extension) IS the session_id.
 */
export function extractSessionIdFromPath(filePath: string): string {
	const name = basename(filePath);
	return name.endsWith(".jsonl") ? name.slice(0, -6) : name;
}

/**
 * Reverse Claude Code's project directory encoding.
 * The dir name is the path with `/` replaced by `-`.
 * `-Users-x-project` → `/Users/x/project`
 * Returns null if the path doesn't start with `-`.
 *
 * KNOWN LIMITATION: This encoding is lossy — hyphens in the original path
 * (e.g., `/Users/x/my-project`) are indistinguishable from path separators.
 * The result is best-effort and used only for para_hint; catchup uploads
 * with null para_hint are acceptable.
 */
export function deriveCwdFromProjectDir(projectDir: string): string | null {
	if (!projectDir.startsWith("-")) return null;
	// Replace all `-` with `/`
	return projectDir.replace(/-/g, "/");
}

/**
 * Check if auth cooldown is currently active.
 */
export async function isAuthCooldownActive(stateDir?: string): Promise<boolean> {
	const dir = stateDir ?? getStateDir();
	const filePath = join(dir, COOLDOWN_FILE);
	try {
		if (!existsSync(filePath)) return false;
		const content = await readFile(filePath, "utf-8");
		const until = new Date(content.trim());
		return until > new Date();
	} catch {
		return false;
	}
}

/**
 * Write auth cooldown timestamp (now + durationMs) to state file.
 */
export async function setAuthCooldown(durationMs: number, stateDir?: string): Promise<void> {
	try {
		const dir = stateDir ?? getStateDir();
		await mkdir(dir, { recursive: true });
		const until = new Date(Date.now() + durationMs).toISOString();
		await writeFile(join(dir, COOLDOWN_FILE), until, "utf-8");
	} catch {
		// Best-effort — hook must always exit 0
	}
}

/**
 * Remove auth cooldown file.
 */
export async function clearAuthCooldown(stateDir?: string): Promise<void> {
	const dir = stateDir ?? getStateDir();
	const filePath = join(dir, COOLDOWN_FILE);
	try {
		await unlink(filePath);
	} catch {
		// Already gone — fine
	}
}

/**
 * Glob projectsDir for JSONL transcripts and return those that are orphans:
 * - within the lookback window
 * - older than the quiescence threshold (not recently modified)
 * - not already captured
 * - not the active session
 * - not empty
 * Results sorted by mtime descending (newest first).
 */
export async function findOrphanTranscripts(options: {
	lookbackDays: number;
	quiescenceMs: number;
	activeSessionId: string | null;
	capturedSessions: Set<string>;
	projectsDir: string;
}): Promise<OrphanFile[]> {
	const { lookbackDays, quiescenceMs, activeSessionId, capturedSessions, projectsDir } = options;

	const now = Date.now();
	const lookbackCutoff = now - lookbackDays * 24 * 60 * 60 * 1000;
	const quiescenceCutoff = now - quiescenceMs;

	// Glob all *.jsonl files under projectsDir/*/*.jsonl
	const glob = new Bun.Glob("*/*.jsonl");
	const orphans: OrphanFile[] = [];

	for await (const relPath of glob.scan({ cwd: projectsDir })) {
		const filePath = join(projectsDir, relPath);
		const sessionId = extractSessionIdFromPath(filePath);

		// Skip active session
		if (activeSessionId && sessionId === activeSessionId) continue;

		// Skip already captured
		if (capturedSessions.has(sessionId)) continue;

		let fileStats: Awaited<ReturnType<typeof stat>>;
		try {
			fileStats = await stat(filePath);
		} catch {
			continue;
		}

		const mtimeMs = fileStats.mtimeMs;

		// Skip empty files
		if (fileStats.size === 0) continue;

		// Skip oversized files to prevent OOM (re-scanned each run but skipped instantly)
		if (fileStats.size > CATCHUP_MAX_FILE_BYTES) {
			await logInfo(sessionId, `Catchup: skipping oversized file (${Math.round(fileStats.size / 1024 / 1024)}MB)`);
			continue;
		}

		// Skip files outside lookback window
		if (mtimeMs < lookbackCutoff) continue;

		// Skip files within quiescence window (too recently modified)
		if (mtimeMs > quiescenceCutoff) continue;

		orphans.push({
			path: filePath,
			sessionId,
			mtime: new Date(mtimeMs),
		});
	}

	// Sort by mtime descending (newest first)
	orphans.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

	return orphans;
}

/**
 * Resurrection scan: re-uploads sessions in captured-sessions that were
 * false-captured by pre-v0.3.0 code (no .success marker means upload never
 * actually confirmed). The API is idempotent on session_id, so re-uploading
 * is safe.
 */
export async function runResurrectionScan(options: {
	stateDir: string;
	projectsDir: string;
	capturedSessions: Set<string>;
	lookbackDays: number;
	auth: AuthResult;
	processSessionFn: typeof processSession;
	postCaptureFn: (
		payload: Parameters<typeof postCapture>[0],
		auth: AuthResult,
		sessionId: string,
	) => Promise<CaptureApiResponse | null>;
	markCapturedFn: typeof markCaptured;
}): Promise<{ rescanned: number; resurrected: number; failed: number }> {
	const {
		stateDir,
		projectsDir,
		capturedSessions,
		lookbackDays,
		auth,
		processSessionFn,
		postCaptureFn,
		markCapturedFn,
	} = options;

	const lookbackCutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
	let rescanned = 0;
	let resurrected = 0;
	let failed = 0;

	// Build a Map<sessionId, path> from a single glob scan (O(M) instead of O(N*M))
	const sessionPathMap = new Map<string, string>();
	const allGlob = new Bun.Glob("*/*.jsonl");
	for await (const relPath of allGlob.scan({ cwd: projectsDir })) {
		const filePath = join(projectsDir, relPath);
		const sid = extractSessionIdFromPath(filePath);
		if (capturedSessions.has(sid)) {
			sessionPathMap.set(sid, filePath);
		}
	}

	for (const sessionId of capturedSessions) {
		const foundPath = sessionPathMap.get(sessionId);
		if (!foundPath) continue;

		// Check if within lookback window + size guard
		try {
			const fileStats = await stat(foundPath);
			if (fileStats.mtimeMs < lookbackCutoff) continue;
			if (fileStats.size === 0) continue;
			if (fileStats.size > CATCHUP_MAX_FILE_BYTES) {
				await logInfo(sessionId, `Resurrection: skipping oversized file (${Math.round(fileStats.size / 1024 / 1024)}MB)`);
				continue;
			}
		} catch {
			continue;
		}

		rescanned++;

		// Check if .success marker exists
		const markerPath = join(stateDir, `.success.${sessionId}`);
		if (existsSync(markerPath)) {
			// Truly captured — skip
			continue;
		}

		// False-captured — attempt re-upload
		await logInfo(sessionId, `Resurrection: re-uploading false-captured session`);

		// Use per-session lock to prevent double-fire resurrection
		const lockResult = await withSessionLock(
			sessionId,
			async () => {
				// Re-check .success marker inside lock (another process may have written it)
				if (existsSync(join(stateDir, `.success.${sessionId}`))) return "skipped" as const;

				let content: string;
				try {
					content = await readFile(foundPath, "utf-8");
				} catch {
					return "failed" as const;
				}

				const projectDirName = basename(dirname(foundPath));
				const cwd = deriveCwdFromProjectDir(projectDirName) ?? "/";

				let processed: Awaited<ReturnType<typeof processSession>>;
				try {
					processed = await processSessionFn(sessionId, content, cwd);
				} catch {
					return "failed" as const;
				}

				if (processed.skipped || !processed.chunks?.length) return "skipped" as const;

				let chunksUploaded = 0;
				for (const chunk of processed.chunks) {
					const payload = buildCapturePayload(chunk);
					const response = await postCaptureFn(payload, auth, sessionId);
					if (response) {
						await markCapturedFn(chunk.session_id);
						chunksUploaded++;
					}
				}
				if (chunksUploaded === processed.chunks.length) {
					try {
						await writeFile(join(stateDir, `.success.${sessionId}`), new Date().toISOString());
					} catch {
						// Non-critical
					}
					return "resurrected" as const;
				}
				return "failed" as const;
			},
			stateDir,
		);

		if (lockResult === "resurrected") {
			resurrected++;
		} else if (lockResult === "failed") {
			failed++;
		}
	}

	return { rescanned, resurrected, failed };
}

/**
 * Main catchup orchestrator: discovers orphan transcripts and uploads them.
 */
export async function runCatchup(options: {
	activeSessionId: string;
	isFirstRun: boolean;
	stateDir?: string;
	projectsDir?: string;
	processSessionFn?: typeof processSession;
	postCaptureFn?: (
		payload: Parameters<typeof postCapture>[0],
		auth: AuthResult,
		sessionId: string,
	) => Promise<CaptureApiResponse | null>;
	resolveAuthFn?: typeof resolveAuth;
	markCapturedFn?: typeof markCaptured;
	isAlreadyCapturedFn?: (key: string) => Promise<boolean>;
}): Promise<CatchupResult> {
	const {
		activeSessionId,
		isFirstRun,
		stateDir: injectedStateDir,
		projectsDir: injectedProjectsDir,
		processSessionFn = processSession,
		postCaptureFn = postCapture,
		resolveAuthFn = resolveAuth,
		markCapturedFn = markCaptured,
		isAlreadyCapturedFn,
	} = options;

	const stateDir = injectedStateDir ?? getStateDir();

	// Default projectsDir: ~/.claude/projects
	const { homedir } = await import("node:os");
	const projectsDir = injectedProjectsDir ?? join(homedir(), ".claude", "projects");

	const result: CatchupResult = {
		scanned: 0,
		orphans: 0,
		uploaded: 0,
		deferred: 0,
		failed: 0,
		capped: false,
		cooledDown: false,
	};

	// 1. Check auth cooldown
	if (await isAuthCooldownActive(stateDir)) {
		await logInfo(activeSessionId, "Catchup: auth cooldown active, skipping");
		result.cooledDown = true;
		return result;
	}

	// 2. Build captured sessions set — always read from file (needed for both
	// orphan filtering and resurrection scan's pre-run snapshot)
	const capturedSessions = new Set<string>();
	try {
		const capturedFile = join(stateDir, "captured-sessions");
		if (existsSync(capturedFile)) {
			const content = await readFile(capturedFile, "utf-8");
			for (const line of content.split("\n")) {
				if (line.trim()) capturedSessions.add(line.trim());
			}
		}
	} catch {
		// Ignore read errors
	}

	// 3. Determine lookback
	const lookbackDays = isFirstRun ? CATCHUP_FIRST_RUN_LOOKBACK_DAYS : CATCHUP_LOOKBACK_DAYS;

	// 4. Find orphan transcripts
	const rawOrphans = await findOrphanTranscripts({
		lookbackDays,
		quiescenceMs: CATCHUP_QUIESCENCE_MS,
		activeSessionId,
		capturedSessions,
		projectsDir,
	});

	// Additional per-session filter using injected isAlreadyCapturedFn (for testability)
	let orphans = rawOrphans;
	if (isAlreadyCapturedFn) {
		const filtered: OrphanFile[] = [];
		for (const orphan of rawOrphans) {
			if (!await isAlreadyCapturedFn(orphan.sessionId)) {
				filtered.push(orphan);
			}
		}
		orphans = filtered;
	}

	result.scanned = rawOrphans.length + capturedSessions.size; // approximate
	result.orphans = orphans.length;

	// 5. Resolve auth
	const auth = await resolveAuthFn();
	if (!auth) {
		await logError(activeSessionId, "Catchup: not authenticated, skipping");
		await setAuthCooldown(60 * 60 * 1000, stateDir);
		return result;
	}

	// 6. Process each orphan (up to cap)
	const toProcess = orphans.slice(0, CATCHUP_MAX_UPLOADS_PER_RUN);
	if (orphans.length > CATCHUP_MAX_UPLOADS_PER_RUN) {
		result.capped = true;
	}

	for (const orphan of toProcess) {
		const lockResult = await withSessionLock(
			orphan.sessionId,
			async () => {
				// Read file content
				let content: string;
				try {
					content = await readFile(orphan.path, "utf-8");
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					await logError(orphan.sessionId, `Catchup: failed to read file: ${msg}`);
					return "failed" as const;
				}

				// Derive cwd from the project directory name
				const projectDirName = basename(dirname(orphan.path));
				const cwd = deriveCwdFromProjectDir(projectDirName) ?? "/";

				// Process session
				let processed: ProcessResult;
				try {
					processed = await processSessionFn(orphan.sessionId, content, cwd);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					await logError(orphan.sessionId, `Catchup: processSession error: ${msg}`);
					return "failed" as const;
				}

				if (processed.skipped || !processed.chunks?.length) {
					await logInfo(orphan.sessionId, `Catchup: skipped — ${processed.reason ?? "no chunks"}`);
					return "skipped" as const;
				}

				// Upload each chunk
				let chunkUploaded = 0;
				for (const chunk of processed.chunks) {
					// Skip already-captured chunks (crash-retry safety)
					if (isAlreadyCapturedFn && (await isAlreadyCapturedFn(chunk.session_id))) {
						chunkUploaded++;
						continue;
					}
					const payload = buildCapturePayload(chunk);
					const response = await postCaptureFn(payload, auth, orphan.sessionId);
					if (response) {
						await markCapturedFn(chunk.session_id);
						chunkUploaded++;
					} else {
						await logError(orphan.sessionId, `Catchup: chunk upload failed for ${chunk.session_id}`);
					}
				}

				// Only mark root session captured when ALL chunks succeeded
				if (chunkUploaded === processed.chunks.length) {
					await markCapturedFn(orphan.sessionId);
					return "uploaded" as const;
				}

				return "failed" as const;
			},
			stateDir,
		);

		if (lockResult === null) {
			// Lock not acquired
			result.deferred++;
		} else if (lockResult === "uploaded") {
			result.uploaded++;
		} else if (lockResult === "failed") {
			result.failed++;
		}
		// "skipped" doesn't increment any counter
	}

	// 7b. Resurrection scan — only on first run (before writing .v3-marker)
	if (isFirstRun) {
		let resurrectionClean = false;
		try {
			// Use the pre-run capturedSessions snapshot (built at step 2, before catchup loop)
			// to avoid re-uploading sessions that THIS run just captured
			if (capturedSessions.size > 0) {
				const resurrectionResult = await runResurrectionScan({
					stateDir,
					projectsDir,
					capturedSessions,
					lookbackDays: CATCHUP_FIRST_RUN_LOOKBACK_DAYS,
					auth,
					processSessionFn,
					postCaptureFn,
					markCapturedFn,
				});

				if (resurrectionResult.resurrected > 0 || resurrectionResult.failed > 0) {
					await logInfo(
						activeSessionId,
						`Resurrection scan: rescanned=${resurrectionResult.rescanned}, resurrected=${resurrectionResult.resurrected}, failed=${resurrectionResult.failed}`,
					);
				}

				// Only finalize migration if resurrection had no failures
				// (failed sessions need another attempt on next first-run)
				if (resurrectionResult.failed > 0) {
					await logInfo(activeSessionId, "Resurrection: deferring .v3-marker due to failed sessions");
				} else {
					resurrectionClean = true;
				}
			} else {
				resurrectionClean = true; // no candidates to process
			}
		} catch {
			// Non-critical — resurrection scan must not block normal catchup
			resurrectionClean = true; // don't block marker on scan crash
		}

		// 7c. Write .v3-marker only when resurrection is clean (no partial failures)
		if (resurrectionClean) {
			try {
				await mkdir(stateDir, { recursive: true });
				await writeFile(join(stateDir, V3_MARKER_FILE), new Date().toISOString(), "utf-8");
			} catch {
				// Non-critical
			}

			// 7d. Clean up .success.* markers — only needed during resurrection transition
			try {
				const successGlob = new Bun.Glob(".success.*");
				for await (const relPath of successGlob.scan({ cwd: stateDir })) {
					await unlink(join(stateDir, relPath)).catch(() => {});
				}
			} catch {
				// Non-critical
			}
		}
	}

	// 8. Log summary
	await logInfo(
		activeSessionId,
		`Catchup scan: scanned=${result.scanned}, orphans=${result.orphans}, uploaded=${result.uploaded}, deferred=${result.deferred}, failed=${result.failed}`,
	);

	return result;
}
