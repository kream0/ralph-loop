#!/usr/bin/env bun
/**
 * Ralph Wiggum - Memory Manager
 *
 * Updates session memory in Memorai (sole source of truth).
 * No longer uses RALPH_MEMORY.md - all data persisted to memorai.
 *
 * Usage: echo '<input_json>' | bun run update-memory.ts
 * Input: JSON with state, analysis, and optional iteration summary
 * Output: Session status JSON
 */

import type { RalphMemory, RalphState, TranscriptAnalysis } from "./types";
import { MemoraiClient, storeMemory, search, getMemoryById, updateMemory as memoraiUpdate, databaseExists } from "memorai";

interface MemoryInput {
  state: RalphState;
  analysis: TranscriptAnalysis;
  iteration_summary?: string;
  next_actions?: string[];
  learnings?: string[];
}

interface SessionState {
  iteration: number;
  current_status: string;
  next_actions: string[];
  started_at: string;
  last_updated: string;
}

const SESSION_OBJECTIVE_TAG = "ralph-session-objective";
const SESSION_STATE_TAG = "ralph-session-state";

/**
 * Generate a unique session ID
 */
function generateSessionId(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 6);
  return `ralph-${timestamp}-${random}`;
}

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
      // Get full content
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
 * Query past learnings for this session
 */
function querySessionLearnings(client: MemoraiClient, sessionId: string): string[] {
  try {
    const results = client.search({
      query: sessionId,
      tags: ["ralph", "learning"],
      limit: 20,
    });

    return results
      .filter(r => r.title.startsWith("Ralph Learning:"))
      .map(r => r.title.replace("Ralph Learning: ", "").trim());
  } catch {
    return [];
  }
}

/**
 * Store or update the session objective (only on first iteration)
 */
function storeSessionObjective(
  client: MemoraiClient,
  sessionId: string,
  objective: string
): void {
  // Check if already exists
  const existing = querySessionObjective(client, sessionId);
  if (existing) {
    return; // Never update objective
  }

  client.store({
    category: "architecture",
    title: `Ralph Session: ${objective.slice(0, 50)}...`,
    content: objective,
    tags: ["ralph", SESSION_OBJECTIVE_TAG, sessionId],
    importance: 9,
    sessionId,
  });
}

/**
 * Store or update the session state
 */
function storeSessionState(
  client: MemoraiClient,
  sessionId: string,
  state: SessionState,
  stateMemoryId?: string
): string | undefined {
  const content = JSON.stringify(state);

  if (stateMemoryId) {
    // Update existing
    client.update(stateMemoryId, {
      content,
    });
    return stateMemoryId;
  }

  // Create new
  const result = client.store({
    category: "notes",
    title: `Ralph State: ${sessionId}`,
    content,
    tags: ["ralph", SESSION_STATE_TAG, sessionId],
    importance: 5,
    sessionId,
  });

  return result.id;
}

/**
 * Find the memory ID of the current session state
 */
function findSessionStateId(client: MemoraiClient, sessionId: string): string | undefined {
  try {
    const results = client.search({
      query: sessionId,
      tags: ["ralph", SESSION_STATE_TAG],
      limit: 1,
    });
    return results.length > 0 ? results[0].id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Store progress/accomplishments to memorai
 */
function storeAccomplishment(
  client: MemoraiClient,
  sessionId: string,
  iteration: number,
  description: string
): void {
  client.store({
    category: "reports",
    title: `Ralph Progress: ${description.slice(0, 50)}`,
    content: `Session: ${sessionId}\nIteration: ${iteration}\n\n${description}`,
    tags: ["ralph", `iteration-${iteration}`, "progress", sessionId],
    importance: 5,
    sessionId,
  });
}

/**
 * Store failure to memorai
 */
function storeFailure(
  client: MemoraiClient,
  sessionId: string,
  iteration: number,
  description: string,
  learning?: string
): void {
  const errorType = learning || "unknown";
  client.store({
    category: "reports",
    title: `Ralph Failed: ${description.slice(0, 50)}`,
    content: `Session: ${sessionId}\nIteration: ${iteration}\n\nWhat failed: ${description}${learning ? `\n\nLearning: ${learning}` : ""}`,
    tags: ["ralph", `iteration-${iteration}`, "failure", errorType.toLowerCase().replace(/\s+/g, "-"), sessionId],
    importance: 6,
    sessionId,
  });
}

/**
 * Store learning to memorai (with deduplication)
 */
function storeLearning(
  client: MemoraiClient,
  sessionId: string,
  iteration: number,
  learning: string
): void {
  // Check if this learning is already stored (simple dedup)
  const existing = client.search({
    query: learning,
    tags: ["ralph", "learning"],
    limit: 1,
  });

  if (existing.length === 0 || existing[0].relevance < 90) {
    client.store({
      category: "decisions",
      title: `Ralph Learning: ${learning.slice(0, 50)}`,
      content: `Session: ${sessionId}\nIteration: ${iteration}\n\n${learning}`,
      tags: ["ralph", `iteration-${iteration}`, "learning", sessionId],
      importance: 7,
      sessionId,
    });
  }
}

/**
 * Summarize progress for accomplishment description
 */
function summarizeProgress(input: MemoryInput): string {
  const parts: string[] = [];

  if (input.analysis.files_modified.length > 0) {
    parts.push(`Modified ${input.analysis.files_modified.length} file(s)`);
  }

  if (input.analysis.tests_run) {
    if (input.analysis.tests_passed) {
      parts.push("tests passing");
    } else if (input.analysis.tests_failed) {
      parts.push("tests failing");
    } else {
      parts.push("tests run");
    }
  }

  if (input.analysis.phase_completions && input.analysis.phase_completions.length > 0) {
    parts.push(`completed: ${input.analysis.phase_completions.join(", ")}`);
  }

  return parts.length > 0 ? parts.join("; ") : "Made progress";
}

/**
 * Load existing memory from memorai, reconstructing RalphMemory structure
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
      return null; // New session
    }

    // Query accomplishments
    const accomplishmentResults = client.search({
      query: sessionId,
      tags: ["ralph", "progress"],
      limit: 20,
    });
    const accomplished = accomplishmentResults
      .filter(r => r.title.startsWith("Ralph Progress:"))
      .map(r => {
        const iterMatch = r.tags.find(t => t.startsWith("iteration-"));
        const iteration = iterMatch ? parseInt(iterMatch.replace("iteration-", "")) : 0;
        return {
          iteration,
          description: r.title.replace("Ralph Progress: ", ""),
        };
      })
      .sort((a, b) => a.iteration - b.iteration);

    // Query failures
    const failureResults = client.search({
      query: sessionId,
      tags: ["ralph", "failure"],
      limit: 20,
    });
    const failed_attempts = failureResults
      .filter(r => r.title.startsWith("Ralph Failed:"))
      .map(r => {
        const iterMatch = r.tags.find(t => t.startsWith("iteration-"));
        const iteration = iterMatch ? parseInt(iterMatch.replace("iteration-", "")) : 0;
        // Extract learning from summary if available
        const learningMatch = r.summary?.match(/Learning: (.+)$/);
        return {
          iteration,
          description: r.title.replace("Ralph Failed: ", ""),
          learning: learningMatch?.[1],
        };
      })
      .sort((a, b) => a.iteration - b.iteration);

    return {
      session_id: sessionId,
      started_at: state?.started_at || new Date().toISOString(),
      last_updated: state?.last_updated || new Date().toISOString(),
      current_iteration: state?.iteration || 0,
      original_objective: objective || "",
      current_status: state?.current_status || "",
      accomplished,
      failed_attempts,
      next_actions: state?.next_actions || [],
      key_learnings: learnings,
    };
  } catch {
    return null;
  }
}

/**
 * Update memory in memorai
 */
function updateMemory(
  client: MemoraiClient,
  existing: RalphMemory | null,
  input: MemoryInput,
  providedSessionId?: string
): RalphMemory {
  const now = new Date().toISOString();
  const iteration = input.state.iteration;

  // Determine session ID - prefer existing, then provided, then generate new
  let sessionId: string;
  let isNewSession = false;

  if (existing) {
    sessionId = existing.session_id;
  } else if (providedSessionId) {
    sessionId = providedSessionId;
    isNewSession = true;
  } else {
    sessionId = generateSessionId();
    isNewSession = true;
  }

  // Initialize new memory structure
  const memory: RalphMemory = existing || {
    session_id: sessionId,
    started_at: input.state.started_at || now,
    last_updated: now,
    current_iteration: iteration,
    original_objective: input.state.prompt_text || "",
    current_status: input.iteration_summary || "Session started",
    accomplished: [],
    failed_attempts: [],
    next_actions: input.next_actions || [],
    key_learnings: [],
  };

  // Update fields
  memory.last_updated = now;
  memory.current_iteration = iteration;

  if (input.iteration_summary) {
    memory.current_status = input.iteration_summary;
  }

  if (input.next_actions && input.next_actions.length > 0) {
    memory.next_actions = input.next_actions;
  }

  // Store to memorai
  try {
    // Store objective on first iteration
    if (isNewSession || iteration === 1) {
      storeSessionObjective(client, sessionId, memory.original_objective);
    }

    // Find existing state memory ID for update
    const stateId = findSessionStateId(client, sessionId);

    // Store/update session state
    const state: SessionState = {
      iteration: memory.current_iteration,
      current_status: memory.current_status,
      next_actions: memory.next_actions,
      started_at: memory.started_at,
      last_updated: memory.last_updated,
    };
    storeSessionState(client, sessionId, state, stateId);

    // Store accomplishment if meaningful changes
    if (input.analysis.meaningful_changes) {
      const description = summarizeProgress(input);
      storeAccomplishment(client, sessionId, iteration, description);
      memory.accomplished.push({ iteration, description });
    }

    // Store failure if errors without progress
    if (input.analysis.errors.length > 0 && !input.analysis.meaningful_changes) {
      const description = `Encountered ${input.analysis.errors.length} error(s)`;
      const learning = input.analysis.errors[0]?.pattern;
      storeFailure(client, sessionId, iteration, description, learning);
      memory.failed_attempts.push({ iteration, description, learning });
    }

    // Store new learnings
    if (input.learnings) {
      for (const learning of input.learnings) {
        if (!memory.key_learnings.includes(learning)) {
          storeLearning(client, sessionId, iteration, learning);
          memory.key_learnings.push(learning);
        }
      }
    }
  } catch (error) {
    console.error("Warning: Failed to store to memorai:", error);
    // Continue anyway - memory object is still valid for this iteration
  }

  // Keep lists manageable
  const MAX_ITEMS = 20;
  if (memory.accomplished.length > MAX_ITEMS) {
    memory.accomplished = memory.accomplished.slice(-MAX_ITEMS);
  }
  if (memory.failed_attempts.length > MAX_ITEMS) {
    memory.failed_attempts = memory.failed_attempts.slice(-MAX_ITEMS);
  }
  if (memory.key_learnings.length > MAX_ITEMS) {
    memory.key_learnings = memory.key_learnings.slice(-MAX_ITEMS);
  }

  return memory;
}

async function main() {
  // Read input from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  const inputText = Buffer.concat(chunks).toString("utf-8").trim();

  if (!inputText) {
    console.error("Usage: echo '<input_json>' | bun run update-memory.ts");
    console.error("Input: JSON with state, analysis, and optional iteration_summary, next_actions, learnings");
    process.exit(1);
  }

  try {
    const input: MemoryInput = JSON.parse(inputText);

    if (!input.state || !input.analysis) {
      console.error("Input must contain 'state' and 'analysis' fields");
      process.exit(1);
    }

    // Check memorai availability
    if (!databaseExists()) {
      console.error("Error: Memorai database not found. Run: memorai init");
      process.exit(1);
    }

    let client: MemoraiClient;
    try {
      client = new MemoraiClient();
    } catch (initError) {
      console.error("Error: Failed to initialize Memorai client:", initError);
      process.exit(1);
    }

    // Try to get session ID from state or generate new one
    // The session_id should be passed in the state from setup-ralph-loop.sh
    const sessionId = (input.state as RalphState & { session_id?: string }).session_id || generateSessionId();

    // Load existing memory from memorai
    const existing = loadMemoryFromMemorai(client, sessionId);

    // Update memory - pass sessionId to preserve it even if no existing memory found
    const updated = updateMemory(client, existing, input, sessionId);

    // Output summary
    console.log(
      JSON.stringify({
        session_id: updated.session_id,
        iteration: updated.current_iteration,
        accomplished_count: updated.accomplished.length,
        failed_count: updated.failed_attempts.length,
        learnings_count: updated.key_learnings.length,
        status: "updated",
        storage: "memorai",
      })
    );
  } catch (error) {
    console.error("Error updating memory:", error);
    process.exit(1);
  }
}

main();
