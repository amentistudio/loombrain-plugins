import { readFile, unlink } from "node:fs/promises";
import { parseSessionLines } from "./converter";
import { splitIntoChunks } from "./splitter";
import { getProjectHint } from "./git-hint";
import { resolveAuth, buildCapturePayload, postCapture, type AuthResult } from "./api-client";
import { isAlreadyCaptured, markCaptured } from "./idempotency";
import { logError, logInfo } from "./logger";
import { withSessionLock } from "./locks";
import type { CaptureApiResponse, CaptureChunk, EpisodeEvent, SessionHookInput } from "./types";

const MIN_MEANINGFUL_EVENTS = 5;

export interface HookInputResult {
	raw: string;
	tempFile?: string;
}

/**
 * Read hook input from --stdin-file argument or fall back to stdin.
 * When reading from a temp file, deletes it after reading.
 */
export async function readHookInput(
	argv: string[],
	stdinStream: ReadableStream = Bun.stdin.stream(),
): Promise<HookInputResult> {
	const idx = argv.indexOf("--stdin-file");
	if (idx !== -1 && idx + 1 < argv.length) {
		const tempFile = argv[idx + 1];
		const raw = await readFile(tempFile, "utf-8");
		await unlink(tempFile).catch(() => {});
		return { raw, tempFile };
	}

	// Fall back to stdin
	const raw = await new Response(stdinStream).text();
	return { raw };
}

export interface ProcessResult {
	skipped: boolean;
	reason?: string;
	chunks?: CaptureChunk[];
}

/**
 * Count events with roles that indicate meaningful human interaction.
 */
export function countMeaningfulEvents(events: EpisodeEvent[]): number {
	return events.filter((e) => e.role === "user" || e.role === "assistant").length;
}

/**
 * Process a session transcript into chunks ready for capture.
 * Does NOT perform API calls — pure data transformation.
 */
export async function processSession(
	sessionId: string,
	transcriptContent: string,
	cwd: string,
): Promise<ProcessResult> {
	const lines = transcriptContent.split("\n").filter(Boolean);
	const events = parseSessionLines(lines);

	if (countMeaningfulEvents(events) < MIN_MEANINGFUL_EVENTS) {
		return { skipped: true, reason: `<${MIN_MEANINGFUL_EVENTS} meaningful events` };
	}

	const paraHint = await getProjectHint(cwd);
	const chunks = splitIntoChunks(events, sessionId, paraHint ?? undefined);

	// Attach para_hint to all chunks for PARA classification
	if (paraHint) {
		for (const chunk of chunks) {
			chunk.para_hint = paraHint;
		}
	}

	return { skipped: false, chunks };
}

export interface SessionEndOptions {
	stateDir?: string;
	postCaptureFn?: (
		payload: Parameters<typeof postCapture>[0],
		auth: AuthResult,
		sessionId: string,
	) => Promise<CaptureApiResponse | null>;
	markCapturedFn?: (key: string) => Promise<void>;
	isAlreadyCapturedFn?: (key: string) => Promise<boolean>;
	resolveAuthFn?: typeof resolveAuth;
}

/**
 * SessionEnd handler: reads transcript, uploads chunks to LoomBrain.
 * Accepts optional injectable dependencies for testing.
 */
export async function runSessionEnd(
	input: SessionHookInput,
	options: SessionEndOptions = {},
): Promise<void> {
	const sessionId = input.session_id;
	const {
		stateDir,
		postCaptureFn = postCapture,
		markCapturedFn = markCaptured,
		isAlreadyCapturedFn = isAlreadyCaptured,
		resolveAuthFn = resolveAuth,
	} = options;

	await logInfo(sessionId, `Processing session from ${input.transcript_path}`);

	if (!input.transcript_path) {
		await logError(sessionId, "No transcript_path provided");
		return;
	}

	if (await isAlreadyCapturedFn(sessionId)) return;

	// Wrap the entire processing in a session lock
	await withSessionLock(
		sessionId,
		async () => {
			const content = await readFile(input.transcript_path, "utf-8");
			const result = await processSession(sessionId, content, input.cwd);

			if (result.skipped || !result.chunks) return;

			const auth = await resolveAuthFn();
			if (!auth) {
				await logError(
					sessionId,
					"Not logged in — session not captured. Run /lb:login or set LB_TOKEN env var.",
				);
				return;
			}

			let uploaded = 0;
			for (const chunk of result.chunks) {
				if (await isAlreadyCapturedFn(chunk.session_id)) continue;

				const payload = buildCapturePayload(chunk);
				const response = await postCaptureFn(payload, auth, sessionId);

				if (response) {
					await markCapturedFn(chunk.session_id);
					uploaded++;
				}
			}

			// FIX (FR-7): Only mark root session as captured when ALL chunks succeeded
			if (uploaded === result.chunks.length) {
				await markCapturedFn(sessionId);
			}

			await logInfo(
				sessionId,
				`Capture complete: ${uploaded}/${result.chunks.length} chunk(s) uploaded`,
			);
		},
		stateDir,
	);
}

/**
 * Main entry point for the capture hook (SessionEnd only).
 * ALWAYS exits 0.
 */
async function main(): Promise<void> {
	let sessionId = "unknown";

	try {
		await logInfo(sessionId, "Capture hook started");

		// Read input: prefer --stdin-file, fall back to stdin
		const { raw } = await readHookInput(process.argv.slice(2));
		const input: SessionHookInput = JSON.parse(raw);
		sessionId = input.session_id;

		await runSessionEnd(input);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		await logError(sessionId, `Unhandled error: ${msg}`);
	}
}

// Only run main when executed directly (not imported by tests)
if (import.meta.main) {
	main().then(() => process.exit(0));
}
