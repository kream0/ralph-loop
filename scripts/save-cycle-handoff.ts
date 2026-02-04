#!/usr/bin/env bun
/**
 * Ralph Wiggum - Save Cycle Handoff
 *
 * Saves comprehensive handoff data to Memorai before a cycle ends.
 * This data is used to restore context when a new cycle starts.
 */

import { MemoraiClient, databaseExists } from "memorai";
import type { HandoffData } from "./types";

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

async function saveHandoff(input: HandoffInput): Promise<void> {
  if (!databaseExists()) {
    console.error("Memorai database not found. Run: memorai init");
    process.exit(1);
  }

  let client: MemoraiClient;
  try {
    client = new MemoraiClient();
  } catch (error) {
    console.error("Failed to initialize Memorai client:", error);
    process.exit(1);
  }

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

  // Build handoff content
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

  // Store in Memorai with specific tags for retrieval
  try {
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

    console.log(
      JSON.stringify({
        success: true,
        session_id: handoff.session_id,
        cycle: handoff.cycle_number,
        saved_at: handoff.saved_at,
      })
    );
  } catch (error) {
    console.error("Failed to save handoff:", error);
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
  if (!databaseExists()) {
    return {
      accomplishments: [],
      blockers: [],
      next_actions: [],
      key_learnings: [],
    };
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
