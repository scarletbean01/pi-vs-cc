# Per-Agent Model Assignment

## Overview

The `agent-team.ts` extension spawns each specialist agent as a child `pi`
process. Today, **every** child process inherits the model from the parent
Pi session (`ctx.model`) or falls back to a single hardcoded default
(`openrouter/google/gemini-3-flash-preview`). There is no way to run a
heavyweight "planner" on Claude Opus while keeping a lightweight "scout"
on Gemini Flash.

This document specifies the changes required to let each agent declare its
own model in its `.md` frontmatter (e.g. `model: opus` or
`model: anthropic/claude-sonnet-4-20250514`) and have the extension honor
that declaration.

The same model-inheritance pattern is duplicated across four extensions —
`agent-team.ts`, `agent-chain.ts`, `pi-pi.ts`, and `subagent-widget.ts` —
so the fix is described once for `agent-team.ts` and then ported to the
others.

---

## Current Architecture

### AgentDef interface

`extensions/agent-team.ts` lines 30–36:

```ts
interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
	file: string;
}
```

No `model` field exists.

### parseAgentFile()

`extensions/agent-team.ts` (around lines 79–102). The frontmatter parser builds a
generic `Record<string, string>` but only surfaces a fixed whitelist of
keys into the returned `AgentDef`:

```ts
function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
		if (!match) return null;

		const frontmatter: Record<string, string> = {};
		for (const line of match[1].split("\n")) {
			const idx = line.indexOf(":");
			if (idx > 0) {
				frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
			}
		}

		if (!frontmatter.name) return null;

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			systemPrompt: match[2].trim(),
			file: filePath,
		};
	} catch {
		return null;
	}
}
```

Any frontmatter key that isn't `name`, `description`, or `tools` is
silently discarded. This is why `.pi/agents/bowser.md`'s `model: opus`
line has no effect today.

### Model resolution in dispatchAgent()

`extensions/agent-team.ts` (around lines 338–351). The model string is computed
once, unconditionally from the parent context:

```ts
const model = ctx.model
    ? `${ctx.model.provider}/${ctx.model.id}`
    : "openrouter/google/gemini-3-flash-preview";

const args = [
    "--mode", "json",
    "-p",
    "--no-extensions",
    "--model", model,
    "--tools", state.def.tools,
    "--thinking", "off",
    "--append-system-prompt", state.def.systemPrompt,
    "--session", agentSessionFile,
];
```

The agent definition (`state.def`) is never consulted for the model.

### Agent .md files

Agents are markdown files with YAML frontmatter in `agents/`,
`.claude/agents/`, or `.pi/agents/`. The parser only understands scalar
`key: value` lines (no nested YAML, no lists). Example:

```yaml
---
name: scout
description: Fast recon and codebase exploration
tools: read,grep,find,ls
---
You are a scout agent...
```

`.pi/agents/bowser.md` already attempts to declare a per-agent model:

```yaml
---
name: bowser
description: Headless browser automation agent using Playwright CLI...
model: opus
color: orange
skills:
  - playwright-bowser
---
```

The `model: opus` line is a **shorthand alias**, not a full
`provider/id` string. It is currently ignored.

### Teams configuration

`.pi/agents/teams.yaml` defines named rosters of agents:

```yaml
full:
  - scout
  - planner
  - builder
  - reviewer
  - documenter
  - red-team
plan-build:
  - planner
  - builder
  - reviewer
info:
  - scout
  - documenter
  - reviewer
frontend:
  - planner
  - builder
  - bowser
pi-pi:
  - ext-expert
  - theme-expert
  - skill-expert
  - config-expert
  - tui-expert
  - prompt-expert
  - agent-expert
```

There is no team-level model override.

### Same pattern in sibling extensions

Four extensions spawn child `pi` processes with the identical
model-inheritance block:

| Extension | Location |
| --- | --- |
| `extensions/agent-team.ts` | lines 338–340 |
| `extensions/agent-chain.ts` | lines 337–349 |
| `extensions/pi-pi.ts` | lines 275–284 |
| `extensions/subagent-widget.ts` | lines 137–147 |

All use:

```ts
const model = ctx.model
    ? `${ctx.model.provider}/${ctx.model.id}`
    : "openrouter/google/gemini-3-flash-preview";
```

### Model string format

The `pi --model` flag expects `provider/id` form, e.g.
`openrouter/google/gemini-3-flash-preview` or
`anthropic/claude-sonnet-4-20250514`.

---

## Problem Statement

1. **No per-agent model control.** A team mixing a cheap scout with an
   expensive planner cannot route them to different models; both use
   whatever the parent session is running.
2. **Frontmatter `model` is silently dropped.** `bowser.md` declares
   `model: opus` but the parser whitelist discards it, so authors get no
   feedback that their declaration is unsupported.
3. **Shorthand aliases are unresolved.** Even if `model` were surfaced,
   `opus` is not a valid `provider/id` and would be rejected by `pi`.
4. **No visibility.** Neither the dispatcher's system-prompt catalog nor
   the dashboard widget shows which model an agent will run on, so the
   orchestrator cannot make informed routing decisions.
5. **Fix is duplicated four places.** Any per-agent model logic must be
   applied consistently across `agent-team.ts`, `agent-chain.ts`,
   `pi-pi.ts`, and `subagent-widget.ts`.

---

## Implementation Guide

### Step 1 — Extend the `AgentDef` interface

Add an optional `model` field. Optional because most agents will continue
to inherit the parent's model.

```ts
interface AgentDef {
	name: string;
	description: string;
	tools: string;
	systemPrompt: string;
	file: string;
	model?: string;   // raw frontmatter value: alias or provider/id
}
```

### Step 2 — Surface `model` from `parseAgentFile()`

Add one line to the returned object. Because `model` is optional, only
set it when the frontmatter actually contains it (so `undefined` is the
sentinel for "inherit parent").

```ts
return {
	name: frontmatter.name,
	description: frontmatter.description || "",
	tools: frontmatter.tools || "read,grep,find,ls",
	systemPrompt: match[2].trim(),
	file: filePath,
	model: frontmatter.model || undefined,
};
```

### Step 3 — Add model resolution logic in `dispatchAgent()`

Replace the unconditional inheritance with a precedence chain:

1. **Agent-declared model** (`state.def.model`) — highest priority.
2. **Parent session model** (`ctx.model`).
3. **Hardcoded fallback** (`openrouter/google/gemini-3-flash-preview`).

Introduce a `resolveModel()` helper so the same precedence logic can be
reused by the sibling extensions (Step 7). The helper takes the raw
frontmatter value and resolves aliases (Step 4):

```ts
// ── Model Alias Resolution ──────────────────────

const MODEL_ALIASES: Record<string, string> = {
	"opus":      "anthropic/claude-opus-4-20250514",
	"opus-4":    "anthropic/claude-opus-4-20250514",
	"sonnet":    "anthropic/claude-sonnet-4-20250514",
	"sonnet-4":  "anthropic/claude-sonnet-4-20250514",
	"haiku":     "anthropic/claude-3-5-haiku-20241022",
	"flash":     "openrouter/google/gemini-3-flash-preview",
	"gemini":    "openrouter/google/gemini-3-flash-preview",
	"gpt-4.1":   "openai/gpt-4.1",
	"gpt-5":     "openai/gpt-5",
};

function resolveModel(
	raw: string | undefined,
	ctxModel: { provider: string; id: string } | undefined,
): string {
	if (raw) {
		// Full provider/id string passes through unchanged.
		if (raw.includes("/")) return raw;
		// Otherwise treat as an alias (case-insensitive).
		const aliased = MODEL_ALIASES[raw.toLowerCase()];
		if (aliased) return aliased;
		// Unknown alias: fall through to ctx/fallback rather than crash.
		console.warn(`[agent-team] unknown model alias "${raw}", falling back`);
	}
	if (ctxModel) return `${ctxModel.provider}/${ctxModel.id}`;
	return "openrouter/google/gemini-3-flash-preview";
}
```

Then in `dispatchAgent()`, replace the existing `const model = ...` block:

```ts
// Before
const model = ctx.model
    ? `${ctx.model.provider}/${ctx.model.id}`
    : "openrouter/google/gemini-3-flash-preview";

// After
const model = resolveModel(state.def.model, ctx.model);
```

Leave the rest of the `args` array untouched; it already uses `model`.

### Step 4 — Model alias resolution

Two mechanisms, used in tiered order:

1. **Built-in `MODEL_ALIASES` map** (shown in Step 3). Ships sensible
   defaults for the common shorthand names already in use (`opus`, etc.).
   WARN rather than throw on unknown aliases so a typo never bricks the
   whole team.

2. **Optional: read Pi's known models config.** If a project wants to
   register custom aliases without editing the extension, expose them via
   a config block. A minimal approach is to read `.pi/agents/models.yaml`
   (or a `modelAliases` key in `teams.yaml`) and merge it over
   `MODEL_ALIASES` at boot:

   ```yaml
   # .pi/agents/models.yaml
   aliases:
     deepseek: deepseek/deepseek-chat
     local: ollama/llama3.1:8b
   ```

   ```ts
   function loadModelAliases(cwd: string): Record<string, string> {
	   const path = join(cwd, ".pi", "agents", "models.yaml");
	   if (!existsSync(path)) return {};
	   const aliases: Record<string, string> = {};
	   for (const line of readFileSync(path, "utf-8").split("\n")) {
		   const m = line.match(/^\s*(\S+):\s*(\S+)$/);
		   if (m) aliases[m[1].toLowerCase()] = m[2];
	   }
	   return aliases;
   }
   // At boot: const aliases = { ...MODEL_ALIASES, ...loadModelAliases(cwd) };
   ```

   This is an enhancement — the static map is sufficient for the core
   feature. Treat `.pi/agents/models.yaml` support as future work unless
   a project immediately needs custom aliases.

**Resolution rules** (important for the dispatcher to document):

| Frontmatter value | Resolves to |
| --- | --- |
| `anthropic/claude-opus-4-20250514` | itself (contains `/`) |
| `opus` | `MODEL_ALIASES["opus"]` |
| `Opus` / `OPUS` | matched case-insensitively |
| `some-unknown-alias` | WARN + fall back to parent/fallback |
| *(field omitted)* | inherited from `ctx.model` or fallback |

### Step 5 — Surface each agent's model in the `before_agent_start` catalog

The dispatcher's system prompt is built in the `before_agent_start`
handler (around lines 631–635). The handler signature is
`async (_event, _ctx) => { ... }` — note `_ctx` is underscore-prefixed
(unused today). **First rename `_ctx` → `ctx`** in the handler signature so
the model is in scope, then add a `**Model:**` line to each catalog entry
so the orchestrator knows what it's routing to.

```ts
// Before
pi.on("before_agent_start", async (_event, _ctx) => {
	const agentCatalog = Array.from(agentStates.values())
		.map(s => `### ${displayName(s.def.name)}\n**Dispatch as:** \`${s.def.name}\`\n${s.def.description}\n**Tools:** ${s.def.tools}`)
		.join("\n\n");

// After
pi.on("before_agent_start", async (_event, ctx) => {   // ← rename _ctx → ctx
	const agentCatalog = Array.from(agentStates.values())
		.map(s => {
			const modelLabel = s.def.model
				? resolveModel(s.def.model, ctx.model)
				: (ctx.model
					? `${ctx.model.provider}/${ctx.model.id}`
					: "openrouter/google/gemini-3-flash-preview");
			return `### ${displayName(s.def.name)}\n`
				+ `**Dispatch as:** \`${s.def.name}\`\n`
				+ `${s.def.description}\n`
				+ `**Tools:** ${s.def.tools}\n`
				+ `**Model:** ${modelLabel}`;
		})
		.join("\n\n");
```

If you keep the `_ctx` name, use `_ctx.model` everywhere instead — but
renaming is cleaner since the handler now actually uses the context.

Showing the *resolved* model (not the raw alias) avoids confusing the
dispatcher with shorthand it can't act on. If you want the raw alias
visible for debugging, append `(alias: ${s.def.model})` when
`s.def.model` and the resolved string differ.

### Step 6 — Show the model on each dashboard widget card

`renderCard()` (around lines 206–244) currently draws name, status, a
context bar, and a work line. Add a compact model line between status and
the context bar. **You must also fix the padding constant** in
`updateWidget()`: line 279 pads an incomplete row with
`cards.push(Array(6).fill(" ".repeat(colWidth)));`. Adding a 7th row to
real cards means filler cards now have only 6 lines and misalign the grid.
Bump it to `Array(7)` (or, more robustly, derive it from the real cards:
`Array(cards[0].length).fill(...)`) as part of this change.

```ts
// After computing statusLine/statusVisible, add:

const modelLabel = state.def.model
	? (state.def.model.includes("/")
		? state.def.model.split("/").pop()!   // show just the id half
		: state.def.model)                       // show alias as-is
	: "inherited";
const modelStr = `◆ ${modelLabel}`;
const modelLine = theme.fg("dim", modelStr);
const modelVisible = modelStr.length;
```

Then insert a new `border(...)` row in the returned array:

```ts
return [
	theme.fg("dim", top),
	border(" " + nameStr,   1 + nameVisible),
	border(" " + statusLine, 1 + statusVisible),
	border(" " + modelLine,  1 + modelVisible),   // ← new
	border(" " + ctxLine,    1 + ctxVisible),
	border(" " + workLine,   1 + workVisible),
	theme.fg("dim", bot),
];
```

Display the short form on the card (the alias or the `id` portion of a
`provider/id`) because column width is tight; the full resolved string is
already visible in the system-prompt catalog from Step 5. For inherited
models, `◆ inherited` keeps the card honest.

### Step 7 — Port the same changes to the sibling extensions

**Up front:** none of the three sibling extensions reuse `agent-team.ts`'s
`parseAgentFile`. Each ships its OWN private copy of both a def interface
and a frontmatter parser, so each needs its own Step 1 + Step 2 edit
before the dispatch-site change applies:

- `agent-chain.ts`: its own `AgentDef` (line 45) and its own
  `parseAgentFile` (line 135).
- `pi-pi.ts`: its own `interface ExpertDef` (line 28) and its own
  `parseAgentFile(filePath): ExpertDef` (line 52) that reads
  `.pi/agents/pi-pi/*.md` files. **pi-pi's experts ARE `.md` files, not
  hard-coded personas** — the port is identical to agent-team: add
  `model?: string` to `ExpertDef` and surface `frontmatter.model` in
  pi-pi's `parseAgentFile`.
- `subagent-widget.ts`: has **NO** `parseAgentFile` and **NO** per-agent
  def at all — it spawns a single background agent with hard-coded tools
  (line 148: `"read,bash,grep,find,ls"`). See the dedicated note below.

For the dispatch site (Step 3), swap the inherited-`model` block in each:

- **`extensions/agent-chain.ts`** (lines 337–349): swap
  `const model = ...` for `resolveModel(def.model, ctx.model)`, where
  `def` is the chain's own `AgentDef` (now carrying the new `model?`
  field after the Step 1+2 edit).
- **`extensions/pi-pi.ts`** (lines 275–284): same swap against its
  `ExpertDef`.
- **`extensions/subagent-widget.ts`** (lines 137–147): see below.

**`subagent-widget.ts` — no per-agent concept.** This extension does not
have multiple agents or agent files; `spawnAgent` always launches one
shared background pi process. To honor a per-spawn model there you would
need to:

1. Add an optional `--model` flag/UI input to the `/sub` and `/subcont`
   commands (and to the `spawnAgent` call site, e.g. the `args.task`/
   `args.prompt` argument objects consumed at lines 241, 274, 356, 404).
2. Thread that string through to `spawnAgent`'s args array, resolving
   aliases via the shared `resolveModel()`.

Alternatively, **scope the per-agent-model feature to `agent-team`,
`agent-chain`, and `pi-pi` only** and leave `subagent-widget` on the
inherited model. Pick one explicitly; do not leave it ambiguous.

Recommendation: extract `resolveModel()` and `MODEL_ALIASES` into a
shared module (e.g. `extensions/model-utils.ts`) and import from all
extensions that implement the feature so alias maintenance happens in
one place.

```ts
// extensions/model-utils.ts
export const MODEL_ALIASES: Record<string, string> = { /* ... */ };
export function resolveModel(
	raw: string | undefined,
	ctxModel: { provider: string; id: string } | undefined,
): string { /* ... */ }
```

### Step 8 — Add optional `model` to `teams.yaml` (optional)

Allow a team-level default model that applies to any member that does
not declare its own. Precedence becomes:

1. Agent frontmatter `model`
2. Team `model` from `teams.yaml`
3. Parent `ctx.model`
4. Hardcoded fallback

Extend `parseTeamsYaml()` (around lines 59–72) to capture an optional `model:`
key at the team level. The current parser builds
`Record<string, string[]>`; change the value type to an object:

```ts
interface TeamDef {
	members: string[];
	model?: string;   // team-level default, also subject to alias resolution
}

function parseTeamsYaml(raw: string): Record<string, TeamDef> {
	const teams: Record<string, TeamDef> = {};
	let current: string | null = null;
	for (const line of raw.split("\n")) {
		const teamMatch = line.match(/^(\S[^:]*):$/);
		if (teamMatch) {
			current = teamMatch[1].trim();
			teams[current] = { members: [] };
			continue;
		}
		// Strip trailing inline `# ...` comments and surrounding whitespace.
		// The hand-rolled parser doesn't strip comments on its own, so the
		// regex must: anything after `model:` up to an optional `#` is the
		// value. Non-greedy capture ignores a trailing comment.
		const modelMatch = line.match(/^\s+model:\s*(.+?)(?:\s*#.*)?$/);
		if (modelMatch && current) {
			teams[current].model = modelMatch[1].trim();
			continue;
		}
		const itemMatch = line.match(/^\s+-\s+(.+)$/);
		if (itemMatch && current) {
			teams[current].members.push(itemMatch[1].trim());
		}
	}
	return teams;
}
```

Example `teams.yaml`:

```yaml
full:
  - scout
  - planner
  - builder
  - reviewer
  - documenter
  - red-team
expensive-review:
  model: opus
  - planner
  - reviewer
  - red-team
```

(Inline `# ...` comments are supported by the parser above via the
non-greedy capture plus optional-comment tail, so you may add comments
for readability — e.g. `model: opus # team-wide default` — but the
example here is kept comment-free to match the documented regex behavior
exactly.)

In `dispatchAgent()`, thread the active team's `model` into
`resolveModel()` as a second fallback tier:

```ts
const model = resolveModel(state.def.model ?? activeTeamModel, ctx.model);
```

Or, more explicitly, change `resolveModel()` to accept an ordered list of
candidates:

```ts
function resolveModel(
	candidates: (string | undefined)[],
	ctxModel: { provider: string; id: string } | undefined,
): string {
	for (const c of candidates) {
		if (!c) continue;
		if (c.includes("/")) return c;
		const aliased = MODEL_ALIASES[c.toLowerCase()];
		if (aliased) return aliased;
		console.warn(`[agent-team] unknown model alias "${c}"`);
	}
	if (ctxModel) return `${ctxModel.provider}/${ctxModel.id}`;
	return "openrouter/google/gemini-3-flash-preview";
}

// call site:
const model = resolveModel([state.def.model, activeTeamModel], ctx.model);
```

Update any consumer that currently reads `teams[name]` as a `string[]`
to read `.members` instead (boot-time team select dialog, `/agents-team`,
`/agents-list` output).

---

## Edge Cases and Considerations

- **Unknown aliases.** `resolveModel()` must never throw on a typo — it
  WARN-logs and falls through, so a single bad `model:` line doesn't
  disable the whole team.
- **Case sensitivity.** Match aliases case-insensitively; preserve the
  user's casing in any debug/UI echo.
- **Provider/id passthrough.** Any value containing `/` is treated as
  fully qualified and returned unchanged. This means an alias literally
  named `a/b` cannot exist — acceptable, since real aliases never
  contain slashes.
- **Frontmatter parser limits.** The existing parser only supports
  scalar `key: value` lines. `bowser.md` already uses a YAML list
  (`skills:`) which the current parser mis-handles — that's a pre-existing
  bug, separate from this work. Don't extend the parser to handle lists
  as part of this feature; `model` is scalar and works fine.
- **Resume sessions.** Switching an agent's model between dispatches
  while reusing the same `--session` file is untested territory. Models
  from different providers may produce incompatible session state. If
  this becomes a problem, derive the session filename from the resolved
  model (e.g. `${agentKey}-${sanitizedModel}.json`) so each model gets
  its own session. Out of scope for the initial implementation.
- **Cost/rate-limit awareness.** Letting agents opt into `opus` makes it
  easy to spend fast. Consider surfacing a totals line in the dashboard
  once per-agent models are visible (future enhancement).
- **`color` and `skills` frontmatter keys** in `bowser.md` are *also*
  currently ignored. This document does not add support for them, but
  surfacing `model` proves the pattern: extending `AgentDef` + one line
  in `parseAgentFile()` is the canonical way to add new frontmatter
  fields.
- **No shared `parseAgentFile()`.** Each of `agent-chain.ts` and
  `pi-pi.ts` has its own private `parseAgentFile` and its own def
  interface — there is no import to share. Each must get the Step 1+2
  edit independently. `subagent-widget.ts` has no parser at all (see
  Step 7).

---

## Testing Checklist

- [ ] Agent with `model: opus` runs on `claude-opus-4-*` (verify via
      `pi --version`/`model` reporting in the child session or the
      `event.model` field if emitted).
- [ ] Agent with `model: anthropic/claude-sonnet-4-20250514` runs on
      that exact model (passthrough verified).
- [ ] Agent with no `model:` field inherits the parent `ctx.model`.
- [ ] Agent with `model: nonexistent-alias` logs a warning and falls
      back to the parent/fallback model rather than crashing.
- [ ] Case variants (`Opus`, `OPUS`) all resolve to the same alias.
- [ ] System-prompt catalog (`before_agent_start`) includes a
      `**Model:**` line per agent, showing the *resolved* string.
- [ ] Dashboard widget cards show a model line; inherited models
      display `◆ inherited`.
- [ ] `teams.yaml` with a team-level `model:` overrides inheritance for
      members with no own `model:` (Step 8).
- [ ] Member-declared `model:` beats team-level `model:` (Step 8).
- [ ] `/agents-list` still enumerates team members after the
      `teams.yaml` value-type change (Step 8 — only if implemented).
- [ ] `bowser.md` now actually runs on `opus` (the original motivating
      test case).
- [ ] Repeat the dispatch-model test against `agent-chain.ts` and
      `pi-pi.ts` once Step 7 lands (`subagent-widget` only if its
      `/sub`-command `--model` option was implemented).
- [ ] `teams.yaml` with an inline `# comment` after `model: opus` parses
      to `opus` (comment stripped), per the Step 8 regex.
- [ ] Dashboard `Array(6)` padding constant was bumped to `Array(7)`
      (or derived from `cards[0].length`) so filler cards align with
      the new 7-line real cards.
- [ ] `before_agent_start`'s `_ctx` was renamed to `ctx` (or `_ctx.model`
      is used) — no `ReferenceError: ctx is not defined` at runtime.
- [ ] pi-pi `ExpertDef` carries `model?` and pi-pi's experts run per
      their `.md` `model:` declarations (not the inherited parent model).
- [ ] No regression: an agent with `model:` omitted produces byte-
      identical `pi` args to the pre-change behavior.

---

## Future Enhancements

- **Custom alias config.** `.pi/agents/models.yaml` (or a
  `modelAliases` map inside `teams.yaml`) so projects can register
  aliases without editing the extension.
- **Model-aware routing.** Expose a `cost` or `tier` hint alongside
  `model` so the dispatcher can prefer cheap models for trivial tasks.
- **Session-per-model.** Thread the resolved model into the session
  filename to avoid cross-provider session reuse.
- **Full frontmatter YAML.** Replace the hand-rolled scalar parser with
  a real YAML parser (once a dependency is acceptable) to support
  `skills:` lists and nested config. Until then, every new frontmatter
  field must remain scalar.
- **Dashboard model highlight.** Color-code cards by model tier
  (e.g. red border for `opus`, green for `flash`) to make spend visible
  at a glance.
- **`/agents-model` command.** A slash command to override the active
  team's model at runtime without editing `teams.yaml`.