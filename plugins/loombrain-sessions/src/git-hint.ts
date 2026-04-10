/**
 * Parse a git remote URL to extract the repository name.
 * Handles HTTPS and SSH formats, strips .git suffix.
 */
export function parseGitRemoteUrl(url: string): string | null {
	const trimmed = url.trim();
	if (!trimmed) return null;

	// SSH format: git@github.com:owner/repo.git
	const sshMatch = trimmed.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
	if (sshMatch) {
		return sshMatch[1].split("/").pop() ?? null;
	}

	// HTTPS format: https://github.com/owner/repo.git
	try {
		// Remove trailing slash and .git suffix
		let clean = trimmed.replace(/\/+$/, "").replace(/\.git$/, "");
		const parts = clean.split("/");
		const last = parts.pop();
		return last || null;
	} catch {
		return null;
	}
}

/**
 * Get the project hint from the git remote URL of the given directory.
 * Returns null if not a git repo or no remote configured.
 */
export async function getProjectHint(cwd: string): Promise<string | null> {
	try {
		const proc = Bun.spawn(["git", "-C", cwd, "remote", "get-url", "origin"], {
			stdout: "pipe",
			stderr: "ignore",
		});
		const output = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) return null;
		return parseGitRemoteUrl(output.trim());
	} catch {
		return null;
	}
}
