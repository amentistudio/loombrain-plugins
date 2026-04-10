import { describe, expect, test } from "bun:test";
import { validateMarketplace, MarketplaceSchema } from "../scripts/validate-marketplace";

const validBase = {
	name: "test-marketplace",
	owner: { name: "Test Owner" },
};

describe("MarketplaceSchema", () => {
	test("accepts relative path source", () => {
		const result = MarketplaceSchema.safeParse({
			...validBase,
			plugins: [{ name: "my-plugin", source: "./plugins/my-plugin" }],
		});
		expect(result.success).toBe(true);
	});

	test("accepts github source", () => {
		const result = MarketplaceSchema.safeParse({
			...validBase,
			plugins: [
				{
					name: "my-plugin",
					source: { source: "github", repo: "owner/repo" },
				},
			],
		});
		expect(result.success).toBe(true);
	});

	test("accepts url source", () => {
		const result = MarketplaceSchema.safeParse({
			...validBase,
			plugins: [
				{
					name: "my-plugin",
					source: { source: "url", url: "https://example.com/plugin.tar.gz" },
				},
			],
		});
		expect(result.success).toBe(true);
	});

	test("rejects invalid source type 'local'", () => {
		const result = MarketplaceSchema.safeParse({
			...validBase,
			plugins: [
				{
					name: "my-plugin",
					source: { source: "local", path: "./plugins/my-plugin" },
				},
			],
		});
		expect(result.success).toBe(false);
	});

	test("rejects non-./ relative path", () => {
		const result = MarketplaceSchema.safeParse({
			...validBase,
			plugins: [{ name: "my-plugin", source: "plugins/my-plugin" }],
		});
		expect(result.success).toBe(false);
	});

	test("rejects non-kebab-case plugin name", () => {
		const result = MarketplaceSchema.safeParse({
			...validBase,
			plugins: [{ name: "MyPlugin", source: "./plugins/my-plugin" }],
		});
		expect(result.success).toBe(false);
	});

	test("rejects invalid github repo format", () => {
		const result = MarketplaceSchema.safeParse({
			...validBase,
			plugins: [
				{
					name: "my-plugin",
					source: { source: "github", repo: "not-a-valid-repo" },
				},
			],
		});
		expect(result.success).toBe(false);
	});

	test("requires owner.name", () => {
		const result = MarketplaceSchema.safeParse({
			name: "test",
			owner: {},
			plugins: [],
		});
		expect(result.success).toBe(false);
	});

	test("accepts optional description on plugins", () => {
		const result = MarketplaceSchema.safeParse({
			...validBase,
			plugins: [
				{
					name: "my-plugin",
					source: "./plugins/my-plugin",
					description: "A test plugin",
				},
			],
		});
		expect(result.success).toBe(true);
	});
});

describe("validateMarketplace", () => {
	test("succeeds for the actual marketplace.json", async () => {
		const result = await validateMarketplace(
			import.meta.dir.replace("/__tests__", ""),
		);
		expect(result.success).toBe(true);
	});

	test("fails for nonexistent path", async () => {
		const result = await validateMarketplace("/nonexistent");
		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
	});
});
