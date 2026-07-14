# Herdr-Native Agent Bootstrap

## Overview

The herdr-native agent bootstrap is an orchestration feature that lets a
single **dispatcher** agent spin up other agents as real panes inside a
running [herdr](https://github.com/yuk1ty/herdr) multiplexer session, hand
each agent a focused sub-task, coordinate the work between them over the
coms messaging extension, and aggregate their structured results back
into a single report. Instead of spawning child `pi` processes and
polling their stdout, the dispatcher generates a herdr-spreader YAML
layout, applies it, and every agent comes to life in its own visible
herdr pane — so you can literally watch the team work in parallel. Two
topologies are supported: **chain** (sequential pipeline, each step
receives the previous step's output via coms) and **team** (parallel
specialists that each report back to the dispatcher).

---

## Architecture

```
┌─────────────────────────────────────────────┐
│               Herdr Multiplexer               │
│  ┌─────────────────────────────────────────┐ │
│  │          Primary Pane (Dispatcher)        │ │
│  │  pi -e bootstrap.ts --agent dispatcher   │ │
│  │  Uses: herdr CLI, coms, bootstrap tools  │ │
│  └──────────────┬──────────────────────────┘ │
│                 │ coms + herdr status          │
│  ┌──────────────┼──────────────────────────┐ │
│  │   New Workspace (agents)                 │ │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐    │ │
│  │  │ Agent A  │ │ Agent B  │ │ Agent C  │   │ │
│  │  │coms+sys │ │coms+sys │ │coms+sys │    │ │
│  │  └─────────┘ └─────────┘ └─────────┘    │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

- The dispatcher lives in your **primary herdr pane**. It runs `pi` with
  the `bootstrap.ts` extension and the `dispatcher` persona, so it gets
  the three `bootstrap_*` tools plus the herdr CLI plus coms.
- Each booted agent runs in a **new herdr workspace** created by
  herdr-spreader, one pane per agent. Every agent pane runs `pi` with the
  coms extension, the system-select extension, and the agent's own
  persona (plus any per-agent extras declared via the `extensions:`
  frontmatter field).
- Coordination flows over **coms** (`coms_send` / `coms_await` /
  `coms_get`), and the dispatcher cross-references coms state with
  `herdr pane list` to detect completion.

---

## Prerequisites

1. **herdr installed and running.** The dispatcher invokes `herdr …`
   subcommands and `herdr-spreader apply` is run inside the live session.
   Confirm with `herdr --version`, and make sure you're launching pi from
   inside herdr (`HERDR_ENV=1` is set in the herdr shell).
2. **herdr-spreader plugin.** Install it once per machine:
   ```sh
   herdr plugin install yuk1ty/herdr-spreader
   ```
   A standalone `herdr-spreader` binary on `PATH` is also detected
   automatically and preferred over the plugin when present.
3. **coms extension in the project.** `extensions/coms.ts` ships in this
   repo and is loaded automatically by every booted agent — no extra
   setup required. (Agents also pull in `extensions/system-select.ts`
   unconditionally; that ships in the repo too.)
4. **Agent persona files.** At least one `.md` file under `agents/`,
   `.claude/agents/`, or `.pi/agents/` per agent you intend to boot. The
   `dispatcher` persona is required for the primary pane.

---

## Installation

There is nothing to install beyond the prerequisites above — the
bootstrap feature is a single extension loaded on demand:

- **Bootstrap extension** — auto-loaded when you run pi with it:
  ```sh
  pi -e extensions/bootstrap.ts --agent dispatcher
  ```
  Run this from your primary herdr pane. It registers three tools
  (`bootstrap_generate`, `bootstrap_report`, `bootstrap_cleanup`) and
  the `/boot` slash command.
- **Bootstrap skill** — the dispatcher persona references a step-by-step
  protocol at `.agents/skills/bootstrap/SKILL.md`. The persona will follow
  this skill when orchestrating a run.
- **Dispatcher persona** — `.pi/agents/dispatcher.md` defines the
  orchestrator's role, tools, and constraints. Edit it to tune the
  dispatcher's behavior.

---

## Usage

All boot actions flow through the dispatcher agent. From the primary
herdr pane (the one running `pi -e extensions/bootstrap.ts --agent
dispatcher`), you can either let the dispatcher drive, or fire a slash
command to hint the mode:

- **`boot chain <task>`** — bootstrap a sequential pipeline. The
  dispatcher decomposes `<task>` into ordered steps, assigns one agent
  per step, and wires each step to `coms_await` its predecessor and
  `coms_send` to its successor.
- **`boot team <task>`** — bootstrap parallel specialists. The
  dispatcher picks a set of agents that each work independently and
  `coms_send` their results back to the dispatcher.
- **`boot auto <task>`** — let the dispatcher decide topology (chain vs.
  team) based on whether sub-tasks have a data dependency.
- **`boot cleanup <workspace-id>`** — close the herdr workspace and
  remove the `.pi/agent-sessions/<task-id>/` session directory for a
  finished run.

> The `/boot` slash command is a convenience launcher: it prints help when
> invoked bare, and hints the dispatcher when given a mode. The actual
> orchestration is performed by the dispatcher agent calling the
> `bootstrap_*` tools.

### Workflow at a glance

1. You describe a task to the dispatcher.
2. The dispatcher decomposes it, picks agents, and calls
   `bootstrap_generate` with the chosen topology.
3. `bootstrap_generate` writes per-agent append-system-prompt files,
   emits a herdr-spreader YAML layout, invokes `apply`, and returns a
   pane manifest.
4. Each agent pane boots `pi` with coms + system-select + its persona.
   Chain agents block on `coms_await`; team agents work immediately.
5. Agents `coms_send` a structured JSON result to the dispatcher.
6. The dispatcher collects results via `coms_get` / `coms_await`,
   cross-checks with `herdr pane list`, and calls `bootstrap_report`.
7. Results land in `.pi/agent-sessions/<task-id>/report.json` (and
   optionally `report.md`). Run `boot cleanup <workspace-id>` to tear it
   all down.

---

## Example: Boot a Chain

Task: **"Audit security → Fix issues → Verify with tests."**

```
you @ dispatcher> boot chain Audit our auth flow, fix any issues found, then verify with tests.

dispatcher: decomposing into a 3-step chain…
  step 1 → reviewer        "Audit the auth flow for security issues"
  step 2 → builder         "Fix every issue reported by step 1"
  step 3 → reviewer        "Re-run the test suite; confirm all pass"

dispatcher: calling bootstrap_generate(topology=chain, agents=[...]).
bootstrap_generate: wrote .pi/agent-sessions/audit-auth-flow-k3f2a1/layout.yaml
bootstrap_generate: detected herdr-spreader (plugin)
bootstrap_generate: applied layout — 3 panes spawned in workspace "audit-auth-flow-k3f2a1"
bootstrap_generate: pane manifest:
  - reviewer   pane=3   coms=reviewer
  - builder    pane=4   coms=builder
  - reviewer2  pane=5   coms=reviewer2
```

What happens inside the workspace:

- All three panes start simultaneously. Each chain agent's
  append-system-prompt has been pre-filled with its step number,
  predecessor/successor coms names, and the shared
  `dispatcher_coms_name`.
- **Pane 3 (reviewer)** has no predecessor, so it begins auditing
  immediately and `coms_send`s its findings JSON to `builder`.
- **Pane 4 (builder)** starts blocked on `coms_await(sender="reviewer")`.
  On receipt it applies the fixes and `coms_send`s its results to
  `reviewer2`.
- **Pane 5 (reviewer2)** awaits `builder`, runs the test suite, and
  `coms_send`s its verdict to `dispatcher`.
- The dispatcher polls `coms_get` for messages addressed to
  `dispatcher` and watches `herdr pane list` until all panes report
  done. If a predecessor fails or times out, downstream agents print
  **"Chain aborted — predecessor did not deliver input in time."** and
  exit, which the dispatcher surfaces back to you.
- Once all results are in, the dispatcher calls `bootstrap_report`,
  producing:
  ```
  .pi/agent-sessions/audit-auth-flow-k3f2a1/report.json
  .pi/agent-sessions/audit-auth-flow-k3f2a1/report.md   (if requested)
  ```

You can then run `boot cleanup audit-auth-flow-k3f2a1` to close the
workspace and delete the session directory.

---

## Example: Boot a Team

Task: **"Write docs, audit security, add tests"** — independent work, no
data dependency, so the dispatcher picks a team.

```
you @ dispatcher> boot team Write API docs, audit security, and add integration tests.

dispatcher: no data dependency between sub-tasks → team topology.
  agent 1 → documenter   "Write API docs for the new endpoints"
  agent 2 → red-team     "Audit security of the new endpoints"
  agent 3 → builder      "Add integration tests covering the new endpoints"

dispatcher: calling bootstrap_generate(topology=team, agents=[...]).
bootstrap_generate: applied layout — 3 panes spawned in workspace "docs-sec-tests-b7c9d2"
```

- All three panes start at once. Each agent's append-system-prompt says
  it is a **TEAM** member with no predecessor; each works independently.
- When an agent finishes, it `coms_send`s its structured JSON result
  directly to `dispatcher`.
- The dispatcher also falls back to `herdr pane read` for any agent that
  reports done but never sent a coms message (see Troubleshooting).
- On completion, `bootstrap_report` rolls up a single report.json with
  one entry per agent:
  ```json
  [
    { "agent_name": "documenter", "status": "success",
      "summary": "Documented 4 endpoints", "metrics": { "files_changed": 2 } },
    { "agent_name": "red-team",   "status": "partial",
      "summary": "Found 1 high + 2 low issues", "metrics": { "issues_found": 3 } },
    { "agent_name": "builder",    "status": "success",
      "summary": "Added 7 integration tests", "metrics": { "tests_run": 7, "tests_passed": 7 } }
  ]
  ```

---

## Configuration

### `PI_COMS_TIMEOUT_MS`

The coms await timeout used by chain agents waiting on their predecessor.
Defaults to **`300000`** (5 minutes). The spreader YAML layout sets this
on the agents workspace env, so every booted chain agent inherits it.

Override it before launching the dispatcher, or set it per workspace in
your shell:

```sh
PI_COMS_TIMEOUT_MS=600000 pi -e extensions/bootstrap.ts --agent dispatcher
```

| Env var              | Default | Meaning                                             |
| -------------------- | ------- | --------------------------------------------------- |
| `PI_COMS_TIMEOUT_MS` | `300000`| Coms await timeout (ms) for chain agents awaiting a predecessor. |

### Agent frontmatter fields

Agent `.md` files support a few bootstrap-relevant frontmatter fields on
top of the standard `name` / `description` / `tools` / `model` set
documented in `docs/per-agent-model-assignment.md`:

| Field         | Format            | Effect                                                                 |
| ------------- | ----------------- | ---------------------------------------------------------------------- |
| `model`       | alias or `provider/id` | Resolved via `resolveModel()` and passed to the booted `pi`.     |
| `extensions`  | CSV of basenames  | Extra `-e extensions/<name>.ts` flags appended to that agent's `pi` command. Missing extensions are skipped with a warning. |
| `color`       | hex color string  | Echoed into the agent's append-system-prompt as a coms identity color. |

Example persona:

```yaml
---
name: red-team
description: Adversarial security review
tools: read,grep,find,ls
model: opus
color: "#e0504a"
extensions: bowser
---
You are a red-team agent…
```

This agent would boot as `pi -e extensions/coms.ts -e extensions/system-select.ts -e extensions/bowser.ts --agent red-team --cname red-team --purpose "…" --append-system-prompt … --project <slug>` on the resolved `opus` model.

---

## Troubleshooting

### "herdr-spreader not found"

`bootstrap_generate` could not detect either a standalone
`herdr-spreader` binary or the `herdr-spreader` plugin. Install the
plugin:

```sh
herdr plugin install yuk1ty/herdr-spreader
```

Then verify with `herdr plugin list` (it should list `spreader`), and
re-run. If you have a standalone binary, ensure it's on `PATH` as
`herdr-spreader`.

### "Agent timeout in chain"

A chain agent's `coms_await` on its predecessor hit `PI_COMS_TIMEOUT_MS`
before any message arrived. This almost always means the **predecessor
failed** — open its herdr pane and read the output:

```sh
herdr pane read <predecessor-pane-id>
```

Common causes: the predecessor crashed, returned a `status: "failure"`
result without sending it, or the predecessor itself aborted because
*its* predecessor didn't deliver. Chase the failure toward the head of
the chain.

### "Chain aborted — predecessor did not deliver input in time."

This is the message a chain agent prints when it gives up waiting on its
predecessor after the coms timeout. It is the user-visible symptom of the
**Agent timeout in chain** case above — check the predecessor's pane for
the real error.

### "No coms message but agent done"

The dispatcher sees the agent's pane as finished (`herdr pane list`) but
no message ever arrived over coms. This can happen if the agent exited
abnormally or sent malformed output. The dispatcher falls back to reading
the pane directly:

```sh
herdr pane read <agent-pane-id>
```

and treats the pane output as the agent's result. If you see this
frequently, double-check that the agent's persona actually instructs it
to `coms_send` results to `dispatcher` — the bootstrap-generated
append-system-prompt does this, but a persona that overrides the
protocol could suppress the send.

---

## How It Works

This is a brief technical walkthrough of what `extensions/bootstrap.ts`
does on your behalf. You don't need to read this to use the feature, but
it's handy when debugging or extending.

1. **Tool registration.** On extension load, `bootstrap.ts` registers
   `bootstrap_generate`, `bootstrap_report`, and `bootstrap_cleanup`, plus
   the `/boot` slash command. It wires a `session_start` handler that
   applies theme defaults.
2. **`bootstrap_generate`.** Given a topology (`chain` or `team`), a
   task description, and a list of requested agents (each with a sub-task,
   and for chains a `step` / `predecessor` / `successor`), it:
   - Generates a stable `task-id` (slug + short base-36 timestamp) and
     ensures `.pi/agent-sessions/<task-id>/` exists.
   - Scans `agents/`, `.claude/agents/`, `.pi/agents/` for persona files
     (deduped, case-insensitive) and maps each requested agent to its
     `AgentDef` (carrying `model`, `extensions`, `color`).
   - Writes one `<agent>_append.md` per agent, filling in the chain or
     team template (task, step/total, predecessor/successor, dispatcher
     coms name, timeout, and a strict JSON result schema).
   - Builds each agent's `pi` command: `coms.ts` + `system-select.ts` +
     per-agent `extensions:`, plus `--agent`, `--cname`, `--purpose`,
     `--append-system-prompt`, and a shared `--project` (repo basename)
     so all panes share one coms namespace.
   - Emits a herdr-spreader YAML layout — one workspace, one tab, N
     panes split down at `0.5` ratio, with `PI_COMS_TIMEOUT_MS` on the
     workspace env — and writes it to `<session-dir>/layout.yaml`.
   - Detects herdr-spreader (binary on `PATH` preferred, else plugin)
     and runs `apply`. On failure, returns the YAML path and a clear
     install-instructions error.
   - Calls `herdr pane list --format json` to map each agent's
     `--cname` back to a real pane id, and returns the pane manifest +
     `dispatcher_coms_name` to the dispatcher.
3. **Agent panes.** Each booted pane runs `pi` with coms and
   system-select unconditionally, plus the agent persona and any
   frontmatter-declared extensions. Model is resolved via
   `resolveModel()` (agent-declared → parent `ctx.model` → fallback).
   - **Chain:** every pane starts at once, but each non-first pane
     `coms_await`s its predecessor before doing real work. On
     completion it `coms_send`s its JSON result to its successor (or
     to `dispatcher` if it's the last step). If the await times out the
     agent exits with the abort message.
   - **Team:** every pane starts at once and works independently,
     `coms_send`ing its result to `dispatcher` when done.
4. **Dispatcher monitoring.** The dispatcher cross-references
   `coms_get` (messages addressed to `dispatcher`) against
   `herdr pane list` (pane done status) to know when every agent has
   finished. For team agents it can fall back to `herdr pane read` when
   a pane reports done but no coms message arrived.
5. **`bootstrap_report`.** Once results are collected, the dispatcher
   calls this to persist the array of structured results to
   `.pi/agent-sessions/<task-id>/report.json` (always). When asked, it
   also renders a rollup `report.md` with per-agent sections and a
   final success/partial/failure + warnings tally.
6. **`bootstrap_cleanup`.** `herdr workspace close <workspace-id>`
   followed by `rm -rf .pi/agent-sessions/<task-id>/`. Returns clean
   status/error diagnostics for each step so you can tell which half
   failed.

Relevant source:
`extensions/bootstrap.ts`, `extensions/bootstrap-utils.ts`,
`extensions/model-utils.ts`, `extensions/themeMap.ts`,
`.pi/agents/dispatcher.md`, `.agents/skills/bootstrap/SKILL.md`.