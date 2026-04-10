import { describe, expect, test } from "bun:test";
import { parseGitRemoteUrl } from "../src/git-hint";

describe("parseGitRemoteUrl", () => {
	test("extracts repo name from HTTPS URL", () => {
		expect(parseGitRemoteUrl("https://github.com/amentistudio/loombrain.com")).toBe(
			"loombrain.com",
		);
	});

	test("strips .git suffix from HTTPS URL", () => {
		expect(parseGitRemoteUrl("https://github.com/amentistudio/loombrain.com.git")).toBe(
			"loombrain.com",
		);
	});

	test("extracts repo name from SSH URL", () => {
		expect(parseGitRemoteUrl("git@github.com:amentistudio/loombrain.com.git")).toBe(
			"loombrain.com",
		);
	});

	test("handles SSH URL without .git suffix", () => {
		expect(parseGitRemoteUrl("git@github.com:amentistudio/loombrain.com")).toBe("loombrain.com");
	});

	test("returns null for empty string", () => {
		expect(parseGitRemoteUrl("")).toBeNull();
	});

	test("returns null for whitespace-only", () => {
		expect(parseGitRemoteUrl("   ")).toBeNull();
	});

	test("handles URL with trailing slash", () => {
		expect(parseGitRemoteUrl("https://github.com/amentistudio/loombrain.com/")).toBe(
			"loombrain.com",
		);
	});
});
