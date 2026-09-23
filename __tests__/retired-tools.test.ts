import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// loombrain.com #617 narrows the advertised MCP read surface: `lb_get_context`
// and `lb_list_nodes` stop being advertised to human connections (#625). The
// loombrain-projects commands run over a human OAuth connection, so they must
// not name either tool. Project detection is `lb_detect_project`; vision
// enumeration is `lb_review_visions` (#622).
const RETIRED_TOOLS = ["lb_get_context", "lb_list_nodes"];
const COMMANDS_DIR = join(import.meta.dir, "..", "plugins", "loombrain-projects", "commands");

describe("loombrain-projects commands avoid retired MCP tools", () => {
	const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md"));

	test("the commands directory has command files to check", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	for (const file of files) {
		test(`${file} names no retired tool`, () => {
			const text = readFileSync(join(COMMANDS_DIR, file), "utf8");
			const found = RETIRED_TOOLS.filter((tool) => text.includes(tool));
			expect(found).toEqual([]);
		});
	}
});
