#!/usr/bin/env bun
/**
 * Ralph Wiggum - Save Cycle Handoff
 *
 * Saves comprehensive handoff data to Memorai before a cycle ends.
 * This data is used to restore context when a new cycle starts.
 *
 * Includes filesystem-based fallback when memorai is unavailable.
 */

import { MemoraiClient, databaseExists } from "memorai";
import { mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import type { HandoffData } from "./types";

// Filesystem fallback directory (relative to cwd)
const HANDOFF_DIR = ".ralph-loop";

interface HandoffInput {
  session_id: string;
  cycle_number: number;
  original_objective: string;
  context_pct: number;
  accomplishments?: string[];
  blockers?: string[];
  next_actions?: string[];
  key_learnings?: string[];
}

/**
 * Save handoff data to filesystem as a fallback.
 * This ensures data is preserved even when memorai is unavailable.
 */
async function saveToFilesystem(handoff: HandoffData): Promise<boolean> {
  try {
    const handoffDir = join(process.cwd(), HANDOFF_DIR);

    // Create directory if it doesn't exist
    if (!existsSync(handoffDir)) {
      await mkdir(handoffDir, { recursive: true });
    }

    const filename = `handoff-cycle-${handoff.cycle_number}.json`;
    const filepath = join(handoffDir, filename);

    // Write handoff data with full context
    const fileData = {
      ...handoff,
      _metadata: {
        version: "1.0",
        source: "filesystem-fallback",
        saved_at: new Date().toISOString(),
      },
    };

    await writeFile(filepath, JSON.stringify(fileData, null, 2), "utf-8");

    // Also write a "latest" pointer file for easy retrieval
    const latestPath = join(handoffDir, "handoff-latest.json");
    await writeFile(latestPath, JSON.stringify(fileData, null, 2), "utf-8");

    return true;
  } catch (error) {
    console.error("Filesystem fallback save failed:", error);
    return false;
  }
}

async function saveHandoff(input: HandoffInput): Promise<void> {
  const handoff: HandoffData = {
    session_id: input.session_id,
    cycle_number: input.cycle_number,
    original_objective: input.original_objective,
    accomplishments: input.accomplishments || [],
    blockers: input.blockers || [],
    next_actions: input.next_actions || [],
    key_learnings: input.key_learnings || [],
    context_pct_at_save: input.context_pct,
    saved_at: new Date().toISOString(),
  };

  // ALWAYS save to filesystem first (fallback that works without memorai)
  const filesystemSaved = await saveToFilesystem(handoff);

  // Build handoff content for memorai
  const content = `## Cycle ${handoff.cycle_number} Handoff

### Original Objective
${handoff.original_objective}

### Accomplishments (Cycle ${handoff.cycle_number})
${handoff.accomplishments.length > 0
    ? handoff.accomplishments.map((a) => `- ${a}`).join("\n")
    : "- No accomplishments recorded"}

### Current Blockers
${handoff.blockers.length > 0
    ? handoff.blockers.map((b) => `- ${b}`).join("\n")
    : "- None"}

### Next Actions (Priority Order)
${handoff.next_actions.length > 0
    ? handoff.next_actions.map((a, i) => `${i + 1}. ${a}`).join("\n")
    : "1. Continue working on the task"}

### Key Learnings (Apply These!)
${handoff.key_learnings.length > 0
    ? handoff.key_learnings.map((l) => `- ${l}`).join("\n")
    : "- None yet"}

### Metadata
- Context at save: ${handoff.context_pct_at_save}%
- Saved at: ${handoff.saved_at}
`;

  // Try to save to Memorai if available (enhancement, not required)
  let memoraiSaved = false;
  if (databaseExists()) {
    let client: MemoraiClient;
    try {
      client = new MemoraiClient();

      await client.store({
        category: "notes",
        title: `Ralph Cycle ${handoff.cycle_number} Handoff`,
        content: content,
        tags: [
          "ralph",
          "cycle-handoff",
          `cycle-${handoff.cycle_number}`,
          handoff.session_id,
        ],
        importance: 9, // High importance for handoffs
        sessionId: handoff.session_id,
      });

      // Also store structured JSON for programmatic access
      await client.store({
        category: "notes",
        title: `Ralph Cycle ${handoff.cycle_number} Handoff Data (JSON)`,
        content: JSON.stringify(handoff, null, 2),
        tags: [
          "ralph",
          "cycle-handoff-json",
          `cycle-${handoff.cycle_number}`,
          handoff.session_id,
        ],
        importance: 8,
        sessionId: handoff.session_id,
      });

      memoraiSaved = true;
    } catch (error) {
      console.error("Memorai save failed (using filesystem fallback):", error);
    }
  }

  // Success if at least filesystem save worked
  if (filesystemSaved || memoraiSaved) {
    console.log(
      JSON.stringify({
        success: true,
        session_id: handoff.session_id,
        cycle: handoff.cycle_number,
        saved_at: handoff.saved_at,
        storage: {
          filesystem: filesystemSaved,
          memorai: memoraiSaved,
        },
      })
    );
  } else {
    console.error("Failed to save handoff to any storage");
    process.exit(1);
  }
}

// Collect data from Memorai for current session
async function collectSessionData(sessionId: string): Promise<{
  accomplishments: string[];
  blockers: string[];
  next_actions: string[];
  key_learnings: string[];
}> {
  const emptyResult = {
    accomplishments: [],
    blockers: [],
    next_actions: [],
    key_learnings: [],
  };

  // Wrap entire memorai access in try-catch for robustness
  try {
    if (!databaseExists()) {
      return emptyResult;
    }

    const client = new MemoraiClient();

  // Helper to normalize search results (handles both array and {results: []} formats)
  const normalizeResults = (results: any) =>
    Array.isArray(results) ? results : results?.results || [];

  // Query accomplishments
  const progressResults = await client.search({
    query: sessionId,
    tags: ["ralph", "progress"],
    limit: 20,
  });
  const accomplishments = normalizeResults(progressResults).map((r: any) => r.title);

  // Query failures/blockers
  const failureResults = await client.search({
    query: sessionId,
    tags: ["ralph", "failure"],
    limit: 10,
  });
  const blockers = normalizeResults(failureResults).map((r: any) => r.title);

  // Query learnings
  const learningResults = await client.search({
    query: sessionId,
    tags: ["ralph", "learning"],
    limit: 10,
  });
  const key_learnings = normalizeResults(learningResults).map((r: any) => r.title);

  // Get next actions from session state
  const stateResults = await client.search({
    query: sessionId,
    tags: ["ralph", "ralph-session-state"],
    limit: 1,
  });

  let next_actions: string[] = [];
  const stateArray = normalizeResults(stateResults);
  if (stateArray.length > 0) {
    try {
      const stateData = JSON.parse(stateArray[0].content);
      next_actions = stateData.next_actions || [];
    } catch {
      // Ignore parse errors
    }
  }

    return { accomplishments, blockers, next_actions, key_learnings };
  } catch (error) {
    // Memorai unavailable - return empty result (filesystem fallback still works)
    console.error("Memorai access failed in collectSessionData:", error);
    return emptyResult;
  }
}

// Main execution
async function main() {
  // Read input from stdin
  const chunks: string[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(new TextDecoder().decode(chunk));
  }
  const inputText = chunks.join("");

  if (!inputText.trim()) {
    console.error("No input provided");
    process.exit(1);
  }

  let input: HandoffInput;
  try {
    input = JSON.parse(inputText.trim());
  } catch (parseError) {
    console.error("Invalid JSON input:", parseError);
    process.exit(1);
  }

  // If accomplishments etc not provided, try to collect from Memorai
  if (!input.accomplishments || input.accomplishments.length === 0) {
    const collected = await collectSessionData(input.session_id);
    input.accomplishments = collected.accomplishments;
    input.blockers = collected.blockers;
    input.next_actions =
      input.next_actions && input.next_actions.length > 0
        ? input.next_actions
        : collected.next_actions;
    input.key_learnings = collected.key_learnings;
  }

  await saveHandoff(input);
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
