# Pi vs CC — Extension Playground

Pi Coding Agent extension examples and experiments.

## Tooling
- **Package manager**: `bun` (not npm/yarn/pnpm)
- **Task runner**: `just` (see justfile)
- **Extensions run via**: `pi -e extensions/<name>.ts`

## Project Structure
- `extensions/` — Pi extension source files (.ts); shared utils also live here (`model-utils.ts`, `bootstrap-utils.ts`, `themeMap.ts`)
- `scripts/` — Standalone support scripts (e.g. `coms-net-server.ts`, the HTTP/SSE hub for `coms-net`)
- `specs/` — Feature specifications (implemented and proposed)
- `docs/` — Feature documentation (e.g. per-agent-model-assignment.md, herdr-bootstrap.md)
- `.pi/agents/` — Agent definitions for agent-team, agent-chain, pi-pi, and bootstrap (incl. `teams.yaml`, `agent-chain.yaml`, and the `dispatcher.md` orchestrator persona)
- `.pi/agents/pi-pi/` — Research-expert personas for the pi-pi meta-agent
- `.pi/agent-sessions/` — Ephemeral session files and bootstrap run artifacts (gitignored)
- `.pi/skills/` — Custom agent skills
- `.pi/themes/` — Custom theme JSON used by `theme-cycler`
- `.pi/damage-control-rules.yaml` — Path/command rules enforced by `damage-control`

## Conventions
- Extensions are standalone .ts files loaded by Pi's jiti runtime
- Available imports: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@mariozechner/pi-ai`, `@sinclair/typebox`, plus any deps in package.json
- Register tools at the top level of the extension function (not inside event handlers)
- Use `isToolCallEventType()` for type-safe tool_call event narrowing

## Herdr-Native Agent Bootstrap
- `extensions/bootstrap.ts` (+ `bootstrap-utils.ts`) — dispatcher orchestrator that generates herdr-spreader layouts, spawns agents as live herdr panes, coordinates over `coms`, and aggregates results (`bootstrap_generate`, `bootstrap_report`, `bootstrap_cleanup` tools + `/boot` slash command)
- Run as the `dispatcher` persona inside a running herdr session: `pi -e extensions/bootstrap.ts --agent dispatcher`
- Requires `herdr` + the `herdr-spreader` plugin (or standalone binary) and the `coms` extension
- Supports `chain` (sequential pipeline) and `team` (parallel specialists) topologies via `boot chain|team|auto <task>`
- Agent frontmatter honors `model:` (per-agent), `extensions:` (extra `-e` flags), and `color:` (coms identity)
- Full spec + usage: `docs/herdr-bootstrap.md`

## Per-Agent Model Assignment
- Agent definition files (`.pi/agents/*.md`) support a `model:` frontmatter field
- Values can be short aliases (`opus`, `sonnet`, `haiku`, `flash`, `gemini`, `gpt-4.1`, `gpt-5`) or full `provider/id` strings (e.g. `anthropic/claude-sonnet-4-20250514`)
- Resolution is handled by `resolveModel()` in `extensions/model-utils.ts` with precedence: agent-declared → parent `ctx.model` → hardcoded fallback
- Used by `agent-team.ts`, `agent-chain.ts`, `pi-pi.ts`, and `bootstrap.ts` — import `resolveModel` from `./model-utils.ts` when adding model support to new extensions
- Full spec: `docs/per-agent-model-assignment.md`
