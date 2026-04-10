#!/usr/bin/env bun
import { readFile, writeFile } from "fs/promises";
import { join } from "path";

type BumpType = "major" | "minor" | "patch";

function bumpVersion(current: string, type: BumpType): string {
	const [major, minor, patch] = current.split(".").map(Number);
	switch (type) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
	}
}

function formatDate(): string {
	return new Date().toISOString().split("T")[0];
}

async function release(type: BumpType) {
	const cwd = process.cwd();

	const pkgPath = join(cwd, "package.json");
	const pkgContent = await readFile(pkgPath, "utf-8");
	const pkg = JSON.parse(pkgContent);
	const currentVersion = pkg.version;
	const newVersion = bumpVersion(currentVersion, type);

	console.log(`Bumping version: ${currentVersion} -> ${newVersion}\n`);

	pkg.version = newVersion;
	await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
	console.log("Updated package.json");

	const pluginPath = join(cwd, ".claude-plugin/plugin.json");
	const pluginContent = await readFile(pluginPath, "utf-8");
	const plugin = JSON.parse(pluginContent);
	plugin.version = newVersion;
	await writeFile(pluginPath, `${JSON.stringify(plugin, null, 2)}\n`);
	console.log("Updated .claude-plugin/plugin.json");

	const changelogPath = join(cwd, "CHANGELOG.md");
	let changelog = await readFile(changelogPath, "utf-8");
	const newEntry = `## [${newVersion}] - ${formatDate()}\n\n### Changed\n- TODO: Add changes\n\n`;
	const firstVersionMatch = changelog.match(/^## \[\d+\.\d+\.\d+\]/m);
	if (firstVersionMatch?.index !== undefined) {
		changelog =
			changelog.slice(0, firstVersionMatch.index) +
			newEntry +
			changelog.slice(firstVersionMatch.index);
	} else {
		const headerEnd = changelog.indexOf("\n\n") + 2;
		changelog = changelog.slice(0, headerEnd) + newEntry + changelog.slice(headerEnd);
	}
	await writeFile(changelogPath, changelog);
	console.log("Updated CHANGELOG.md");

	console.log(`\nVersion ${newVersion} prepared\n`);
	console.log("Next steps:");
	console.log(`  1. Edit CHANGELOG.md to add actual changes`);
	console.log(`  2. git add -A && git commit -m "chore: release v${newVersion}"`);
	console.log(`  3. git tag v${newVersion}`);
	console.log("  4. git push && git push --tags");
}

const type = process.argv[2] as BumpType;
if (!["major", "minor", "patch"].includes(type)) {
	console.error("Usage: bun run scripts/release.ts <major|minor|patch>");
	process.exit(1);
}

release(type);
