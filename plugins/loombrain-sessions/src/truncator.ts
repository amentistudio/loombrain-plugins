const SUFFIX = "\n... [truncated]";
const DEFAULT_MAX_BYTES = 10 * 1024; // 10KB

const encoder = new TextEncoder();

/**
 * Truncate content to fit within maxBytes UTF-8 limit.
 * If truncation is needed, appends a suffix and ensures
 * multi-byte characters are not split.
 */
export function truncateContent(content: string, maxBytes = DEFAULT_MAX_BYTES): string {
	const bytes = encoder.encode(content);
	if (bytes.length <= maxBytes) return content;

	const suffixBytes = encoder.encode(SUFFIX).length;
	const bodyBudget = maxBytes - suffixBytes;

	// Walk backwards from bodyBudget to find a valid UTF-8 boundary.
	// UTF-8 continuation bytes start with 0b10xxxxxx (0x80..0xBF).
	let cut = bodyBudget;
	while (cut > 0 && bytes[cut] >= 0x80 && bytes[cut] < 0xc0) {
		cut--;
	}

	const truncated = new TextDecoder().decode(bytes.slice(0, cut));
	return truncated + SUFFIX;
}
