#!/usr/bin/env bun
import { z } from "zod";
import { readFile } from "fs/promises";
import { join } from "path";

const GitHubSourceSchema = z.object({
	source: z.literal("github"),
	repo: z.string().regex(
		/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/,
		"Invalid GitHub repo format (expected: owner/repo)",
	),
});

const UrlSourceSchema = z.object({
	source: z.literal("url"),
	url: z.string().url(),
});

const RelativeSourceSchema = z.string().startsWith("./");

const SourceSchema = z.union([
	GitHubSourceSchema,
	UrlSourceSchema,
	RelativeSourceSchema,
]);

const PluginSchema = z.object({
	name: z.string().regex(/^[a-z0-9-]+$/, "Plugin name must be kebab-case"),
	source: SourceSchema,
	description: z.string().optional(),
});

export const MarketplaceSchema = z.object({
	name: z.string(),
	description: z.string().optional(),
	owner: z.object({
		name: z.string(),
		email: z.string().email().optional(),
		url: z.string().url().optional(),
	}),
	plugins: z.array(PluginSchema),
});

export type ValidationResult =
	| { success: true; data: z.infer<typeof MarketplaceSchema> }
	| { success: false; error: string };

export async function validateMarketplace(
	cwd: string = process.cwd(),
): Promise<ValidationResult> {
	const marketplacePath = join(cwd, ".claude-plugin/marketplace.json");

	try {
		const content = await readFile(marketplacePath, "utf-8");
		const json = JSON.parse(content);
		const result = MarketplaceSchema.safeParse(json);

		if (!result.success) {
			return {
				success: false,
				error: JSON.stringify(result.error.format(), null, 2),
			};
		}

		return { success: true, data: result.data };
	} catch (error) {
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Unknown error reading marketplace.json",
		};
	}
}

if (import.meta.main) {
	const result = await validateMarketplace();

	if (!result.success) {
		console.error("Marketplace validation failed:");
		console.error(result.error);
		process.exit(1);
	}

	console.log("Marketplace schema is valid");
	console.log(`  Found ${result.data.plugins.length} plugins`);
	for (const plugin of result.data.plugins) {
		console.log(`  - ${plugin.name}`);
	}
}
