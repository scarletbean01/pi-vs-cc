// Shared per-agent model resolution utilities.
// Used by agent-team.ts, agent-chain.ts, and pi-pi.ts.

// Short aliases → full provider/id strings expected by `pi --model`.
export const MODEL_ALIASES: Record<string, string> = {
	"opus":       "anthropic/claude-opus-4-20250514",
	"opus-4":     "anthropic/claude-opus-4-20250514",
	"sonnet":     "anthropic/claude-sonnet-4-20250514",
	"sonnet-4":   "anthropic/claude-sonnet-4-20250514",
	"haiku":      "anthropic/claude-3-5-haiku-20241022",
	"flash":      "openrouter/google/gemini-3-flash-preview",
	"gemini":     "openrouter/google/gemini-3-flash-preview",
	"gemini-3":   "openrouter/google/gemini-3-flash-preview",
	"gpt-4.1":    "openai/gpt-4.1",
	"gpt-5":      "openai/gpt-5",
};

// Resolve a model string for an agent.
// Precedence: agent's declared model (alias or full) → parent ctx.model → hardcoded fallback.
export function resolveModel(
	raw: string | undefined,
	ctxModel: { provider: string; id: string } | undefined,
): string {
	// If the agent declared a model frontmatter value, prefer it.
	if (raw) {
		// Full provider/id strings are passed through as-is.
		if (raw.includes("/")) return raw;
		// Alias lookup (case-insensitive).
		const aliased = MODEL_ALIASES[raw.toLowerCase()];
		if (aliased) return aliased;
		// Unknown alias — warn and fall through to ctx.model / default.
		console.warn(`[model-utils] unknown model alias "${raw}", falling back to inherited or default`);
	}
	// Inherit from the parent Pi session.
	if (ctxModel) return `${ctxModel.provider}/${ctxModel.id}`;
	// Hardcoded fallback (matches the original default across all extensions).
	return "openrouter/google/gemini-3-flash-preview";
}