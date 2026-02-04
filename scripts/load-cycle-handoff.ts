#!/usr/bin/env bun
/**
 * Ralph Wiggum - Load Cycle Handoff
 *
 * Loads the most recent handoff data from Memorai for a given session.
 * Used when starting a new cycle to restore context.
 */

import { MemoraiClient, databaseExists } from "memorai";
import type { HandoffData } from "./types";

interface LoadInput {
  session_id: string;
  cycle_number?: number; // Optional: load specific cycle, otherwise latest
}

interface LoadOutput {
  found: boolean;
  handoff?: HandoffData;
  formatted_context?: string;
  error?: string;
}

async function loadHandoff(input: LoadInput): Promise<LoadOutput> {
  if (!databaseExists()) {
    return {
      found: false,
      error: "Memorai database not found",
    };
  }

  let client: MemoraiClient;
  try {
    client = new MemoraiClient();
  } catch (error) {
    return {
      found: false,
      error: `Failed to initialize Memorai client: ${error}`,
    };
  }

  try {
    // Build search tags
    const tags = ["ralph", "cycle-handoff-json", input.session_id];
    if (input.cycle_number !== undefined) {
      tags.push(`cycle-${input.cycle_number}`);
    }

    // Search for handoff data
    const results = await client.search({
      query: input.session_id,
      tags: ["ralph", "cycle-handoff-json"],
      limit: 5,
    });

    // Filter for matching session AND cycle-handoff-json tag (must have both)
    // Note: client.search() returns the results array directly
    const matching = (Array.isArray(results) ? results : results.results || []).filter((r) =>
      r.tags?.includes(input.session_id) && r.tags?.includes("cycle-handoff-json")
    );

    if (matching.length === 0) {
      return {
        found: false,
        error: "No handoff found for session",
      };
    }

    // Sort by cycle number (highest first) if multiple
    const sorted = matching.sort((a, b) => {
      const cycleA = parseInt(
        a.tags?.find((t) => t.startsWith("cycle-"))?.replace("cycle-", "") ||
          "0"
      );
      const cycleB = parseInt(
        b.tags?.find((t) => t.startsWith("cycle-"))?.replace("cycle-", "") ||
          "0"
      );
      return cycleB - cycleA;
    });

    // Get full content using client.get()
    const fullEntry = client.get(sorted[0].id, { full: true });
    if (!fullEntry || !("content" in fullEntry)) {
      return {
        found: false,
        error: "Failed to retrieve full handoff content",
      };
    }

    // Parse the handoff data with error handling
    let handoff: HandoffData;
    try {
      handoff = JSON.parse(fullEntry.content);
    } catch (parseError) {
      return {
        found: false,
        error: `Failed to parse handoff data: ${parseError}`,
      };
    }

    // Build formatted context for injection
    const formattedContext = formatHandoffContext(handoff);

    return {
      found: true,
      handoff,
      formatted_context: formattedContext,
    };
  } catch (error) {
    return {
      found: false,
      error: `Failed to load handoff: ${error}`,
    };
  }
}

function formatHandoffContext(handoff: HandoffData): string {
  const nextCycle = handoff.cycle_number + 1;

  return `
## CYCLE CONTINUATION (Cycle ${nextCycle})

This is a CONTINUATION of a multi-cycle autonomous run.
Previous cycle (${handoff.cycle_number}) ended due to context limits.
Your session data was preserved - continue seamlessly.

### YOUR MISSION (UNCHANGED)
${handoff.original_objective}

### WHAT WAS ACCOMPLISHED (Previous Cycles)
${handoff.accomplishments.length > 0
    ? handoff.accomplishments.map((a) => `- ${a}`).join("\n")
    : "- Work in progress"}

### CURRENT BLOCKERS TO ADDRESS
${handoff.blockers.length > 0
    ? handoff.blockers.map((b) => `- ${b}`).join("\n")
    : "- None identified"}

### NEXT ACTIONS (Continue Here)
${handoff.next_actions.length > 0
    ? handoff.next_actions.map((a, i) => `${i + 1}. ${a}`).join("\n")
    : "1. Continue working on the original objective"}

### KEY LEARNINGS (Apply These!)
${handoff.key_learnings.length > 0
    ? handoff.key_learnings.map((l) => `- ${l}`).join("\n")
    : "- None yet"}

---
*Handoff from cycle ${handoff.cycle_number} at ${handoff.saved_at}*
*Previous context usage: ${handoff.context_pct_at_save}%*
`;
}

// Also load any recent learnings from past Ralph sessions
async function loadPastLearnings(
  objective: string,
  limit: number = 3
): Promise<string[]> {
  if (!databaseExists()) {
    return [];
  }

  const client = new MemoraiClient();

  try {
    const results = await client.search({
      query: objective,
      tags: ["ralph", "learning"],
      limit: limit,
    });

    const resultsArray = Array.isArray(results) ? results : results.results || [];
    return resultsArray.map((r) => r.title);
  } catch {
    return [];
  }
}

// Main execution
async function main() {
  // Read input from stdin or use args
  let input: LoadInput;

  if (process.argv.length > 2) {
    // Session ID passed as argument
    input = {
      session_id: process.argv[2],
      cycle_number:
        process.argv.length > 3 ? parseInt(process.argv[3]) : undefined,
    };
  } else {
    // Read from stdin
    const chunks: string[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(new TextDecoder().decode(chunk));
    }
    const inputText = chunks.join("");

    if (!inputText.trim()) {
      console.error("No input provided. Usage: load-cycle-handoff.ts SESSION_ID [CYCLE]");
      process.exit(1);
    }

    try {
      input = JSON.parse(inputText.trim());
    } catch {
      // Treat as session ID
      input = { session_id: inputText.trim() };
    }
  }

  const result = await loadHandoff(input);

  // If handoff found, also try to get past learnings
  if (result.found && result.handoff) {
    const pastLearnings = await loadPastLearnings(
      result.handoff.original_objective
    );
    if (pastLearnings.length > 0) {
      result.formatted_context += `
### FROM PAST RALPH SESSIONS
${pastLearnings.map((l) => `- ${l}`).join("\n")}
`;
    }
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
