/**
 * Bootstrap utils — Shared helpers for agent scanning, frontmatter parsing,
 * session directory setup, and extension path resolution.
 *
 * Used by:
 *   - extensions/agent-team.ts     (legacy, non-herdr agent dispatcher)
 *   - extensions/agent-chain.ts    (legacy, non-herdr chain runner)
 *   - extensions/bootstrap.ts      (herdr-native agent bootstrap)
 *
 * This is a utility module, NOT a Pi extension. It has no default export
 * and does not register tools. All exports are named.
 *
 * Extension to AgentDef:
 *   - extensions?: string[]   parsed from the `extensions:` CSV frontmatter field
 *   - color?: string          parsed from the `color:` frontmatter field
 * These let bootstrap-generated append-system-prompt files echo the
 * agent's identity color for coms and load additional per-agent extensions.
 */

import { readdirSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parsed representation of an agent persona file (.pi/agents/*.md,
 * .claude/agents/*.md, or agents/*.md).
 */
export interface AgentDef {
	name: string;
	description: string;
	/** Raw CSV from the `tools:` frontmatter field. */
	tools: string;
	/** Markdown body of the agent file, with frontmatter stripped. */
	systemPrompt: string;
	/** Absolute path to the source .md file. */
	file: string;
	/** Raw frontmatter value for `model:` — alias (e.g. "opus") or provider/id. */
	model?: string;
	/** NEW: CSV of additional extension basenames (without .ts). */
	extensions?: string[];
	/** NEW: optional hex color string for coms identity. */
	color?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a markdown document into its YAML-style frontmatter fields and body.
 *
 * The parser is intentionally minimal: scalar `key: value` lines only. It does
 * NOT support YAML lists, nesting, or quoting — the agent frontmatter is
 * designed to be flat (with the single exception of CSV values like `tools:`
 * and `extensions:`, which are kept as strings and split by callers).
 *
 * If the document has no frontmatter delimiters, the entire input is
 * returned as `body` with empty `fields`.
 */
export function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return { fields: {}, body: raw };
	const fields: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
		}
	}
	return { fields, body: match[2].trim() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent file scanning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a single agent .md file. Returns null on any I/O error or if the file
 * is missing a `name:` frontmatter field.
 */
export function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const { fields: frontmatter, body } = parseFrontmatter(raw);
		if (!frontmatter.name) return null;

		return {
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools: frontmatter.tools || "read,grep,find,ls",
			systemPrompt: body,
			file: filePath,
			model: frontmatter.model || undefined,
			color: frontmatter.color || undefined,
			extensions: frontmatter.extensions
				? frontmatter.extensions.split(",").map(s => s.trim()).filter(Boolean)
				: undefined,
		};
	} catch {
		return null;
	}
}

/**
 * Scan the conventional agent directories for persona files and return a
 * deduplicated, sorted list of AgentDef records.
 *
 * Search order (first match wins per lowercase name):
 *   1. <cwd>/agents/*.md
 *   2. <cwd>/.claude/agents/*.md
 *   3. <cwd>/.pi/agents/*.md
 */
export function scanAgents(cwd: string): AgentDef[] {
	const dirs = [
		join(cwd, "agents"),
		join(cwd, ".claude", "agents"),
		join(cwd, ".pi", "agents"),
	];

	const agents: AgentDef[] = [];
	const seen = new Set<string>();

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (!file.endsWith(".md")) continue;
				const fullPath = resolve(dir, file);
				const def = parseAgentFile(fullPath);
				if (def && !seen.has(def.name.toLowerCase())) {
					seen.add(def.name.toLowerCase());
					agents.push(def);
				}
			}
		} catch {
			// Directory unreadable — skip silently.
		}
	}

	return agents;
}

// ─────────────────────────────────────────────────────────────────────────────
// teams.yaml
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal line-by-line parser for a teams.yaml file of the form:
 *
 *   team-alpha:
 *     - agent1
 *     - agent2
 *   team-beta:
 *     - agent3
 *
 * Returns a flat { teamName: [agentName, ...] } map. Lines that don't match
 * either pattern are ignored (so comments and blank lines are tolerated).
 */
export function parseTeamsYaml(raw: string): Record<string, string[]> {
	const teams: Record<string, string[]> = {};
	let current: string | null = null;
	for (const line of raw.split("\n")) {
		const teamMatch = line.match(/^(\S[^:]*):$/);
		if (teamMatch) {
			current = teamMatch[1].trim();
			teams[current] = [];
			continue;
		}
		const itemMatch = line.match(/^\s+-\s+(.+)$/);
		if (itemMatch && current) {
			teams[current].push(itemMatch[1].trim());
		}
	}
	return teams;
}

/**
 * Load `.pi/agents/teams.yaml` from the project root. Returns an empty object
 * if the file is missing or unreadable.
 */
export function loadTeamsYaml(cwd: string): Record<string, string[]> {
	const teamsPath = join(cwd, ".pi", "agents", "teams.yaml");
	if (!existsSync(teamsPath)) return {};
	try {
		return parseTeamsYaml(readFileSync(teamsPath, "utf-8"));
	} catch {
		return {};
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Task IDs and session directories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a stable, human-readable task id from a task description.
 *
 * The id is a slug (lowercase, dashes, max 40 chars) suffixed with a short
 * base-36 timestamp so two boots of the same task don't collide on disk.
 *
 * Example: `"Audit and fix security issues"` → `"audit-and-fix-security-issues-k3f2a1"`
 */
export function generateTaskId(task: string): string {
	const slug = task
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	const ts = Date.now().toString(36).slice(-6);
	return `${slug}-${ts}`;
}

/**
 * Create `.pi/agent-sessions/<taskId>/` if it doesn't exist and return the
 * absolute path. Idempotent — safe to call multiple times for the same id.
 */
export function ensureSessionDir(cwd: string, taskId: string): string {
	const dir = join(cwd, ".pi", "agent-sessions", taskId);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
	return dir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session directory resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the session directory for a given task id without creating it.
 *
 * Returns `{ sessionDir }` when `.pi/agent-sessions/<taskId>/` already
 * exists. Otherwise returns `{ error, available, sessionsRoot }` so the
 * caller can surface a clear "did you pass a workspace_id instead?"
 * message along with the list of valid task ids currently on disk.
 *
 * `sessionsRoot` is included on the error branch to preserve the existing
 * "No session directories exist under <path>" wording in callers without
 * forcing them to recompute the path layout.
 *
 * Input validation: an empty/whitespace `taskId` and any `taskId` that
 * contains a `/` or has a path component equal to `.` or `..` are rejected
 * up-front (without touching the filesystem beyond computing `sessionsRoot`)
 * and return the same error shape as a normal "not found" result. This
 * keeps `sessionDir` strictly under `.pi/agent-sessions/` by preventing
 * `.` (which `path.join` normalizes to the parent dir) and `..` (which
 * escapes upward) from being used as a task id. The directory listing in
 * the error branch is also guarded by a try/catch so a permissions failure
 * on the parent directory degrades to an empty `available` list rather than
 * throwing.
 */
export function resolveSessionDir(
	cwd: string,
	taskId: string,
): { sessionDir: string } | { error: string; available: string[]; sessionsRoot: string } {
	const sessionsRoot = join(cwd, ".pi", "agent-sessions");

	// Reject empty/whitespace taskId — no filesystem access beyond the
	// constant sessionsRoot path.
	if (!taskId || !taskId.trim()) {
		return { error: "session directory not found", available: [], sessionsRoot };
	}

	// Reject path-traversal/self-reference: any "/" in the taskId or any
	// path component equal to ".." or ".". Without this, "." collapses to
	// sessionsRoot (join normalizes it away) and ".." escapes upward — both
	// must be rejected to keep `sessionDir` strictly under sessionsRoot.
	if (taskId.includes("/") || taskId.split("/").some(p => p === ".." || p === ".")) {
		return { error: "session directory not found", available: [], sessionsRoot };
	}

	const sessionDir = join(sessionsRoot, taskId);
	if (existsSync(sessionDir)) {
		return { sessionDir };
	}
	let available: string[] = [];
	if (existsSync(sessionsRoot)) {
		try {
			available = readdirSync(sessionsRoot);
		} catch {
			// Parent directory unreadable — degrade to empty list.
			available = [];
		}
	}
	return { error: "session directory not found", available, sessionsRoot };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension path resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map a list of bare extension basenames to their absolute file paths under
 * `<cwd>/extensions/`. Missing extensions are skipped with a console warning
 * rather than failing the whole call — bootstrap should be resilient to
 * optional add-ons.
 *
 * Example: `resolveExtensionPaths("/proj", ["coms", "system-select"])`
 *   → `["/proj/extensions/coms.ts", "/proj/extensions/system-select.ts"]`
 */
export function resolveExtensionPaths(cwd: string, names: string[]): string[] {
	const extDir = join(cwd, "extensions");
	const result: string[] = [];
	for (const name of names) {
		const p = join(extDir, `${name}.ts`);
		if (existsSync(p)) {
			result.push(p);
		} else {
			console.warn(`[bootstrap-utils] extension not found: ${p}`);
		}
	}
	return result;
}
