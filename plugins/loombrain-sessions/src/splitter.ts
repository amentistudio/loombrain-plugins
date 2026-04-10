import type { CaptureChunk, EpisodeEvent } from "./types";

const MAX_EVENTS = 250;
const MAX_BYTES = 1.8 * 1024 * 1024; // 1.8MB

const encoder = new TextEncoder();

/**
 * Split events into chunks that respect the 250-event and 1.8MB limits.
 * Returns a single chunk (no suffix) when possible, otherwise parts with `-part-N` suffix.
 */
export function splitIntoChunks(events: EpisodeEvent[], sessionId: string): CaptureChunk[] {
	// Fast path: fits in one chunk
	if (events.length <= MAX_EVENTS) {
		const bytes = encoder.encode(JSON.stringify(events)).length;
		if (bytes <= MAX_BYTES) {
			return [{ session_id: sessionId, title: "Claude Code session", events }];
		}
	}

	// Need to split
	const rawChunks: EpisodeEvent[][] = [];
	let current: EpisodeEvent[] = [];
	let currentBytes = 0;

	for (const event of events) {
		const eventBytes = encoder.encode(JSON.stringify(event)).length;

		// Check if adding this event would exceed limits
		// +2 accounts for JSON array separators (comma + bracket overhead)
		const projectedBytes = currentBytes + eventBytes + 2;

		if (current.length >= MAX_EVENTS || (current.length > 0 && projectedBytes > MAX_BYTES)) {
			rawChunks.push(current);
			current = [];
			currentBytes = 0;
		}

		current.push(event);
		currentBytes += eventBytes + 2;
	}

	if (current.length > 0) {
		rawChunks.push(current);
	}

	return rawChunks.map((chunk, i) => ({
		session_id: `${sessionId}-part-${i + 1}`,
		title: `Claude Code session (part ${i + 1} of ${rawChunks.length})`,
		events: chunk,
	}));
}
