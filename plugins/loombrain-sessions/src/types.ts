/** Roles matching EpisodeEventRoleSchema from @loombrain/shared */
export type EpisodeEventRole = "user" | "assistant" | "tool_call" | "tool_result" | "system";

/** Matches EpisodeEventSchema from @loombrain/shared */
export interface EpisodeEvent {
	seq: number;
	role: EpisodeEventRole;
	content: string;
	tool_name?: string;
	tool_call_id?: string;
	occurred_at: string;
	metadata?: Record<string, unknown>;
}

/** Input from Claude Code SessionEnd/SessionStart hook stdin */
export interface SessionHookInput {
	session_id: string;
	transcript_path: string;
	cwd: string;
	hook_event_name?: string;
	reason?: string;
	source?: string;
}

/** Content block inside a tool_result or message content array */
export interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: string | ContentBlock[];
	source?: unknown;
}

/** tool_result content can be a plain string or an array of content blocks */
export type ToolResultContent = string | ContentBlock[];

/** A chunk of events ready for API submission */
export interface CaptureChunk {
	session_id: string;
	title: string;
	events: EpisodeEvent[];
	para_hint?: string;
}

/** Matches CreateCaptureRequestSchema from @loombrain/shared */
export interface CaptureApiPayload {
	title: string;
	content_type: "session";
	source: "agent";
	captured_at: string;
	why: string;
	raw_content?: string;
	para_hint?: string;
	session_id: string;
	episode_events: EpisodeEvent[];
}

/** API response for capture creation */
export interface CaptureApiResponse {
	id: string;
	status: string;
}

/** A ranked node from POST /api/v1/context (subset of the API's NodeResponse). */
export interface ContextNode {
	id: string;
	title: string;
	summary?: string | null;
	why?: string | null;
	score?: number;
	reasons?: string[];
}

/** Response shape of POST /api/v1/context (mirrors SessionContextResponse). */
export interface ContextApiResponse {
	nodes: ContextNode[];
	matched_para_item: { id: string; label: string; category: string } | null;
}

/** CLI config file shape from ~/.config/loombrain/config.json */
export interface CliConfig {
	api_url: string;
	access_token: string;
	refresh_token: string;
	expires_at: number;
}

/** A single open question from GET /api/v1/questions */
export interface QuestionItem {
	id: string;
	title: string;
	evidence_count?: number;
}

/** Response shape of GET /api/v1/questions?status=open */
export interface QuestionsApiResponse {
	questions: QuestionItem[];
}

/** A single constraint from GET /api/v1/constraints (subset of the API response). */
export interface ConstraintItem {
	id: string;
	title: string;
	scope?: "global" | "project";
}

/** Response shape of GET /api/v1/constraints?status=active */
export interface ConstraintsApiResponse {
	constraints: ConstraintItem[];
}
