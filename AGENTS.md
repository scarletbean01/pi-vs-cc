# Pi vs CC — Extension Playground

Pi Coding Agent extension examples and experiments.

## Tooling
- **Package manager**: `bun` (not npm/yarn/pnpm)
- **Task runner**: `just` (see justfile)
- **Extensions run via**: `pi -e extensions/<name>.ts`

## Project Structure
- `extensions/` — Pi extension source files (.ts)
- `specs/` — Feature specifications
- `docs/` — Feature documentation (e.g. per-agent-model-assignment.md)
- `.pi/agents/` — Agent definitions for agent-team, agent-chain, and pi-pi extensions
- `.pi/agent-sessions/` — Ephemeral session files (gitignored)

## Conventions
- Extensions are standalone .ts files loaded by Pi's jiti runtime
- Available imports: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, `@sinclair/typebox`, plus any deps in package.json
- Register tools at the top level of the extension function (not inside event handlers)
- Use `isToolCallEventType()` for type-safe tool_call event narrowing

## Per-Agent Model Assignment
- Agent definition files (`.pi/agents/*.md`) support a `model:` frontmatter field
- Values can be short aliases (`opus`, `sonnet`, `haiku`, `flash`, `gemini`, `gpt-4.1`, `gpt-5`) or full `provider/id` strings (e.g. `anthropic/claude-sonnet-4-20250514`)
- Resolution is handled by `resolveModel()` in `extensions/model-utils.ts` with precedence: agent-declared → parent `ctx.model` → hardcoded fallback
- Used by `agent-team.ts`, `agent-chain.ts`, and `pi-pi.ts` — import `resolveModel` from `./model-utils.ts` when adding model support to new extensions
- Full spec: `docs/per-agent-model-assignment.md`
