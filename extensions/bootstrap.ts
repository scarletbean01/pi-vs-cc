/**
 * Bootstrap — Herdr-native agent bootstrap extension
 *
 * Spawns agents as herdr tabs in the current workspace, coordinates via
 * coms, and provides result/cleanup tools.
 *
 * Tools:
 *   bootstrap_generate — create workspace, spawn agent panes, return manifest
 *   bootstrap_report   — persist collected results to JSON (always) and optionally markdown
 *   bootstrap_cleanup  — close agent tabs, clean session files
 *
 * Slash command:
 *   /boot              — show available boot modes
 *
 * Usage: pi -e extensions/bootstrap.ts --agent dispatcher
 *        (inside herdr)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { execSync } from "child_process";
import { writeFileSync, rmSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
	scanAgents,
	generateTaskId,
	ensureSessionDir,
	resolveSessionDir,
	resolveExtensionPaths,
	type AgentDef,
} from "./bootstrap-utils.ts";
import { resolveModel } from "./model-utils.ts";
import { applyExtensionDefaults } from "./themeMap.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Module-level helpers
// ─────────────────────────────────────────────────────────────────────────────

interface SpreaderMode {
	mode: "plugin" | "binary";
	invoke: (yamlPath: string) => string;
}

/**
 * Detect how herdr-spreader is available on the system.
 *
 * Order (per Phase 0 of the plan):
 *   1. Standalone binary on PATH (preferred — fewer herdr round-trips).
 *   2. herdr plugin (fallback — requires herdr CLI to be installed and
 *      a session to be running so `herdr plugin action invoke` works).
 *
 * Returns null when neither is found; the caller is responsible for
 * surfacing a clear install-instructions error in that case.
 */
function detectSpreader(): SpreaderMode | null {
	// 1. Standalone binary
	try {
		const binaryPath = execSync("which herdr-spreader 2>/dev/null", { encoding: "utf-8" }).trim();
		if (binaryPath) {
			return {
				mode: "binary",
				invoke: (yaml: string) => `${binaryPath} apply --file ${yaml}`,
			};
		}
	} catch {
		// which failed entirely — fall through
	}

	// 2. herdr plugin binary (locate it inside the herdr plugins directory).
	// The `herdr plugin action invoke` CLI does not support passing action
	// arguments like --file to the underlying binary, so we invoke the
	// binary directly at its well-known path:
	//   ~/.config/herdr/plugins/github/herdr-spreader-<hash>/target/release/herdr-spreader
	try {
		const pluginsDir = join(homedir(), ".config", "herdr", "plugins", "github");
		if (existsSync(pluginsDir)) {
			for (const dir of readdirSync(pluginsDir)) {
				if (dir.startsWith("herdr-spreader")) {
					const binaryPath = join(pluginsDir, dir, "target", "release", "herdr-spreader");
					if (existsSync(binaryPath)) {
						return {
							mode: "binary" as const,
							invoke: (yaml: string) => `${binaryPath} apply --file ${yaml}`,
						};
					}
				}
			}
		}
	} catch {
		// plugins directory not readable — fall through
	}

	return null;
}


/**
 * Detect the current (focused) herdr workspace ID by querying `herdr
 * workspace list` and finding the workspace with `focused: true`.
 *
 * Returns null when herdr is not running or no focused workspace is found.
 */
function detectCurrentWorkspace(): string | null {
	// 1. Try the env var (always set when running inside herdr)
	if (process.env.HERDR_WORKSPACE_ID) {
		return process.env.HERDR_WORKSPACE_ID;
	}

	// 2. Query `herdr workspace list` for the focused workspace.
	//    Note: the `--format json` flag is not supported in all herdr
	//    versions — plain `herdr workspace list` already emits JSON.
	for (const cmd of [
		"herdr workspace list --format json 2>/dev/null",
		"herdr workspace list 2>/dev/null",
	]) {
		try {
			const json = execSync(cmd, { encoding: "utf-8", timeout: 10000 });
			const parsed = JSON.parse(json);
			const workspaces: any[] = parsed?.result?.workspaces || parsed?.workspaces || [];
			const focused = workspaces.find((w: any) => w.focused);
			if (focused?.workspace_id) return focused.workspace_id;
		} catch {
			// try next command variant
		}
	}

	return null;
}

/**
 * Spawn agents as separate tabs in the current herdr workspace.
 *
 * For each agent, creates a new tab via `herdr tab create --workspace <ws-id>
 * --label <agent-name>` and then runs the agent's pi command in that tab's
 * root pane via `herdr pane run <pane-id> <command>`.
 *
 * Returns a pane manifest with agent_name, pane_id, tab_id, and
 * expected_coms_name for each agent.
 */
function spawnAgentsInTabs(
	taskId: string,
	cwd: string,
	topology: "chain" | "team",
	commands: string[],
	agentNames: string[],
	workspaceId: string,
): Array<{ agent_name: string; pane_id: string; tab_id: string; expected_coms_name: string }> {
	const manifest: Array<{ agent_name: string; pane_id: string; tab_id: string; expected_coms_name: string }> = [];

	for (let i = 0; i < commands.length; i++) {
		const name = agentNames[i];
		const label = `${topology}:${name}`;

		// Create a new tab in the existing workspace
		let tabId = "unknown";
		let paneId = "unknown";
		try {
			const tabJson = execSync(
				`herdr tab create --workspace ${workspaceId} --label "${label}" --cwd ${cwd} --no-focus 2>/dev/null`,
				{ encoding: "utf-8", timeout: 15000 },
			);
			const tabParsed = JSON.parse(tabJson);
			const tabResult = tabParsed?.result || tabParsed;
			tabId = tabResult?.tab?.tab_id || "unknown";
			paneId = tabResult?.root_pane?.pane_id || "unknown";
		} catch (e: any) {
			throw new Error(`Failed to create tab for agent "${name}": ${e?.message || String(e)}`);
		}

		// Run the agent command in the tab's root pane.
		// The command is a multi-line string with ` \n  ` continuations;
		// join it into a single line for `herdr pane run`.
		const singleLineCmd = commands[i].replace(/ \\\n\s+/g, " ");
		try {
			execSync(
				`herdr pane run ${paneId} ${JSON.stringify(singleLineCmd)}`,
				{ stdio: "pipe", timeout: 15000 },
			);
		} catch (e: any) {
			throw new Error(`Failed to start agent "${name}" in pane ${paneId}: ${e?.message || String(e)}`);
		}

		manifest.push({
			agent_name: name,
			pane_id: paneId,
			tab_id: tabId,
			expected_coms_name: name,
		});
	}

	return manifest;
}

interface RequestedAgent {
	name: string;
	sub_task: string;
	step?: number;
	predecessor?: string;
	successor?: string;
}

/**
 * Build the append-system-prompt body for a single agent.
 *
 * Selects one of three templates (chain-not-last, chain-last, team) per
 * Appendix A of PLAN.md and fills in:
 *   agent_name, agent_description, agent_color, sub_task, step, total_steps,
 *   predecessor_name, successor_name, dispatcher_coms_name, coms_timeout_ms
 */
function buildAppendPrompt(
	req: RequestedAgent,
	def: AgentDef,
	topology: "chain" | "team",
	totalSteps: number,
	dispatcherComsName: string,
	comsTimeoutMs: string,
	autoStart: boolean,
): string {
	const color = def.color || "";
	const desc = def.description || "";
	const step = req.step || 0;
	const predecessor = req.predecessor || "";
	const successor = req.successor || dispatcherComsName;

	const jsonFormat = `{
  "status": "success" | "partial" | "failure",
  "summary": "One-line summary of what you accomplished",
  "detail": "Longer explanation of what was done",
  "artifacts": [
    {
      "type": "file" | "reference" | "output",
      "path": "/path/to/file",
      "action": "created" | "modified" | "deleted",
      "description": "What changed"
    }
  ],
  "metrics": {
    "files_changed": 0,
    "issues_found": 0,
    "tests_run": 0,
    "tests_passed": 0
  },
  "warnings": [],
  "next_steps": []
}`;

	if (topology === "team") {
		return `---
name: ${req.name}
description: ${desc}
color: ${color}
---
${autoStart ? `## Coordination Context
You are a member of a TEAM working in parallel. No predecessor — you have everything you need.
Your task will be delivered as the initial user message.
⤷ Output:` : `## Your Task
${req.sub_task}

## Coordination Context
You are a member of a TEAM working in parallel. No predecessor — you have everything you need.
⤷ Output:`} When your work is complete, send your results to "${dispatcherComsName}" via \`coms_send(recipient: "${dispatcherComsName}", message: "<your results>")\`.

## Result Format
Send your results via \`coms_send\` as a JSON string:
${jsonFormat}

## Completion Protocol
1. Do your task independently
2. Format your results as the JSON shown above
3. Send results to "${dispatcherComsName}" via \`coms_send\`
4. Exit

## Failure
If you encounter an error you cannot resolve, send a message to "${dispatcherComsName}" via \`coms_send\` with status "failure" and a description of the error, then exit.
`;
	}

	// Chain template (not-last or last)
	const isLast = !req.successor || req.successor === "dispatcher";
	const recipient = isLast ? dispatcherComsName : successor;

	return `---
name: ${req.name}
description: ${desc}
color: ${color}
---
${autoStart ? `## Coordination Context
You are step ${step} of ${totalSteps} in a CHAIN pipeline — the FIRST step.
Your task will be delivered as the initial user message.
⤷ Output: When your work is complete, send your results to "${recipient}" via \`coms_send(recipient: "${recipient}", message: "<your results>")\`.

## Result Format
Send your results via \`coms_send\` as a JSON string:
${jsonFormat}

## Completion Protocol
1. Do your task
2. Format your results as the JSON shown above
3. Send results to "${recipient}" via \`coms_send\`
4. Exit — the dispatcher will detect your completion via herdr agent status` : `## Your Task
${req.sub_task}

## Coordination Context
You are step ${step} of ${totalSteps} in a CHAIN pipeline${isLast ? " — the FINAL step" : ""}.
⤷ Input: Wait for a message from "${predecessor}" via \`coms_await(sender: "${predecessor}")\` before starting. The message body is your input — treat it as context for your task.
⤷ Output: When your work is complete, send your results to "${recipient}" via \`coms_send(recipient: "${recipient}", message: "<your results>")\`.

## Result Format
Send your results via \`coms_send\` as a JSON string:
${jsonFormat}

## Completion Protocol
1. Do your task using the input received from your predecessor
2. Format your results as the JSON shown above
3. Send results to "${recipient}" via \`coms_send\`
4. Exit — the dispatcher will detect your completion via herdr agent status

## Timeout
If \`coms_await\` from "${predecessor}" times out (${comsTimeoutMs}ms), exit immediately and report: "Chain aborted — predecessor did not deliver input in time."`}
`;
}

/**
 * Build a multi-line shell command string that invokes `pi` with the right
 * extensions, agent persona, coms identity, and append-system-prompt file.
 *
 * Returns a single string with ` \\\n  ` line continuations so the YAML
 * emitter can split it back into individual argv tokens.
 */
function buildPiCommand(
	req: RequestedAgent,
	def: AgentDef,
	cwd: string,
	sessionDir: string,
	ctxModel: { provider: string; id: string } | undefined,
	autoStart: boolean,
): string {
	const parts: string[] = ["pi"];

	// Always load coms and system-select
	parts.push("-e extensions/coms.ts");
	parts.push("-e extensions/system-select.ts");

	// Add agent-specific extensions (resolved by bootstrap-utils).
	if (def.extensions && def.extensions.length > 0) {
		const resolved = resolveExtensionPaths(cwd, def.extensions);
		for (const ext of resolved) {
			parts.push(`-e ${ext}`);
		}
	}

	// Agent persona and coms identity
	parts.push(`--agent ${req.name}`);
	parts.push(`--cname ${req.name}`);

	// --purpose sets the coms panel display label for this agent (metadata
	// only — not injected into the agent's system prompt).
	const purpose = req.sub_task.replace(/"/g, '\\"');
	parts.push(`--purpose "${purpose}"`);

	// Per-agent model resolution: agent-declared model → parent ctx model → default.
	const model = resolveModel(def.model, ctxModel);
	parts.push(`--model ${model}`);

	// Append-system-prompt file (one per agent, written to the session dir).
	// Contains coordination context, result format, and completion protocol.
	parts.push(`--append-system-prompt ${join(sessionDir, `${req.name}_append.md`)}`);

	// `pi` and an optional project namespace; --project is derived from
	// the project basename so all panes (and the dispatcher) share the
	// same coms namespace.
	const projectSlug = cwd.split("/").filter(Boolean).pop() || "project";
	parts.push(`--project ${projectSlug}`);

	// Initial user message — auto-starts the agent when the pane opens
	// (no manual send-text needed).  Only for agents that don't need to
	// wait for a predecessor (team agents + chain-first agents).  Chain
	// non-first agents receive their task via coms_await instead.
	if (autoStart) {
		const taskMessage = req.sub_task.replace(/"/g, '\\"');
		parts.push(`"${taskMessage}"`);
	}

	return parts.join(" \\\n  ");
}

/**
 * Build the herdr-spreader YAML layout. Mirrors the schema documented in
 * PLAN.md Appendix E: one workspace, one tab, N panes split down with a
 * 0.5 ratio. The YAML is deny_unknown_fields-compatible: only the keys
 * herdr-spreader recognizes appear.
 */
function buildSpreaderYaml(
	taskId: string,
	cwd: string,
	topology: "chain" | "team",
	commands: string[],
): string {
	const lines: string[] = [
		"workspaces:",
		`  - name: "${taskId}"`,
		`    root: ${cwd}`,
		"    env:",
		'      PI_COMS_TIMEOUT_MS: "300000"',
		"    tabs:",
		`      - label: "${topology}"`,
		"        panes:",
	];

	for (let i = 0; i < commands.length; i++) {
		if (i === 0) {
			lines.push(`          - command: >-`);
		} else {
			lines.push(`          - split: down`);
			lines.push(`            ratio: 0.5`);
			lines.push(`            command: >-`);
		}
		// Re-indent the multi-line command at 14 spaces.
		const cmdParts = commands[i].split(" \\\n  ");
		for (let j = 0; j < cmdParts.length; j++) {
			lines.push(`              ${cmdParts[j]}`);
		}
	}

	return lines.join("\n") + "\n";
}

interface ReportResult {
	agent_name: string;
	status: "success" | "partial" | "failure";
	summary: string;
	detail?: string;
	artifacts?: Array<{ type: string; path?: string; action?: string; description?: string }>;
	metrics?: Record<string, number>;
	warnings?: string[];
	next_steps?: string[];
}

/**
 * Render a rollup + per-agent markdown report from collected results.
 * Format matches the example in PLAN.md SKILL step 6.
 */
function buildMarkdownReport(results: ReportResult[]): string {
	const lines: string[] = [];
	let success = 0;
	let partial = 0;
	let failure = 0;
	let totalWarnings = 0;

	for (const r of results) {
		const icon = r.status === "success" ? "✅" : r.status === "partial" ? "⚠️" : "❌";
		lines.push(`### ${icon} ${r.agent_name}`);
		lines.push(`Status: ${r.status}`);
		lines.push(`Summary: ${r.summary}`);
		if (r.metrics && Object.keys(r.metrics).length > 0) {
			lines.push(
				`Metrics: ${Object.entries(r.metrics)
					.map(([k, v]) => `${k}=${v}`)
					.join(", ")}`,
			);
		}
		if (r.detail) {
			lines.push(`Detail: ${r.detail}`);
		}
		if (r.artifacts && r.artifacts.length > 0) {
			lines.push("Artifacts:");
			for (const a of r.artifacts) {
				const desc = a.description || "";
				const pathPart = a.path ? ` ${a.path}` : "";
				const actionPart = a.action ? ` (${a.action})` : "";
				lines.push(`  - [${a.type}]${pathPart}${actionPart} — ${desc}`);
			}
		}
		if (r.warnings && r.warnings.length > 0) {
			lines.push("Warnings:");
			for (const w of r.warnings) {
				lines.push(`  - ${w}`);
			}
			totalWarnings += r.warnings.length;
		}
		if (r.next_steps && r.next_steps.length > 0) {
			lines.push("Next steps:");
			for (const s of r.next_steps) {
				lines.push(`  - ${s}`);
			}
		}
		lines.push("");

		if (r.status === "success") success++;
		else if (r.status === "partial") partial++;
		else failure++;
	}

	lines.unshift("# Bootstrap Results");
	lines.push("---");
	lines.push(
		`Overall: ${success} success, ${partial} partial, ${failure} failure | ${totalWarnings} warnings`,
	);

	return lines.join("\n") + "\n";
}

/**
 * Build the standard "session directory not found" error response used by
 * bootstrap_report and bootstrap_cleanup when resolveSessionDir returns
 * the error branch (i.e. the task_id has no matching directory under
 * `.pi/agent-sessions/`).
 *
 * The output wording, structure, and field names are byte-identical to the
 * previous inline blocks in both tools so existing agents and tests that
 * match on these strings keep working.
 */
function sessionDirNotFoundResponse(
	task_id: string,
	resolved: { error: string; available: string[]; sessionsRoot: string },
) {
	return {
		content: [{
			type: "text",
			text: `No session directory found for task_id "${task_id}". This is usually because task_id was confused with the workspace_id. ` +
				(resolved.available.length
					? `Available session dirs: ${resolved.available.join(", ")}`
					: `No session directories exist under ${resolved.sessionsRoot}.`),
		}],
		details: {
			status: "error" as const,
			error: resolved.error,
			task_id,
			available_task_ids: resolved.available,
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// ── Tool: bootstrap_generate ─────────────────────────

	pi.registerTool({
		name: "bootstrap_generate",
		label: "Bootstrap Generate",
		description:
			"Spawn agents as tabs in the current herdr workspace and return a pane manifest. Use this once you have decided on a topology and selected agents.",
		parameters: Type.Object({
			topology: Type.Union([Type.Literal("chain"), Type.Literal("team")]),
			task: Type.String({ description: "The high-level task description for the whole run" }),
			agents: Type.Array(
				Type.Object({
					name: Type.String({ description: "Agent persona name (case-insensitive match against .md files)" }),
					sub_task: Type.String({ description: "Focused sub-task for this agent" }),
					step: Type.Optional(Type.Number({ description: "Chain: 1-based step index" })),
					predecessor: Type.Optional(Type.String({ description: "Chain: coms name of the agent whose output feeds this one" })),
					successor: Type.Optional(Type.String({ description: "Chain: coms name of the agent to receive this one's output (omit for last)" })),
				}),
			),
			project_cwd: Type.String({ description: "Absolute repo root; used to scan agents and write session files" }),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const { topology, task, agents, project_cwd } = params as {
				topology: "chain" | "team";
				task: string;
				agents: RequestedAgent[];
				project_cwd: string;
			};
			const cwd = project_cwd || process.cwd();

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Bootstrapping ${topology} (${agents.length} agents) for: ${task}` }],
					details: { phase: "starting", topology, task, agents: agents.length },
				});
			}

			// 1. Task ID + session dir
			const taskId = generateTaskId(task);
			const sessionDir = ensureSessionDir(cwd, taskId);

			// 2. Scan available agents
			const availableAgents = scanAgents(cwd);

			// 3. Map requested → scanned
			const mapped = agents.map(req => {
				const def = availableAgents.find(a => a.name.toLowerCase() === req.name.toLowerCase());
				if (!def) {
					throw new Error(
						`Agent "${req.name}" not found. Available: ${availableAgents.map(a => a.name).join(", ")}`,
					);
				}
				return { req, def };
			});

			// 4. Build append-system-prompt files
			const dispatcherComsName = "dispatcher";
			const comsTimeoutMs = "300000";
			const totalSteps = agents.length;

			for (const { req, def } of mapped) {
				const autoStart = topology === "team" || !req.predecessor;
				const appendContent = buildAppendPrompt(
					req,
					def,
					topology,
					totalSteps,
					dispatcherComsName,
					comsTimeoutMs,
					autoStart,
				);
				const appendPath = join(sessionDir, `${req.name}_append.md`);
				writeFileSync(appendPath, appendContent, "utf-8");
			}

			// 5. Build pi commands
			const commands = mapped.map(({ req, def }) => {
				const autoStart = topology === "team" || !req.predecessor;
				return buildPiCommand(req, def, cwd, sessionDir, ctx?.model, autoStart);
			});

			// 6. Detect current workspace
			const workspaceId = detectCurrentWorkspace();
			if (!workspaceId) {
				return {
					content: [{
						type: "text",
						text: `Could not detect current herdr workspace. Make sure you're running inside herdr. (task_id: ${taskId}, session_dir: ${sessionDir})`,
					}],
					details: {
						status: "error" as const,
						error: "Could not detect current herdr workspace",
						task_id: taskId,
						session_dir: sessionDir,
						pane_manifest: [],
						dispatcher_coms_name: dispatcherComsName,
					},
				};
			}

			if (onUpdate) {
				onUpdate({
					content: [{ type: "text", text: `Spawning ${commands.length} agent(s) as tabs in workspace ${workspaceId}…` }],
					details: { phase: "spawning-tabs", workspace_id: workspaceId },
				});
			}

			// 7. Spawn agents as separate tabs in the current workspace
			const agentNames = mapped.map(({ req }) => req.name);
			let paneManifest: Array<{ agent_name: string; pane_id: string; tab_id: string; expected_coms_name: string }>;
			try {
				paneManifest = spawnAgentsInTabs(taskId, cwd, topology, commands, agentNames, workspaceId);
			} catch (e: any) {
				return {
					content: [{
						type: "text",
						text: `Failed to spawn agents: ${e?.message || String(e)} (task_id: ${taskId}, session_dir: ${sessionDir})`,
					}],
					details: {
						status: "error" as const,
						error: `Failed to spawn agents: ${e?.message || String(e)}`,
						task_id: taskId,
						session_dir: sessionDir,
						pane_manifest: [],
						dispatcher_coms_name: dispatcherComsName,
					},
				};
			}

			// Write the pane manifest to the session dir for debugging
			const manifestPath = join(sessionDir, "manifest.json");
			writeFileSync(manifestPath, JSON.stringify({ workspace_id: workspaceId, pane_manifest: paneManifest }, null, 2), "utf-8");

			return {
				content: [{
					type: "text",
					text: `Bootstrap applied. task_id: "${taskId}" — pass this exact string (NOT the workspace id) to bootstrap_report/bootstrap_cleanup. ${paneManifest.length} agent(s) spawned in workspace ${workspaceId}. See details for manifest.`,
				}],
				details: {
					status: "applied" as const,
					task_id: taskId,
					session_dir: sessionDir,
					workspace_id: workspaceId,
					pane_manifest: paneManifest,
					dispatcher_coms_name: dispatcherComsName,
				},
			};
		},
	});

	// ── Tool: bootstrap_report ────────────────────────────

	pi.registerTool({
		name: "bootstrap_report",
		label: "Bootstrap Report",
		description:
			"Persist collected agent results to JSON (always) and optionally markdown. Call this once all agent results are collected. IMPORTANT: task_id must be the exact string from bootstrap_generate's response details.task_id (a slug like 'my-task-ab12cd'), NOT the herdr workspace_id mentioned in the response text.",
		parameters: Type.Object({
			task_id: Type.String({ description: "The exact task_id string returned in bootstrap_generate's response (details.task_id) — NOT the herdr workspace_id." }),
			results: Type.Array(
				Type.Object({
					agent_name: Type.String(),
					status: Type.Union([Type.Literal("success"), Type.Literal("partial"), Type.Literal("failure")]),
					summary: Type.String(),
					detail: Type.String(),
					artifacts: Type.Optional(
						Type.Array(
							Type.Object({
								type: Type.Union([Type.Literal("file"), Type.Literal("reference"), Type.Literal("output")]),
								path: Type.Optional(Type.String()),
								action: Type.Optional(Type.Union([Type.Literal("created"), Type.Literal("modified"), Type.Literal("deleted")])),
								description: Type.Optional(Type.String()),
							}),
						),
					),
					metrics: Type.Optional(
						Type.Object({
							files_changed: Type.Optional(Type.Number()),
							issues_found: Type.Optional(Type.Number()),
							tests_run: Type.Optional(Type.Number()),
							tests_passed: Type.Optional(Type.Number()),
						}),
					),
					warnings: Type.Optional(Type.Array(Type.String())),
					next_steps: Type.Optional(Type.Array(Type.String())),
				}),
			),
			write_markdown: Type.Optional(Type.Boolean()),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { task_id, results, write_markdown } = params as {
				task_id: string;
				results: ReportResult[];
				write_markdown?: boolean;
			};

			const cwd = process.cwd();
			const resolved = resolveSessionDir(cwd, task_id);

			if ("error" in resolved) {
				return sessionDirNotFoundResponse(task_id, resolved);
			}

			const sessionDir = resolved.sessionDir;

			// Always write report.json
			const jsonPath = join(sessionDir, "report.json");
			writeFileSync(jsonPath, JSON.stringify(results, null, 2), "utf-8");

			// Optionally write report.md
			let mdPath: string | null = null;
			if (write_markdown) {
				mdPath = join(sessionDir, "report.md");
				const md = buildMarkdownReport(results);
				writeFileSync(mdPath, md, "utf-8");
			}

			return {
				content: [{
					type: "text",
					text: `Report saved: ${jsonPath}${mdPath ? ` (+ ${mdPath})` : ""}`,
				}],
				details: {
					status: "saved" as const,
					report_json: jsonPath,
					report_md: mdPath,
				},
			};
		},
	});

	// ── Tool: bootstrap_cleanup ──────────────────────────

	pi.registerTool({
		name: "bootstrap_cleanup",
		label: "Bootstrap Cleanup",
		description:
			"Close agent tabs and remove the session directory for a completed bootstrap run. IMPORTANT: task_id must be the exact string from bootstrap_generate's response details.task_id, NOT the herdr workspace_id.",
			parameters: Type.Object({
				task_id: Type.String({ description: "The exact task_id string returned in bootstrap_generate's response (details.task_id) — NOT the herdr workspace_id." }),
				tab_ids: Type.Array(Type.String(), { description: "The herdr tab IDs to close (from the pane manifest)" }),
			}),

			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const { task_id, tab_ids } = params as { task_id: string; tab_ids: string[] };

				const cwd = process.cwd();
				const resolved = resolveSessionDir(cwd, task_id);

				if ("error" in resolved) {
					return sessionDirNotFoundResponse(task_id, resolved);
				}

				const sessionDir = resolved.sessionDir;

				// 1. Close each agent tab
				let tabsClosed = 0;
				let closeErrors: string[] = [];
				for (const tabId of tab_ids) {
					try {
						execSync(`herdr tab close ${tabId}`, { stdio: "pipe", timeout: 10000 });
						tabsClosed++;
					} catch (e: any) {
						closeErrors.push(`${tabId}: ${e?.message || String(e)}`);
					}
				}

				const allTabsClosed = tabsClosed === tab_ids.length;

				// 2. Remove session directory.
				// resolveSessionDir has already confirmed the directory exists,
				// so rmSync with force:true is sufficient — no existsSync guard
				// needed.
				let sessionDirRemoved = false;
				let rmError: string | undefined;
				try {
					rmSync(sessionDir, { recursive: true, force: true });
					sessionDirRemoved = true;
				} catch (e: any) {
					rmError = e?.message || String(e);
				}

				if (!allTabsClosed) {
					return {
						content: [{
							type: "text",
							text: `Closed ${tabsClosed}/${tab_ids.length} tabs. Errors: ${closeErrors.join("; ")}`,
						}],
						details: {
							status: "error" as const,
							error: `Failed to close ${tab_ids.length - tabsClosed} tab(s): ${closeErrors.join("; ")}`,
							tabs_closed: tabsClosed,
							tabs_total: tab_ids.length,
							session_dir_removed: sessionDirRemoved,
						},
					};
				}

				if (!sessionDirRemoved) {
					return {
						content: [{
							type: "text",
							text: `All tabs closed, but failed to remove session directory: ${rmError}`,
						}],
						details: {
							status: "error" as const,
							error: "Tabs closed but failed to remove session directory",
							tabs_closed: tabsClosed,
							tabs_total: tab_ids.length,
							session_dir_removed: false,
						},
					};
				}

				return {
					content: [{
						type: "text",
							text: `Cleanup complete: ${tabsClosed} tab(s) closed, session dir removed.`,
					}],
					details: {
						status: "cleaned" as const,
						tabs_closed: tabsClosed,
						tabs_total: tab_ids.length,
						session_dir_removed: true,
					},
				};
			},
		});

	// ── Slash command: /boot ─────────────────────────────

	pi.registerCommand("boot", {
		description: "Show bootstrap command help. The dispatcher agent handles the actual orchestration.",
		handler: async (arg, ctx) => {
			const trimmed = (arg || "").trim();
			if (!trimmed) {
				ctx.ui.notify("Bootstrap commands:", "info");
				ctx.ui.notify("  /boot chain <task> — bootstrap a chain topology", "info");
				ctx.ui.notify("  /boot team <task>  — bootstrap a team topology", "info");
				ctx.ui.notify("  /boot auto <task>  — let the dispatcher decide topology", "info");
				ctx.ui.notify("  /boot cleanup <tab-ids> — close agent tabs + clean session files", "info");
				return;
			}
			ctx.ui.notify(
				`To run: boot ${trimmed} — the dispatcher agent handles this. Make sure you're running with --agent dispatcher.`,
				"info",
			);
		},
	});

	// ── Session start: apply theme defaults ───────────────

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
	});
}
