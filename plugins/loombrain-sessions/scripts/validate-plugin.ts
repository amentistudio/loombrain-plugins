#!/usr/bin/env bun
import { z } from "zod";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";
import { validateVersions } from "./validate-versions";

const PluginManifestSchema = z.object({
	name: z.string(),
	version: z.string().regex(/^\d+\.\d+\.\d+$/, "Version must follow semver format"),
	description: z.string(),
	author: z.object({
		name: z.string(),
		email: z.string().email().optional(),
		url: z.string().url().optional(),
	}),
	homepage: z.string().url().optional(),
	repository: z.string().url().optional(),
	license: z.string().optional(),
	keywords: z.array(z.string()).optional(),
	commands: z.union([z.string(), z.record(z.any())]).optional(),
	agents: z.union([z.string(), z.array(z.string())]).optional(),
	hooks: z.union([z.string(), z.record(z.any())]).optional(),
	mcpServers: z.union([z.string(), z.record(z.any())]).optional(),
});

async function validatePlugin() {
	const pluginJsonPath = join(process.cwd(), ".claude-plugin/plugin.json");

	try {
		const content = await readFile(pluginJsonPath, "utf-8");
		const json = JSON.parse(content);

		const result = PluginManifestSchema.safeParse(json);

		if (!result.success) {
			console.error("Plugin validation failed:");
			console.error(JSON.stringify(result.error.format(), null, 2));
			process.exit(1);
		}

		console.log(`${result.data.name} v${result.data.version} is valid`);
	} catch (error) {
		if (error instanceof Error) {
			console.error("Error reading plugin.json:", error.message);
		}
		process.exit(1);
	}
}

async function validateReadmeCommands() {
	const pluginJsonPath = join(process.cwd(), ".claude-plugin/plugin.json");
	const readmePath = join(process.cwd(), "README.md");

	if (!existsSync(readmePath)) {
		console.log("No README.md found, skipping README validation");
		return;
	}

	try {
		const pluginContent = await readFile(pluginJsonPath, "utf-8");
		const plugin = JSON.parse(pluginContent);
		const commands = plugin.commands;
		if (!commands || typeof commands !== "object") {
			console.log("No commands in plugin.json, skipping README validation");
			return;
		}

		// Command keys from plugin.json are the canonical names (e.g., "lb:capture-session")
		const actualCommands = Object.keys(commands).sort();

		const readmeContent = await readFile(readmePath, "utf-8");
		// Match: ### `/lb:command-name` or ### `/command-name`
		const commandHeaderRegex = /^### `\/([a-z][a-z0-9:_-]*)`/gm;
		const documentedCommands: string[] = [];
		let match: RegExpExecArray | null;

		while ((match = commandHeaderRegex.exec(readmeContent)) !== null) {
			documentedCommands.push(match[1]);
		}

		documentedCommands.sort();

		const missingInReadme = actualCommands.filter(
			(cmd) => !documentedCommands.includes(cmd),
		);
		const extraInReadme = documentedCommands.filter(
			(cmd) => !actualCommands.includes(cmd),
		);

		let hasErrors = false;

		if (missingInReadme.length > 0) {
			console.error("Commands in plugin.json but not documented in README.md:");
			for (const cmd of missingInReadme) console.error(`   - /${cmd}`);
			hasErrors = true;
		}

		if (extraInReadme.length > 0) {
			console.error("Commands documented in README.md but not in plugin.json:");
			for (const cmd of extraInReadme) console.error(`   - /${cmd}`);
			hasErrors = true;
		}

		if (!hasErrors) {
			console.log(`README.md documents all ${actualCommands.length} commands correctly`);
		} else {
			process.exit(1);
		}
	} catch (error) {
		if (error instanceof Error) {
			console.error("Error validating README commands:", error.message);
		}
		process.exit(1);
	}
}

async function main() {
	const versionResult = await validateVersions();
	if (!versionResult.success) {
		console.error("Version synchronization failed!\n");
		console.error(versionResult.mismatchDetails);
		process.exit(1);
	}
	const version = versionResult.versions.find((v) => v.version)?.version;
	console.log(`Versions synchronized: ${version}`);

	await validatePlugin();
	await validateReadmeCommands();
}

main();
