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
import type { ContextApiResponse, SessionHookInput } from "./types";

const FETCH_TIMEOUT_MS = 6_000;
const DEFAULT_LIMIT = 8;
const NODE_LINE_CLIP = 140;

/** Derive a search topic from the working directory (its project folder name). */
export function deriveTopic(cwd: string): string | null {
	if (!cwd) return null;
	const name = basename(cwd.replace(/\/+$/, ""));
	if (!name || name === "/" || name === ".") return null;
	return name;
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
	if (!topic) return 0;

	const context = await fetchContext(auth, topic);
	if (!context) return 0;

	const block = buildContextBlock(context, topic);
	if (block) process.stdout.write(`${block}\n`);
	return 0;
}

if (import.meta.main) {
	main()
		.then((code) => process.exit(code))
		.catch(() => process.exit(0));
}
