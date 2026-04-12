import type { EpisodeEvent } from "./types";
import { truncateContent } from "./truncator";

interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: string | ContentBlock[];
}

interface JsonlLine {
	type: string;
	timestamp?: string;
	isMeta?: boolean;
	content?: string | ContentBlock[];
	tool_use_id?: string;
	message?: {
		role: string;
		content: string | ContentBlock[];
	};
}

const SKIP_TYPES = new Set(["file-history-snapshot", "attachment"]);

export function stringifyToolResultContent(content: string | ContentBlock[]): string {
	if (typeof content === "string") return content;
	if (content.length === 0) return "";
	return content
		.map((block) => {
			if (block.type === "text") return block.text ?? "";
			if (block.type === "image") return "[image]";
			return `[unknown: ${block.type}]`;
		})
		.join("\n");
}

/**
 * Parse an array of JSONL line strings into EpisodeEvent[].
 * Each line is independently parsed — malformed lines are skipped.
 */
export function parseSessionLines(lines: string[]): EpisodeEvent[] {
	const events: EpisodeEvent[] = [];
	let lastTimestamp = new Date().toISOString();

	for (const raw of lines) {
		let parsed: JsonlLine;
		try {
			parsed = JSON.parse(raw);
		} catch {
			continue;
		}

		if (SKIP_TYPES.has(parsed.type)) continue;

		const ts = resolveTimestamp(parsed.timestamp, lastTimestamp);
		lastTimestamp = ts;

		if (parsed.type === "user") {
			if (parsed.isMeta) continue;
			processUserLine(parsed, ts, events);
		} else if (parsed.type === "assistant") {
			processAssistantLine(parsed, ts, events);
		} else if (parsed.type === "system") {
			if (parsed.content) {
				pushEvent(events, "system", truncateContent(parsed.content as string), ts);
			}
		} else if (parsed.type === "tool_result") {
			const content = stringifyToolResultContent(parsed.content ?? "");
			pushEvent(events, "tool_result", truncateContent(content), ts, undefined, parsed.tool_use_id);
		}
	}

	return events;
}

function processUserLine(parsed: JsonlLine, ts: string, events: EpisodeEvent[]): void {
	const msg = parsed.message;
	if (!msg) return;

	if (typeof msg.content === "string") {
		pushEvent(events, "user", truncateContent(msg.content), ts);
		return;
	}

	// Array content — separate text blocks from tool_result blocks
	const textParts: string[] = [];
	const toolResults: ContentBlock[] = [];

	for (const block of msg.content) {
		if (block.type === "text" && block.text) {
			textParts.push(block.text);
		} else if (block.type === "tool_result") {
			toolResults.push(block);
		}
	}

	if (textParts.length > 0) {
		pushEvent(events, "user", truncateContent(textParts.join("\n")), ts);
	}

	for (const tr of toolResults) {
		pushEvent(
			events,
			"tool_result",
			truncateContent(stringifyToolResultContent(tr.content ?? "")),
			ts,
			undefined,
			tr.tool_use_id,
		);
	}
}

function processAssistantLine(parsed: JsonlLine, ts: string, events: EpisodeEvent[]): void {
	const msg = parsed.message;
	if (!msg || !Array.isArray(msg.content)) return;

	let pendingText: string[] = [];

	for (const block of msg.content) {
		if (block.type === "thinking") continue;

		if (block.type === "text" && block.text) {
			pendingText.push(block.text);
			continue;
		}

		if (block.type === "tool_use") {
			// Flush any accumulated text before the tool_use
			if (pendingText.length > 0) {
				pushEvent(events, "assistant", truncateContent(pendingText.join("\n")), ts);
				pendingText = [];
			}
			pushEvent(
				events,
				"tool_call",
				truncateContent(JSON.stringify(block.input)),
				ts,
				block.name,
				block.id,
			);
		}
	}

	// Flush remaining text
	if (pendingText.length > 0) {
		pushEvent(events, "assistant", truncateContent(pendingText.join("\n")), ts);
	}
}

function pushEvent(
	events: EpisodeEvent[],
	role: EpisodeEvent["role"],
	content: string,
	occurred_at: string,
	tool_name?: string,
	tool_call_id?: string,
): void {
	const event: EpisodeEvent = {
		seq: events.length,
		role,
		content,
		occurred_at,
	};
	if (tool_name) event.tool_name = tool_name;
	if (tool_call_id) event.tool_call_id = tool_call_id;
	events.push(event);
}

function resolveTimestamp(raw: string | undefined, fallback: string): string {
	if (!raw) return fallback;
	// If it looks like a valid ISO string, use it
	if (raw.includes("T") || raw.includes("-")) {
		const d = new Date(raw);
		if (!Number.isNaN(d.getTime())) return d.toISOString();
	}
	// If it's a numeric epoch
	const num = Number(raw);
	if (!Number.isNaN(num)) {
		const d = new Date(num);
		if (!Number.isNaN(d.getTime())) return d.toISOString();
	}
	return fallback;
}
