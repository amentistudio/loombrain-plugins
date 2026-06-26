import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuthResult } from "../src/api-client";
import {
	buildConstraintsBlock,
	buildContextBlock,
	buildQuestionsBlock,
	deriveTopic,
	fetchConstraints,
	fetchContext,
	fetchOpenQuestions,
} from "../src/load-context";
import type { ConstraintsApiResponse, ContextApiResponse, QuestionsApiResponse } from "../src/types";

describe("deriveTopic", () => {
	test("returns the basename of a project path", () => {
		expect(deriveTopic("/Users/x/Projects/secondbrain")).toBe("secondbrain");
	});

	test("ignores a trailing slash", () => {
		expect(deriveTopic("/Users/x/Projects/myapp/")).toBe("myapp");
	});

	test("strips a trailing domain TLD so the topic matches the PARA slug", () => {
		// Domain-named project folders ("loombrain.com") should search for the
		// project ("loombrain"), not the literal folder name — the ".com"
		// dilutes the topic match and pulls in unrelated nodes.
		expect(deriveTopic("/Users/x/Projects/loombrain.com")).toBe("loombrain");
		expect(deriveTopic("/Users/x/Projects/iamladi.dev")).toBe("iamladi");
		expect(deriveTopic("/Users/x/Projects/atlet.cz")).toBe("atlet");
		expect(deriveTopic("/Users/x/Projects/myapp.io/")).toBe("myapp");
	});

	test("leaves non-domain names with dots untouched", () => {
		// Only a final segment that looks like a TLD is stripped; a longer
		// trailing segment is part of the name.
		expect(deriveTopic("/Users/x/Projects/save.attachments")).toBe("save.attachments");
		expect(deriveTopic("/Users/x/Projects/fitreport")).toBe("fitreport");
	});

	test("falls back to the full name when stripping would empty it", () => {
		expect(deriveTopic("/Users/x/Projects/.com")).toBe(".com");
	});

	test("returns null for empty or root paths", () => {
		expect(deriveTopic("")).toBeNull();
		expect(deriveTopic("/")).toBeNull();
	});
});

describe("buildContextBlock", () => {
	const res: ContextApiResponse = {
		nodes: [
			{ id: "n1", title: "Kombucha brewing basics", why: "Reference for first ferment", score: 0.9, reasons: [] },
			{ id: "n2", title: "SCOBY care", summary: "Keep it covered and warm.", score: 0.7, reasons: [] },
		],
		matched_para_item: { id: "p1", label: "Fermentation", category: "areas" },
	};

	test("renders a context block with topic, matched project, and node titles", () => {
		const block = buildContextBlock(res, "loombrain.com");
		expect(block).toContain("LoomBrain context");
		expect(block).toContain("loombrain.com");
		expect(block).toContain("Fermentation");
		expect(block).toContain("Kombucha brewing basics");
		expect(block).toContain("SCOBY care");
	});

	test("prefers why, falls back to summary for the node line", () => {
		const block = buildContextBlock(res, "x");
		expect(block).toContain("Reference for first ferment");
		expect(block).toContain("Keep it covered and warm.");
	});

	test("returns empty string when there are no nodes", () => {
		expect(buildContextBlock({ nodes: [], matched_para_item: null }, "x")).toBe("");
	});
});

describe("fetchContext", () => {
	const auth: AuthResult = { header: "ApiKey test", apiUrl: "https://example.com" };
	let originalFetch: typeof globalThis.fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("POSTs to /api/v1/context with auth + topic and returns the parsed body", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			capturedUrl = url;
			capturedInit = init;
			return new Response(
				JSON.stringify({ nodes: [{ id: "n1", title: "Hit" }], matched_para_item: null }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
			// biome-ignore lint/suspicious/noExplicitAny: test fetch stub
		}) as any;

		const result = await fetchContext(auth, "myproj", { limit: 5 });

		expect(capturedUrl).toBe("https://example.com/api/v1/context");
		expect(capturedInit?.method).toBe("POST");
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("ApiKey test");
		const body = JSON.parse(String(capturedInit?.body));
		expect(body.topic).toBe("myproj");
		expect(body.limit).toBe(5);
		expect(result?.nodes[0]?.title).toBe("Hit");
	});

	test("returns null on a non-ok response", async () => {
		globalThis.fetch = (async () => new Response("nope", { status: 500 })) as any;
		expect(await fetchContext(auth, "x")).toBeNull();
	});

	test("returns null when fetch throws", async () => {
		globalThis.fetch = (async () => {
			throw new Error("network down");
			// biome-ignore lint/suspicious/noExplicitAny: test fetch stub
		}) as any;
		expect(await fetchContext(auth, "x")).toBeNull();
	});
});

describe("fetchOpenQuestions", () => {
	const auth: AuthResult = { header: "ApiKey test", apiUrl: "https://example.com" };
	let originalFetch: typeof globalThis.fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("GETs /api/v1/questions?status=open with the auth header and returns the parsed body", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			capturedUrl = url;
			capturedInit = init;
			return new Response(
				JSON.stringify({ questions: [{ id: "q1", title: "What is the optimal fermentation time?", evidence_count: 3 }] }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
			// biome-ignore lint/suspicious/noExplicitAny: test fetch stub
		}) as any;

		const result = await fetchOpenQuestions(auth, { limit: 5 });

		expect(capturedUrl).toBe("https://example.com/api/v1/questions?status=open&limit=5");
		expect(capturedInit?.method).toBeUndefined(); // GET — no method override needed
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("ApiKey test");
		expect(result?.questions[0]?.title).toBe("What is the optimal fermentation time?");
	});

	test("returns null on a non-ok response", async () => {
		globalThis.fetch = (async () => new Response("nope", { status: 500 })) as any;
		expect(await fetchOpenQuestions(auth)).toBeNull();
	});

	test("returns null when fetch throws", async () => {
		globalThis.fetch = (async () => {
			throw new Error("network down");
			// biome-ignore lint/suspicious/noExplicitAny: test fetch stub
		}) as any;
		expect(await fetchOpenQuestions(auth)).toBeNull();
	});

	test("returns null on a malformed 200 success body, and the render stays clean", async () => {
		// A 200 OK isn't proof of shape. A body that isn't a well-formed
		// QuestionsApiResponse ({}, { questions: null }, a bare string, an array) must
		// become a clean null — otherwise it casts through and buildQuestionsBlock
		// throws on `.length`, breaking the best-effort session-start contract.
		for (const bad of ["{}", '{"questions":null}', '"nope"', "[]"]) {
			globalThis.fetch = (async () =>
				new Response(bad, {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
				// biome-ignore lint/suspicious/noExplicitAny: test fetch stub
			) as any;

			const result = await fetchOpenQuestions(auth);
			expect(result).toBeNull();
			// Downstream render must stay empty rather than throw — hook exits cleanly.
			expect(buildQuestionsBlock(result)).toBe("");
		}
	});
});

describe("buildQuestionsBlock", () => {
	test("renders the header and each question title", () => {
		const res: QuestionsApiResponse = {
			questions: [
				{ id: "q1", title: "What is the optimal fermentation time?", evidence_count: 3 },
				{ id: "q2", title: "Which SCOBY vendor is best?", evidence_count: 0 },
			],
		};
		const block = buildQuestionsBlock(res);
		expect(block).toContain("Open questions");
		expect(block).toContain("What is the optimal fermentation time?");
		expect(block).toContain("Which SCOBY vendor is best?");
	});

	test("renders the evidence_count suffix only when evidence_count > 0", () => {
		const res: QuestionsApiResponse = {
			questions: [
				{ id: "q1", title: "With evidence", evidence_count: 5 },
				{ id: "q2", title: "Without evidence", evidence_count: 0 },
				{ id: "q3", title: "No count field" },
			],
		};
		const block = buildQuestionsBlock(res);
		expect(block).toContain("5 bearing");
		expect(block).not.toContain("0 bearing");
		// the no-count question should appear without the suffix
		expect(block).toContain("- **No count field**");
	});

	test("caps the render to the requested limit, not DEFAULT_LIMIT", () => {
		// Server over-returns; the render must not exceed what the caller asked for.
		const res: QuestionsApiResponse = {
			questions: Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, title: `Question ${i}` })),
		};
		const block = buildQuestionsBlock(res, 2);
		expect(block).toContain("Question 0");
		expect(block).toContain("Question 1");
		expect(block).not.toContain("Question 2");
	});

	test("returns empty string for null", () => {
		expect(buildQuestionsBlock(null)).toBe("");
	});

	test("returns empty string for an empty questions array", () => {
		expect(buildQuestionsBlock({ questions: [] })).toBe("");
	});
});

describe("fetchConstraints", () => {
	const auth: AuthResult = { header: "ApiKey test", apiUrl: "https://example.com" };
	let originalFetch: typeof globalThis.fetch;
	beforeEach(() => {
		originalFetch = globalThis.fetch;
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	test("GETs /api/v1/constraints?status=active&scope=global with the auth header and returns the parsed body", async () => {
		let capturedUrl = "";
		let capturedInit: RequestInit | undefined;
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			capturedUrl = url;
			capturedInit = init;
			return new Response(
				JSON.stringify({ constraints: [{ id: "c1", title: "Only web apps, TS + Bun", scope: "global" }] }),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
			// biome-ignore lint/suspicious/noExplicitAny: test fetch stub
		}) as any;

		const result = await fetchConstraints(auth, { limit: 5 });

		expect(capturedUrl).toBe(
			"https://example.com/api/v1/constraints?status=active&scope=global&limit=5",
		);
		expect(capturedInit?.method).toBeUndefined(); // GET — no method override needed
		const headers = capturedInit?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("ApiKey test");
		expect(result?.constraints[0]?.title).toBe("Only web apps, TS + Bun");
	});

	test("returns null on a non-ok response", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test fetch stub
		globalThis.fetch = (async () => new Response("nope", { status: 500 })) as any;
		expect(await fetchConstraints(auth)).toBeNull();
	});

	test("returns null when fetch throws", async () => {
		globalThis.fetch = (async () => {
			throw new Error("network down");
			// biome-ignore lint/suspicious/noExplicitAny: test fetch stub
		}) as any;
		expect(await fetchConstraints(auth)).toBeNull();
	});

	test("returns null on a malformed 200 success body, and the render stays clean", async () => {
		// A 200 OK is not proof of shape. A body that isn't a well-formed
		// ConstraintsApiResponse ({}, { constraints: null }, a bare string, an array)
		// must become a clean null — otherwise it casts straight through and
		// buildConstraintsBlock throws on `.length`, breaking the best-effort
		// session-start contract.
		for (const bad of ["{}", '{"constraints":null}', '"nope"', "[]"]) {
			globalThis.fetch = (async () =>
				new Response(bad, {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})
				// biome-ignore lint/suspicious/noExplicitAny: test fetch stub
			) as any;

			const result = await fetchConstraints(auth);
			expect(result).toBeNull();
			// Downstream render must stay empty rather than throw — hook exits cleanly.
			expect(buildConstraintsBlock(result)).toBe("");
		}
	});
});

describe("buildConstraintsBlock", () => {
	test("renders the header and each constraint title", () => {
		const res: ConstraintsApiResponse = {
			constraints: [
				{ id: "c1", title: "Only web apps/extensions, TypeScript, Bun", scope: "global" },
				{ id: "c2", title: "Copy proven markets, compete on retention", scope: "global" },
			],
		};
		const block = buildConstraintsBlock(res);
		expect(block).toContain("Constraints you work under");
		expect(block).toContain("Only web apps/extensions, TypeScript, Bun");
		expect(block).toContain("Copy proven markets, compete on retention");
	});

	test("caps the render to the requested limit, not DEFAULT_LIMIT", () => {
		const res: ConstraintsApiResponse = {
			constraints: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, title: `Rule ${i}` })),
		};
		const block = buildConstraintsBlock(res, 2);
		expect(block).toContain("Rule 0");
		expect(block).toContain("Rule 1");
		expect(block).not.toContain("Rule 2");
	});

	test("returns empty string for null", () => {
		expect(buildConstraintsBlock(null)).toBe("");
	});

	test("returns empty string for an empty constraints array", () => {
		expect(buildConstraintsBlock({ constraints: [] })).toBe("");
	});
});
