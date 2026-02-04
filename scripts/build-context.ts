#!/usr/bin/env bun
/**
 * Ralph Wiggum - Context Builder
 *
 * Builds the enhanced prompt with goal recitation for each iteration.
 * This is the core of "deliberate malloc" - carefully managing what
 * context is provided to maintain focus across iterations.
 *
 * Usage: echo '<input_json>' | bun run build-context.ts
 * Input: JSON with state, strategy, analysis, and session_id
 * Output: Formatted context string for the next iteration
 *
 * Memorai Integration:
 * - Queries memorai for session state (objective, status, learnings)
 * - Queries memorai for past session learnings relevant to the current objective
 * - No longer reads from RALPH_MEMORY.md
 */

import type {
  RalphState,
  RalphMemory,
  StrategyResult,
  TranscriptAnalysis,
} from "./types";
import { MemoraiClient, search, getMemoryById, databaseExists, type SearchResult } from "memorai";

interface ContextInput {
  state: RalphState & { session_id?: string };
  memory?: RalphMemory; // Optional - if not provided, queries memorai
  strategy: StrategyResult;
  analysis?: TranscriptAnalysis;
  nudge_content?: string;
  // Memorai configuration
  use_memorai?: boolean; // Enable/disable memorai queries (default: true)
  memorai_limit?: number; // Max memories to retrieve (default: 5)
}

interface PastLearning {
  title: string;
  summary: string;
  category: string;
  relevance: number;
}

interface SessionState {
  iteration: number;
  current_status: string;
  next_actions: string[];
  started_at: string;
  last_updated: string;
}

const DIVIDER = "═".repeat(50);
const SECTION_DIVIDER = "─".repeat(40);

const SESSION_OBJECTIVE_TAG = "ralph-session-objective";
const SESSION_STATE_TAG = "ralph-session-state";

/**
 * Query the session objective from memorai
 */
function querySessionObjective(client: MemoraiClient, sessionId: string): string | null {
  try {
    const results = client.search({
      query: sessionId,
      tags: ["ralph", SESSION_OBJECTIVE_TAG],
      limit: 1,
    });

    if (results.length > 0) {
      const memory = client.get(results[0].id, { full: true });
      if (memory && "content" in memory) {
        return memory.content;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Query the current session state from memorai
 */
function querySessionState(client: MemoraiClient, sessionId: string): SessionState | null {
  try {
    const results = client.search({
      query: sessionId,
      tags: ["ralph", SESSION_STATE_TAG],
      limit: 1,
    });

    if (results.length > 0) {
      const memory = client.get(results[0].id, { full: true });
      if (memory && "content" in memory) {
        return JSON.parse(memory.content);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Query learnings for this session
 */
function querySessionLearnings(client: MemoraiClient, sessionId: string): string[] {
  try {
    const results = client.search({
      query: sessionId,
      tags: ["ralph", "learning"],
      limit: 10,
    });

    return results
      .filter(r => r.title.startsWith("Ralph Learning:"))
      .map(r => r.title.replace("Ralph Learning: ", "").trim());
  } catch {
    return [];
  }
}

/**
 * Load memory from memorai, reconstructing RalphMemory structure
 */
function loadMemoryFromMemorai(
  client: MemoraiClient,
  sessionId: string
): RalphMemory | null {
  try {
    const objective = querySessionObjective(client, sessionId);
    const state = querySessionState(client, sessionId);
    const learnings = querySessionLearnings(client, sessionId);

    if (!objective && !state) {
      return null;
    }

    return {
      session_id: sessionId,
      started_at: state?.started_at || new Date().toISOString(),
      last_updated: state?.last_updated || new Date().toISOString(),
      current_iteration: state?.iteration || 0,
      original_objective: objective || "",
      current_status: state?.current_status || "",
      accomplished: [], // Not needed for context building
      failed_attempts: [], // Not needed for context building
      next_actions: state?.next_actions || [],
      key_learnings: learnings,
    };
  } catch {
    return null;
  }
}

/**
 * Query memorai for past session learnings relevant to the current objective.
 * Returns empty array if memorai is not available or no relevant memories found.
 *
 * Searches across all categories but prioritizes:
 * - decisions (what worked before)
 * - architecture (system design knowledge)
 * - reports (error patterns, analysis)
 * - summaries (session outcomes)
 */
function queryPastLearnings(
  client: MemoraiClient,
  objective: string,
  currentSessionId: string,
  limit: number = 5
): PastLearning[] {
  try {
    // Extract key words from objective (remove common words)
    const stopWords = new Set([
      "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
      "of", "with", "by", "from", "as", "is", "was", "are", "were", "been",
      "be", "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "must", "shall", "can", "need", "make", "build",
      "create", "implement", "add", "use", "using", "that", "this", "it"
    ]);

    const words = objective
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w))
      .slice(0, 5); // Take top 5 meaningful words

    if (words.length === 0) {
      return [];
    }

    // Use OR-style search by joining key words
    const query = words.join(" OR ");

    // Search across all categories with importance threshold
    const results = client.search({
      query,
      limit: limit + 5, // Get a few extra to filter
      importanceMin: 5,
    });

    // Also search specifically for ralph-tagged entries if any exist
    const ralphResults = client.search({
      query,
      tags: ["ralph"],
      limit: 3,
    });

    // Combine and deduplicate, excluding current session
    const combined = [...results, ...ralphResults];
    const seen = new Set<string>();
    const unique = combined.filter((r) => {
      if (seen.has(r.id)) return false;
      // Exclude entries from current session (we already have those)
      if (r.tags?.includes(currentSessionId)) return false;
      seen.add(r.id);
      return true;
    });

    // Sort by relevance and take top N
    unique.sort((a, b) => b.relevance - a.relevance);

    // Filter out low relevance results (< 20% relevance)
    const relevant = unique.filter((r) => r.relevance >= 20);

    return relevant.slice(0, limit).map((r) => ({
      title: r.title,
      summary: r.summary || "(no summary)",
      category: r.category,
      relevance: r.relevance,
    }));
  } catch {
    // Silently fail - memorai integration is optional
    return [];
  }
}

function buildContext(input: ContextInput): string {
  const { state, strategy } = input;
  const lines: string[] = [];

  // Determine session ID - require non-empty for memorai queries
  const sessionId = state.session_id || "";
  const hasValidSessionId = sessionId.length > 0;

  // Load memory from memorai if not provided and session ID exists
  let memory = input.memory;
  if (!memory && hasValidSessionId && databaseExists()) {
    try {
      const client = new MemoraiClient();
      memory = loadMemoryFromMemorai(client, sessionId);
    } catch {
      // Silently fail - continue without memorai data
    }
  }

  // Header with iteration
  lines.push(DIVIDER);
  lines.push(`   RALPH ITERATION ${state.iteration}`);
  lines.push(`   Strategy: ${strategy.strategy.toUpperCase()}`);
  lines.push(DIVIDER);
  lines.push("");

  // One-time nudge (if present)
  if (input.nudge_content) {
    lines.push("## PRIORITY INSTRUCTION (ONE-TIME)");
    lines.push("");
    lines.push(input.nudge_content);
    lines.push("");
    lines.push(SECTION_DIVIDER);
    lines.push("");
  }

  // Mission / Original Objective
  lines.push("## YOUR MISSION");
  lines.push("");
  if (memory?.original_objective) {
    lines.push(memory.original_objective);
  } else if (state.prompt_text) {
    lines.push(state.prompt_text);
  } else {
    lines.push("_No objective recorded_");
  }
  lines.push("");

  // Current Status
  if (memory?.current_status) {
    lines.push("## CURRENT STATUS");
    lines.push("");
    lines.push(memory.current_status);
    lines.push("");
  }

  // Next Actions
  if (memory?.next_actions && memory.next_actions.length > 0) {
    lines.push("## NEXT ACTIONS");
    lines.push("");
    for (let i = 0; i < Math.min(memory.next_actions.length, 5); i++) {
      lines.push(`${i + 1}. ${memory.next_actions[i]}`);
    }
    lines.push("");
  }

  // Strategy guidance
  lines.push("## STRATEGY GUIDANCE");
  lines.push("");
  lines.push(`_Phase: ${strategy.strategy} - ${strategy.reason}_`);
  lines.push("");
  for (const guidance of strategy.guidance) {
    lines.push(`- ${guidance}`);
  }
  lines.push("");

  // Key learnings (to avoid repeating mistakes)
  if (memory?.key_learnings && memory.key_learnings.length > 0) {
    lines.push("## KEY LEARNINGS");
    lines.push("");
    for (const learning of memory.key_learnings.slice(-5)) {
      lines.push(`- ${learning}`);
    }
    lines.push("");
  }

  // Memorai Integration: Past session learnings
  // Only query if: memorai enabled, database exists, and we have a valid session ID
  const useMemorAI = input.use_memorai !== false && databaseExists() && hasValidSessionId;
  const objective = memory?.original_objective || state.prompt_text || "";
  // Only query past learnings if we have a meaningful objective to search for
  if (useMemorAI && objective.trim().length > 0) {
    try {
      const client = new MemoraiClient();
      const pastLearnings = queryPastLearnings(
        client,
        objective,
        sessionId,
        input.memorai_limit ?? 5
      );

      if (pastLearnings.length > 0) {
        lines.push("## FROM PAST SESSIONS");
        lines.push("");
        lines.push("_Relevant knowledge from previous Ralph sessions:_");
        lines.push("");
        for (const learning of pastLearnings) {
          lines.push(`- **[${learning.category}]** ${learning.title}`);
          if (learning.summary && learning.summary !== "(no summary)") {
            lines.push(`  > ${learning.summary}`);
          }
        }
        lines.push("");
      }
    } catch {
      // Silently fail
    }
  }

  // Error context (if recent errors)
  if (input.analysis?.errors && input.analysis.errors.length > 0) {
    lines.push("## RECENT ERRORS (fix these!)");
    lines.push("");
    const uniqueErrors = [
      ...new Map(input.analysis.errors.map((e) => [e.pattern, e])).values(),
    ].slice(0, 3);
    for (const error of uniqueErrors) {
      lines.push(`- ${error.pattern}: ${error.sample}`);
    }
    lines.push("");
  }

  // Completion reminder
  if (state.completion_promise) {
    lines.push(SECTION_DIVIDER);
    lines.push("");
    lines.push(
      `**COMPLETION:** When done, output: \`<promise>${state.completion_promise}</promise>\``
    );
    lines.push("_Only output this when the statement is TRUE!_");
    lines.push("");
  }

  lines.push(DIVIDER);
  lines.push("");

  // Original prompt (the actual task)
  lines.push(state.prompt_text || "");

  return lines.join("\n");
}

async function main() {
  // Read input from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const inputText = Buffer.concat(chunks).toString("utf-8").trim();

  if (!inputText) {
    console.error("Usage: echo '<input_json>' | bun run build-context.ts");
    console.error(
      "Input: JSON with state, strategy, and optionally session_id"
    );
    process.exit(1);
  }

  try {
    const input: ContextInput = JSON.parse(inputText);

    if (!input.state || !input.strategy) {
      console.error("Input must contain 'state' and 'strategy' fields");
      process.exit(1);
    }

    const context = buildContext(input);
    console.log(context);
  } catch (error) {
    console.error("Error building context:", error);
    process.exit(1);
  }
}

main();
