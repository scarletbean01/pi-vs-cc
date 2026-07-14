---
name: bootstrap
description: "Herdr-native agent bootstrap. When the user says 'boot chain/team/auto <task>', compose agents into a herdr workspace, coordinate via coms, and aggregate results. Requires HERDR_ENV=1 and herdr-spreader."
---

# bootstrap — herdr-native agent orchestration skill

## guard

before using this skill, check that `HERDR_ENV=1`. if it is not set to `1`, say you are not running inside a herdr-managed pane and stop. do not attempt bootstrap operations outside herdr.

this skill requires the `herdr-spreader` plugin (or standalone binary). if `bootstrap_generate` returns a "not found" error, tell the user: "Install herdr-spreader: herdr plugin install yuk1ty/herdr-spreader"

## concepts

**bootstrap** is the process of dynamically composing a multi-agent workspace from existing project extensions. you decide the topology, select agents, generate a spreader YAML layout, and coordinate the running agents.

**topology** describes how agents relate:
- **chain** — sequential pipeline. agent B waits for agent A's results before starting. used when steps have dependencies (e.g., "find issues → fix them → verify fixes").
- **team** — parallel specialists. all agents work simultaneously and independently. used when steps are independent (e.g., "write docs, audit security, add tests").

**coms** is the peer-to-peer messaging system (unix sockets, same machine). there are TWO different coms APIs — one for the dispatcher and one for spawned agents. confusing them leads to failed result collection.

**dispatcher coms (request/response, keyed by `msg_id`):**
- `coms_send(target: "<name>", prompt: "<text>")` → returns a `msg_id`. sends a conversational prompt to the agent.
- `coms_await(msg_id)` / `coms_get(msg_id)` — blocks/polls for the agent's **reply** to that specific prompt, retrieved by `msg_id`.
- the reply is conversational text (the agent's answer), NOT a structured JSON payload.

**agent coms (message queue, keyed by sender name):**
- `coms_send(recipient: "dispatcher", message: "<JSON>")` — pushes a JSON payload to a named inbox.
- `coms_await(sender: "dispatcher")` / `coms_get(sender: "dispatcher")` — blocks/polls by sender name.
- agents use this to push structured results to the dispatcher.

**critical gotcha:** the dispatcher's `coms_get(msg_id)` retrieves by msg_id (from the dispatcher's own sends). it CANNOT retrieve agent-pushed messages that are keyed by sender name. therefore:
- for **structured result collection**: use `herdr pane read <pane-id> --source recent --lines 80` as the primary method.
- for **conversational queries** (asking an agent a question): use `coms_send` + `coms_await(msg_id)`.
- do NOT attempt to retrieve agent-pushed JSON by re-sending `coms_send` and asking the agent to "resend as JSON" — this causes loops. just read the pane output directly.

messages are queued — if a sender sends before the receiver listens, the message waits.

**herdr agent status** is detected automatically:
- `idle` — agent started but not working yet
- `working` — agent is actively doing its task
- `done` — agent finished (you haven't looked at it yet)
- `unknown` — status couldn't be determined

**herdr-spreader** creates workspaces from YAML. `bootstrap_generate` writes the YAML and calls apply. panes are created in order.

## commands

the user invokes the bootstrap with:

- `boot chain <task>` — explicit chain topology
- `boot team <task>` — explicit team topology
- `boot auto <task>` — you decide the topology
- `boot cleanup <workspace-id>` — close workspace and clean session files

## execution protocol

### step 1: discover available agents

scan the project for agent personas:
```bash
ls .pi/agents/ .claude/agents/ agents/ 2>/dev/null
```

read each `.md` file's frontmatter to get `name`, `description`, `tools`, and the `extensions` field. you use these to match agents to task steps.

if a `teams.yaml` file exists in `.pi/`, read it for predefined team compositions.

### step 2: decompose the task and select agents

based on the task description, decompose it into sub-tasks. for each sub-task, select the best-matching agent by reading agent descriptions and comparing to the sub-task.

for `boot auto`:
- classify the task as chain or team using these few-shot examples:

**Example 1 → chain:**
  task: "audit security, then fix issues, then verify with tests"
  reasoning: each step depends on the previous — fixes need audit results, verification needs fixes
  topology: chain
  agents: [scout → builder → reviewer]

**Example 2 → chain:**
  task: "research options, prototype the chosen approach, write tests for the prototype"
  reasoning: prototype needs research results, tests need the prototype
  topology: chain
  agents: [scout → builder → reviewer]

**Example 3 → team:**
  task: "write the API docs, audit the codebase for security, add unit tests for utils"
  reasoning: all three are independent — no step needs another's output
  topology: team
  agents: [documenter, red-team, builder]

**Example 4 → team:**
  task: "write the UI, write the API server, write the database migration"
  reasoning: three independent tracks — frontend, backend, database
  topology: team
  agents: [builder, builder, builder] (or specialist agents if available)

- if uncertain, choose chain — it handles dependencies safely.

for `boot chain` and `boot team`:
- use the user-specified topology directly; you still need to decompose the task and select agents.

### step 3: call bootstrap_generate

call the `bootstrap_generate` tool with:
```
{
  topology: "chain" | "team",
  task: "<original task description>",
  agents: [
    { name: "<agent-name>", sub_task: "<specific sub-task>", step: 1, predecessor: null, successor: "<next-agent>" },
    ...
  ],
  project_cwd: "<current working directory>"
}
```

for teams, omit `step`, `predecessor`, and `successor`.

the tool returns:
```
{
  status: "applied" | "error",
  yaml_path: "<path>",
  pane_manifest: [{ agent_name, pane_id, expected_coms_name }],
  dispatcher_coms_name: "dispatcher"
}
```

if status is "error", report the error to the user and stop.

### step 4: coordinate — chain topology

enter this loop:

```
loop:
  herdr pane list → get all pane statuses
  for each pane in pane_manifest:
    if status is "error":
      1. send abort coms to all successors: coms_send(recipient: <successor>, message: '{"status":"failure","summary":"Chain aborted — predecessor failed"}')
      2. read the failed pane: herdr pane read <pane-id> --source recent --lines 50
      3. report failure to user with diagnostics
      4. stop

  if last pane status is "done":
    1. herdr pane read <pane-id> --source recent --lines 80 ← PRIMARY result collection method
    2. optionally: coms_send(target: <agent>, prompt: "summarize your results") + coms_await(msg_id) for a conversational summary
    3. break loop

  wait 5 seconds, repeat
```

key: watch ALL panes for error status, not just the last. coms handles intermediate sequencing — agents block on coms_await automatically.

### step 5: coordinate — team topology

enter this loop:

```
results = []
loop:
  herdr pane list → get all pane statuses
  for each pane in pane_manifest:
    if status is "done" and agent not yet collected:
      1. herdr pane read <pane-id> --source recent --lines 80 ← PRIMARY result collection method
      2. optionally: coms_send(target: <agent>, prompt: "summarize your results") + coms_await(msg_id) for a conversational summary
      3. add result to results[]
    
    if status is "error" and agent not yet collected:
      1. herdr pane read <pane-id> --source recent --lines 50
      2. add a failure result to results[]
  
  if all agents collected: break
  wait 5 seconds, repeat
```

agents finish at different times — collect results as they arrive, not in fixed order.

### step 6: aggregate and report

once you have all results, format a per-agent summary:

```
## Bootstrap Results: "<task>"
Topology: <chain|team> (<N> agents) | Workspace: <workspace-name> (<workspace-id>)

### ✅ <Agent Name> — <Role>
Status: <status>
Summary: <summary>
Metrics: <metrics>
Detail: <detail>
Artifacts: ...
Warnings: ...
Next steps: ...

---

Overall: <X success, Y partial, Z failure> | <N warnings>
Workspace left open for inspection. Run `boot cleanup <workspace-id>` to close.
```

### step 7: persist results

call the `bootstrap_report` tool with:
```
{
  task_id: "<task-id>",
  results: [<all collected results>],
  write_markdown: true  // or ask user if they want markdown
}
```

### step 8: offer cleanup

say to the user: "Workspace left open for inspection. Run `boot cleanup <workspace-id>` to close and clean up session files."

when the user runs `boot cleanup <workspace-id>`:
call the `bootstrap_cleanup` tool with:
```
{
  task_id: "<task-id>",
  workspace_id: "<workspace-id>"
}
```

report the result to the user.

## failure handling

### chain failure
- if any agent pane shows "error" status:
  1. immediately send abort coms messages to all downstream agents (successors)
  2. read the failed agent's pane for diagnostics
  3. report to user: which agent failed, what the diagnostics say, and that the chain was aborted
  4. do not continue polling

### team failure
- if an agent pane shows "error" status:
  1. read the failed pane for diagnostics
  2. continue collecting results from other agents
  3. report partial results to the user with the failure noted
  4. offer to retry the failed agent (Phase 2 feature — for now, suggest the user can manually re-run in a new pane)

### timeout
- agents have PI_COMS_TIMEOUT_MS=300000 (5 minutes) for coms_await
- if an agent times out waiting for its predecessor, it self-terminates with "Chain aborted" message
- the dispatcher detects this via herdr agent status transition to "done" or "error"

## spreader YAML schema reference

```yaml
workspaces:
  - name: string          # required — workspace label (task-id)
    root: path            # project root path
    env:                  # env vars applied to all panes
      PI_COMS_TIMEOUT_MS: "300000"
    tabs:
      - label: string     # tab name: "chain" or "team"
        panes:
          - command: string    # full pi invocation
          - split: down        # split direction (right|down)
            ratio: 0.5         # split size ratio
            command: string   # full pi invocation
```

## coms protocol reference

### dispatcher coms (what the dispatcher uses)

- `coms_send(target: "<agent_name>", prompt: "<text>")` → returns `msg_id`. sends a conversational prompt.
- `coms_await(msg_id)` — block until the agent replies to that specific prompt.
- `coms_get(msg_id)` — non-blocking poll for the reply.
- `coms_list()` — list all known agents and their context usage.

### agent coms (what spawned agents use internally)

- `coms_send(recipient: "<name>", message: "<JSON string>")` — push a payload to a named inbox
- `coms_await(sender: "<name>", timeout: <ms>)` — block until message from sender
- `coms_get(sender: "<name>")` — read a message from sender (non-blocking)

### result collection guidance

- **primary method**: `herdr pane read <pane-id> --source recent --lines 80` — read the agent's output directly. always works.
- **conversational**: `coms_send(target: <agent>, prompt: "...")` → `coms_await(msg_id)` — for asking agents follow-up questions. reply is text, not structured JSON.
- **avoid**: do not loop asking agents to "resend JSON via coms" — agent-pushed messages are keyed by sender name and cannot be retrieved by the dispatcher's `coms_get(msg_id)`.
- messages are queued: if sender sends before receiver calls coms_await, the message waits.
