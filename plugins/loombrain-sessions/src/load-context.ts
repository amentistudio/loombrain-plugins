/**
 * SessionStart hook: inject LoomBrain project context.
 *
 * On session start, derives a topic from the working directory, fetches the
 * most relevant knowledge nodes from LoomBrain (POST /api/v1/context), and
 * prints them to stdout so Claude Code adds them as session context. The brain
 * becomes the ambient context layer instead of something you must remember to
 * query.
 *
 * Hard rule: this hook must NEVER block or break session startup. Every failure
 * path (no auth, no cwd, network error, timeout, bad response) exits 0 with no
 * output. Auth warnings are handled separately by check-auth — we stay silent.
 */
import { basename } from "node:path";
import { type AuthResult, resolveAuth } from "./api-client";
import type { ContextApiResponse, QuestionsApiResponse, SessionHookInput } from "./types";

const FETCH_TIMEOUT_MS = 6_000;
const DEFAULT_LIMIT = 8;
const NODE_LINE_CLIP = 140;

/**
 * Trailing domain TLDs to strip from a project folder name. Repos are commonly
 * named after their domain ("loombrain.com", "iamladi.dev", "atlet.cz"); the
 * suffix isn't part of the topic and dilutes the search, so we drop it to keep
 * the topic aligned with the PARA slug.
 */
const DOMAIN_TLD = /\.(com|net|org|io|dev|app|ai|co|sh|me|xyz|cz|sk|de|uk|eu|us|so|gg|to|fm|tv)$/i;

/** Derive a search topic from the working directory (its project folder name). */
export function deriveTopic(cwd: string): string | null {
	if (!cwd) return null;
	const name = basename(cwd.replace(/\/+$/, ""));
	if (!name || name === "/" || name === ".") return null;
	return name.replace(DOMAIN_TLD, "") || name;
}

function clip(s: string, n: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

/**
 * Fetch ranked context for a topic. Returns null on any failure — callers treat
 * a null as "no context to inject" and stay silent.
 */
export async function fetchContext(
	auth: AuthResult,
	topic: string,
	opts?: { limit?: number; timeoutMs?: number },
): Promise<ContextApiResponse | null> {
	try {
		const res = await fetch(`${auth.apiUrl}/api/v1/context`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: auth.header,
			},
			body: JSON.stringify({ topic, limit: opts?.limit ?? DEFAULT_LIMIT }),
			signal: AbortSignal.timeout(opts?.timeoutMs ?? FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		return (await res.json()) as ContextApiResponse;
	} catch {
		return null;
	}
}

/**
 * Fetch the user's open questions. Returns null on any failure — callers treat
 * a null as "no questions to inject" and stay silent.
 */
export async function fetchOpenQuestions(
	auth: AuthResult,
	opts?: { limit?: number; timeoutMs?: number },
): Promise<QuestionsApiResponse | null> {
	try {
		const limit = opts?.limit ?? DEFAULT_LIMIT;
		const res = await fetch(`${auth.apiUrl}/api/v1/questions?status=open&limit=${limit}`, {
			headers: {
				Authorization: auth.header,
			},
			signal: AbortSignal.timeout(opts?.timeoutMs ?? FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		return (await res.json()) as QuestionsApiResponse;
	} catch {
		return null;
	}
}

/** Format the questions response as a markdown block, or "" when there's nothing. */
export function buildQuestionsBlock(res: QuestionsApiResponse | null): string {
	if (!res || res.questions.length === 0) return "";

	const lines: string[] = ["## ❓ Open questions you're chasing", ""];
	// Defensively bound the render to what we asked for — never trust the server
	// to honor the limit (an old/buggy server returning a huge list shouldn't
	// flood session-start context).
	for (const q of res.questions.slice(0, DEFAULT_LIMIT)) {
		const title = clip(q.title, NODE_LINE_CLIP);
		const suffix = q.evidence_count != null && q.evidence_count > 0
			? ` _(${q.evidence_count} bearing on it)_`
			: "";
		lines.push(`- **${title}**${suffix}`);
	}
	lines.push("");
	return lines.join("\n");
}

/** Format the context response as a markdown block, or "" when there's nothing. */
export function buildContextBlock(res: ContextApiResponse, topic: string): string {
	if (!res.nodes || res.nodes.length === 0) return "";

	const lines: string[] = [`## 🧠 LoomBrain context: ${topic}`];
	if (res.matched_para_item) {
		lines.push(`*Project: ${res.matched_para_item.label} (${res.matched_para_item.category})*`);
	}
	lines.push("");
	for (const n of res.nodes) {
		const detail = n.why || n.summary || "";
		lines.push(detail ? `- **${n.title}** — ${clip(detail, NODE_LINE_CLIP)}` : `- **${n.title}**`);
	}
	lines.push("");
	lines.push(
		'_Recall more with `lb_recall("…")` (synthesized answer) or `lb_get_original(node_id)` (full source)._',
	);
	return lines.join("\n");
}

async function readStdinJson(): Promise<Partial<SessionHookInput>> {
	try {
		const raw = await new Response(Bun.stdin.stream()).text();
		if (!raw.trim()) return {};
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

export async function main(): Promise<number> {
	const input = await readStdinJson();

	const auth = await resolveAuth();
	if (!auth) return 0; // unauthenticated — check-auth handles the warning

	const topic = deriveTopic(input.cwd ?? process.cwd());

	// Fetch context (only when there is a topic) and questions (always) in parallel.
	const [context, questions] = await Promise.all([
		topic ? fetchContext(auth, topic) : Promise.resolve(null),
		fetchOpenQuestions(auth),
	]);

	const contextBlock = topic && context ? buildContextBlock(context, topic) : "";
	const questionsBlock = buildQuestionsBlock(questions);

	const output = [contextBlock, questionsBlock].filter(Boolean).join("\n");
	if (output) process.stdout.write(`${output}\n`);
	return 0;
}

if (import.meta.main) {
	main()
		.then((code) => process.exit(code))
		.catch(() => process.exit(0));
}
