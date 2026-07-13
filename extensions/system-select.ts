/**
 * System Select — Switch the system prompt via /system, /system <name>, or shortcuts
 *
 * Scans .pi/agents/, .claude/agents/, .gemini/agents/, .codex/agents/
 * (project-local and global) for agent definition .md files.
 *
 * /system                — Open a select dialog to pick a system prompt
 * /system <name>         — Switch directly by agent name (case-insensitive)
 * /system default|reset  — Reset to the default Pi system prompt
 *
 * Ctrl+S                 — Cycle system prompt forward (overrides built-in Ctrl+S
 *                          session-sort toggle; emits a verbose-only diagnostic)
 * Ctrl+Shift+S           — Cycle system prompt backward
 *                          NOTE: Ctrl+Shift+S requires Kitty keyboard protocol
 *                          (Ghostty, WezTerm, kitty, recent xterm). On macOS legacy
 *                          terminals (Terminal.app, iTerm2) this binding will not
 *                          fire; use /system <name> or the dialog as a fallback.
 *
 * --agent <name>         — Preselect an agent at startup (case-insensitive name match)
 *                          NOTE: We deliberately do NOT use --system-prompt because
 *                          that is a pi-builtin flag (text replacement); an extension
 *                          flag of the same name would be shadowed by the builtin and
 *                          never receive its value.
 *
 * Features:
 *   - Status line shows current agent name (or "Default") in the footer
 *   - Cycling / dialog / CLI preselect all share one code path (selectEntry)
 *   - Color swatch widget flashes briefly after each switch (3s auto-dismiss)
 *   - Selected agent's body is prepended to Pi's default instructions; tools are
 *     restricted to the agent's declared tool set when specified
 *
 * Usage: pi -e extensions/system-select.ts -e extensions/minimal.ts
 *        pi -e extensions/system-select.ts --agent bowser
 *        pi -e extensions/system-select.ts -e extensions/minimal.ts --agent bowser
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { applyExtensionDefaults } from "./themeMap.ts";

interface AgentDef {
	name: string;
	description: string;
	tools: string[];
	body: string;
	source: string;
}

const DEFAULT_ALIASES = new Set(["default", "none", "reset"]);

function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
	const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
	if (!match) return { fields: {}, body: raw };
	const fields: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
	}
	return { fields, body: match[2] };
}

function scanAgents(dir: string, source: string): AgentDef[] {
	if (!existsSync(dir)) return [];
	const agents: AgentDef[] = [];
	try {
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".md")) continue;
			const raw = readFileSync(join(dir, file), "utf-8");
			const { fields, body } = parseFrontmatter(raw);
			agents.push({
				name: fields.name || basename(file, ".md"),
				description: fields.description || "",
				tools: fields.tools ? fields.tools.split(",").map((t) => t.trim()) : [],
				body: body.trim(),
				source,
			});
		}
	} catch {}
	return agents;
}

function displayName(name: string): string {
	return name.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export default function (pi: ExtensionAPI) {
	// --- CLI flag: --agent <name> for startup preselect ----------------------
	// We cannot use --system-prompt here: that's a pi-builtin flag (text
	// replacement) consumed during argv parsing before any extension flag is
	// read. The extension's registered "system-prompt" would be silently
	// shadowed. --agent is unambiguous and free of collisions.
	pi.registerFlag("agent", {
		description: "Preselect an agent system prompt by name (case-insensitive). Use /system to change later.",
		type: "string",
		default: undefined,
	});

	// --- Module state --------------------------------------------------------
	let entries: (AgentDef | null)[] = []; // index 0 = null (Default), 1..N = agents
	let currentIndex = 0;
	let defaultTools: string[] = [];
	let currentCtx: ExtensionContext | undefined;
	let agentSwatchTimer: ReturnType<typeof setTimeout> | null = null;

	// --- Helpers -------------------------------------------------------------

	/**
	 * Resolve an entry index from a string identifier.
	 * - `default`/`none`/`reset` → 0
	 * - case-insensitive name match against agent entries (1..N)
	 * - returns -1 if no match
	 */
	function findEntryIndex(arg: string): number {
		const normalized = arg.trim().toLowerCase();
		if (!normalized) return -1;
		if (DEFAULT_ALIASES.has(normalized)) return 0;
		for (let i = 1; i < entries.length; i++) {
			if (entries[i]!.name.toLowerCase() === normalized) return i;
		}
		return -1;
	}

	/**
	 * Apply the side effects of picking an entry: set tools, status line.
	 * Returns the display label for use in notifications.
	 */
	function selectEntry(idx: number, ctx: ExtensionContext): string {
		currentIndex = idx;
		const agent = entries[idx] ?? null;

		if (agent) {
			pi.setActiveTools(agent.tools.length > 0 ? agent.tools : defaultTools);
			ctx.ui.setStatus("system-prompt", `System Prompt: ${displayName(agent.name)}`);
			return displayName(agent.name);
		} else {
			pi.setActiveTools(defaultTools);
			ctx.ui.setStatus("system-prompt", "System Prompt: Default");
			return "Default";
		}
	}

	// --- Swatch widget -------------------------------------------------------

	function showAgentSwatch(ctx: ExtensionContext, agent: AgentDef | null) {
		if (!ctx.hasUI) return;

		// Clear any in-flight auto-dismiss before installing the new swatch.
		if (agentSwatchTimer) {
			clearTimeout(agentSwatchTimer);
			agentSwatchTimer = null;
		}

		ctx.ui.setWidget(
			"system-swatch",
			(_tui, theme) => ({
				invalidate() {},
				render(width: number): string[] {
					const border = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
					if (!agent) {
						const label = theme.fg("accent", " 🧠 ") + theme.fg("muted", "Default Pi system prompt");
						return [border, truncateToWidth("  " + label, width), border];
					}
					const name = theme.fg("accent", ` ${displayName(agent.name)} `);
					const src = theme.fg("dim", `[${agent.source}]`);
					const desc = theme.fg("muted", agent.description);
					const toolsTag = agent.tools.length > 0
						? theme.fg("warning", ` ⚒ ${agent.tools.length}`)
						: "";
					const line = "  " + name + src + " " + desc + toolsTag;
					return [border, truncateToWidth(line, width), border];
				},
			}),
			{ placement: "belowEditor" },
		);

		agentSwatchTimer = setTimeout(() => {
			ctx.ui.setWidget("system-swatch", undefined);
			agentSwatchTimer = null;
		}, 3000);
	}

	// --- Cycle ---------------------------------------------------------------

	function cycleAgent(ctx: ExtensionContext, direction: 1 | -1) {
		if (!ctx.hasUI) return;
		if (entries.length <= 1) {
			ctx.ui.notify("No agents discovered to cycle", "warning");
			return;
		}

		const next = (currentIndex + direction + entries.length) % entries.length;
		const label = selectEntry(next, ctx);
		const agent = entries[next];
		showAgentSwatch(ctx, agent);
		// (currentIndex+1)/entries.length — Default counts as position 1/N.
		ctx.ui.notify(`${label} (${next + 1}/${entries.length})`, "info");
	}

	// --- Shortcuts -----------------------------------------------------------

	pi.registerShortcut("ctrl+s", {
		description: "Cycle system prompt forward (overrides built-in Ctrl+S session-sort toggle)",
		handler: async (ctx) => {
			currentCtx = ctx;
			cycleAgent(ctx, 1);
		},
	});

	pi.registerShortcut("ctrl+shift+s", {
		description: "Cycle system prompt backward (Kitty-protocol terminals only; macOS Terminal.app / iTerm2 not supported)",
		handler: async (ctx) => {
			currentCtx = ctx;
			cycleAgent(ctx, -1);
		},
	});

	// --- Command: /system ----------------------------------------------------

	pi.registerCommand("system", {
		description: "Select a system prompt: /system, /system <name>, or /system default",
		handler: async (args, ctx) => {
			currentCtx = ctx;
			const arg = (args ?? "").trim();

			if (entries.length === 0) {
				ctx.ui.notify("No agents found in .*/agents/*.md", "warning");
				return;
			}

			// Direct-by-name path (matches /system <name> | default | reset)
			if (arg) {
				const idx = findEntryIndex(arg);
				if (idx === -1) {
					ctx.ui.notify(`No agent named "${arg}". Use /system to list.`, "error");
					return;
				}
				const label = selectEntry(idx, ctx);
				showAgentSwatch(ctx, entries[idx]);
				ctx.ui.notify(
					idx === 0
						? "System Prompt reset to Default"
						: `System Prompt switched to: ${label}`,
					"success",
				);
				return;
			}

			// Dialog path
			const options = [
				"Reset to Default",
				...entries.slice(1).map((a) => `${a!.name} — ${a!.description} [${a!.source}]`),
			];

			const choice = await ctx.ui.select("Select System Prompt", options);
			if (choice === undefined) return;

			const idx = options.indexOf(choice);
			const label = selectEntry(idx, ctx);
			showAgentSwatch(ctx, entries[idx]);
			ctx.ui.notify(
				idx === 0
					? "System Prompt reset to Default"
					: `System Prompt switched to: ${label}`,
				"success",
			);
		},
	});

	// --- Session init --------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		currentCtx = ctx;
		currentIndex = 0;
		entries = [];
		agentSwatchTimer = null;

		const home = homedir();
		const cwd = ctx.cwd;

		const dirs: [string, string][] = [
			[join(cwd, ".pi", "agents"), ".pi"],
			[join(cwd, ".claude", "agents"), ".claude"],
			[join(cwd, ".gemini", "agents"), ".gemini"],
			[join(cwd, ".codex", "agents"), ".codex"],
			[join(home, ".pi", "agent", "agents"), "~/.pi"],
			[join(home, ".claude", "agents"), "~/.claude"],
			[join(home, ".gemini", "agents"), "~/.gemini"],
			[join(home, ".codex", "agents"), "~/.codex"],
		];

		const seen = new Set<string>();
		const sourceCounts: Record<string, number> = {};

		for (const [dir, source] of dirs) {
			const agents = scanAgents(dir, source);
			for (const agent of agents) {
				const key = agent.name.toLowerCase();
				if (seen.has(key)) continue;
				seen.add(key);
				entries.push(agent);
				sourceCounts[source] = (sourceCounts[source] || 0) + 1;
			}
		}

		// index 0 = Default (null)
		entries = [null, ...entries];

		// Capture defaults BEFORE applying preselect (preselect calls
		// pi.setActiveTools(agent.tools || defaultTools)).
		defaultTools = pi.getActiveTools();

		// --- Preselect via --agent <name> ------------------------------------
		const preselectRaw = pi.getFlag("agent") as string | undefined;
		const preselect = preselectRaw?.trim();
		let preselectIdx = 0;
		let preselectMessage: string | null = null;
		if (preselect) {
			const idx = findEntryIndex(preselect);
			if (idx >= 1) {
				preselectIdx = idx;
			} else if (idx === 0) {
				// explicit default — already the default
				preselectIdx = 0;
			} else {
				preselectMessage = `No agent "${preselect}" found for --agent (loaded ${entries.length - 1}). Use /system to pick.`;
			}
		}

		// Apply selection (sets activeAgent-equivalent state + tools + status).
		selectEntry(preselectIdx, ctx);

		// Build the startup notify.
		const defaultPrompt = ctx.getSystemPrompt();
		const lines = defaultPrompt.split("\n").length;
		const chars = defaultPrompt.length;

		const loadedSources = Object.entries(sourceCounts)
			.map(([src, count]) => `${count} from ${src}`)
			.join(", ");

		const agentCount = entries.length - 1; // exclude null entry
		const activeLabel = entries[preselectIdx] ? displayName(entries[preselectIdx]!.name) : "Default";

		const notifyLines: string[] = [];
		if (agentCount > 0) {
			notifyLines.push(`Loaded ${agentCount} agents (${loadedSources})`);
		}
		notifyLines.push(`System Prompt: ${activeLabel} (${lines} lines, ${chars} chars)`);
		if (preselectMessage) notifyLines.push(preselectMessage);

		const severity: "info" | "warning" = preselectMessage ? "warning" : "info";
		ctx.ui.notify(notifyLines.join("\n"), severity);
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		const agent = entries[currentIndex];
		if (!agent) return;
		return {
			systemPrompt: agent.body + "\n\n" + event.systemPrompt,
		};
	});

	pi.on("session_shutdown", async () => {
		if (agentSwatchTimer) {
			clearTimeout(agentSwatchTimer);
			agentSwatchTimer = null;
		}
		if (currentCtx?.hasUI) {
			try {
				currentCtx.ui.setWidget("system-swatch", undefined);
			} catch {
				// UI may already be torn down — non-fatal
			}
		}
	});
}
