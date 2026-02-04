#!/usr/bin/env bun
/**
 * Ralph Wiggum - Post-Loop Summary Generator
 *
 * Generates a comprehensive summary when the loop ends.
 * Analyzes the full session data from memorai to provide insights.
 *
 * Usage: bun run generate-summary.ts [output_path]
 * Input: JSON via stdin with session_id, completion_reason, final_iteration
 * Output: RALPH_SUMMARY.md file
 */

import { writeFileSync } from "fs";
import { MemoraiClient, search, getMemoryById, storeMemory, databaseExists } from "memorai";

interface SummaryInput {
  session_id: string;
  completion_reason?: "promise" | "max_iterations" | "cancelled" | "error";
  final_iteration?: number;
  original_objective?: string;
}

interface SessionState {
  iteration: number;
  current_status: string;
  next_actions: string[];
  started_at: string;
  last_updated: string;
}

interface SessionData {
  objective: string;
  state: SessionState | null;
  accomplishments: string[];
  failures: string[];
  learnings: string[];
}

const DEFAULT_OUTPUT_PATH = ".claude/RALPH_SUMMARY.md";
const SESSION_OBJECTIVE_TAG = "ralph-session-objective";
const SESSION_STATE_TAG = "ralph-session-state";

/**
 * Load all session data from memorai
 */
function loadSessionFromMemorai(
  client: MemoraiClient,
  sessionId: string
): SessionData {
  const data: SessionData = {
    objective: "",
    state: null,
    accomplishments: [],
    failures: [],
    learnings: [],
  };

  try {
    // Get objective
    const objectiveResults = client.search({
      query: sessionId,
      tags: ["ralph", SESSION_OBJECTIVE_TAG],
      limit: 1,
    });
    if (objectiveResults.length > 0) {
      const memory = client.get(objectiveResults[0].id, { full: true });
      if (memory && "content" in memory) {
        data.objective = memory.content;
      }
    }

    // Get state
    const stateResults = client.search({
      query: sessionId,
      tags: ["ralph", SESSION_STATE_TAG],
      limit: 1,
    });
    if (stateResults.length > 0) {
      const memory = client.get(stateResults[0].id, { full: true });
      if (memory && "content" in memory) {
        data.state = JSON.parse(memory.content);
      }
    }

    // Get accomplishments
    const accomplishmentResults = client.search({
      query: sessionId,
      tags: ["ralph", "progress"],
      limit: 20,
    });
    data.accomplishments = accomplishmentResults
      .filter(r => r.title.startsWith("Ralph Progress:"))
      .map(r => r.title.replace("Ralph Progress: ", "").trim());

    // Get failures
    const failureResults = client.search({
      query: sessionId,
      tags: ["ralph", "failure"],
      limit: 20,
    });
    data.failures = failureResults
      .filter(r => r.title.startsWith("Ralph Failed:"))
      .map(r => r.title.replace("Ralph Failed: ", "").trim());

    // Get learnings
    const learningResults = client.search({
      query: sessionId,
      tags: ["ralph", "learning"],
      limit: 20,
    });
    data.learnings = learningResults
      .filter(r => r.title.startsWith("Ralph Learning:"))
      .map(r => r.title.replace("Ralph Learning: ", "").trim());
  } catch {
    // Return partial data on error
  }

  return data;
}

function determineOutcome(
  sessionData: SessionData,
  reason: string
): { emoji: string; label: string; description: string } {
  const accomplishments = sessionData.accomplishments.length;
  const failures = sessionData.failures.length;

  if (reason === "promise") {
    return {
      emoji: "✅",
      label: "COMPLETED",
      description: "Loop ended successfully via completion promise",
    };
  }

  if (reason === "cancelled") {
    return {
      emoji: "⏹️",
      label: "CANCELLED",
      description: "Loop was manually cancelled",
    };
  }

  if (reason === "max_iterations") {
    if (accomplishments > failures) {
      return {
        emoji: "⚠️",
        label: "PARTIAL",
        description: "Max iterations reached with partial progress",
      };
    }
    return {
      emoji: "❌",
      label: "INCOMPLETE",
      description: "Max iterations reached without completion",
    };
  }

  if (reason === "error") {
    return {
      emoji: "💥",
      label: "ERROR",
      description: "Loop terminated due to error",
    };
  }

  if (reason === "context_threshold") {
    return {
      emoji: "🔄",
      label: "CYCLING",
      description: "Context limit reached - run /ralph-resume to continue",
    };
  }

  return {
    emoji: "❓",
    label: "UNKNOWN",
    description: "Loop ended for unknown reason",
  };
}

/**
 * Store session summary to memorai for cross-session learning.
 */
function storeSummaryToMemorai(
  client: MemoraiClient,
  input: SummaryInput,
  sessionData: SessionData,
  outcome: { emoji: string; label: string; description: string }
): void {
  try {
    const sessionId = input.session_id;
    const objective = input.original_objective || sessionData.objective || "Unknown objective";

    // Build summary content
    const accomplishmentsText = sessionData.accomplishments.length > 0
      ? sessionData.accomplishments.map(a => `- ${a}`).join("\n")
      : "_None_";
    const learningsText = sessionData.learnings.length > 0
      ? sessionData.learnings.map(l => `- ${l}`).join("\n")
      : "_None_";
    const failuresText = sessionData.failures.length > 0
      ? sessionData.failures.map(f => `- ${f}`).join("\n")
      : "_None_";

    const content = [
      `# Ralph Session Complete: ${outcome.label}`,
      "",
      `**Outcome:** ${outcome.description}`,
      `**Iterations:** ${input.final_iteration || "Unknown"}`,
      "",
      "## Original Objective",
      objective,
      "",
      "## Accomplishments",
      accomplishmentsText,
      "",
      "## Key Learnings",
      learningsText,
      "",
      "## Failed Attempts",
      failuresText,
    ].join("\n");

    // Determine importance based on outcome
    let importance = 7;
    if (outcome.label === "COMPLETED") {
      importance = 9;
    } else if (outcome.label === "ERROR" || outcome.label === "INCOMPLETE") {
      importance = 8;
    }

    // Build tags based on outcome
    const tags = [
      "ralph",
      "session-summary",
      `outcome-${outcome.label.toLowerCase()}`,
      sessionId,
    ];

    if (input.completion_reason) {
      tags.push(`reason-${input.completion_reason}`);
    }

    client.store({
      category: "summaries",
      title: `Ralph Session: ${outcome.label} - ${objective.slice(0, 40)}...`,
      content,
      tags,
      importance,
      sessionId,
    });
  } catch {
    // Silently fail
  }
}

function generateSummary(
  client: MemoraiClient,
  input: SummaryInput
): string {
  const sessionData = loadSessionFromMemorai(client, input.session_id);

  const completionReason = input.completion_reason || "unknown";
  const outcome = determineOutcome(sessionData, completionReason);

  // Store summary to memorai for cross-session learning
  storeSummaryToMemorai(client, input, sessionData, outcome);

  const lines: string[] = [];

  // Header
  lines.push(`# Ralph Session Summary ${outcome.emoji}`);
  lines.push("");
  lines.push(`_Generated: ${new Date().toISOString()}_`);
  lines.push(`_Session ID: ${input.session_id}_`);
  lines.push("");

  // Outcome box
  lines.push("## Outcome");
  lines.push("");
  lines.push(`**Status:** ${outcome.label}`);
  lines.push(`**Reason:** ${outcome.description}`);
  if (input.final_iteration) {
    lines.push(`**Total Iterations:** ${input.final_iteration}`);
  }
  lines.push("");

  // Original objective
  if (sessionData.objective || input.original_objective) {
    lines.push("## Original Objective");
    lines.push("");
    lines.push(sessionData.objective || input.original_objective || "");
    lines.push("");
  }

  // Final status
  if (sessionData.state?.current_status) {
    lines.push("## Final Status");
    lines.push("");
    lines.push(sessionData.state.current_status);
    lines.push("");
  }

  // Accomplishments
  lines.push("## Accomplishments");
  lines.push("");
  if (sessionData.accomplishments.length === 0) {
    lines.push("_No accomplishments recorded_");
  } else {
    for (const item of sessionData.accomplishments) {
      lines.push(`- ${item}`);
    }
  }
  lines.push("");

  // Statistics
  lines.push("## Statistics");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Iterations | ${input.final_iteration || "Unknown"} |`);
  lines.push(`| Accomplishments | ${sessionData.accomplishments.length} |`);
  lines.push(`| Failed Attempts | ${sessionData.failures.length} |`);
  lines.push(`| Learnings | ${sessionData.learnings.length} |`);
  lines.push("");

  // Key learnings
  if (sessionData.learnings.length > 0) {
    lines.push("## Key Learnings");
    lines.push("");
    for (const learning of sessionData.learnings) {
      lines.push(`- ${learning}`);
    }
    lines.push("");
  }

  // Recommendations for next session
  lines.push("## Recommendations for Next Session");
  lines.push("");

  if (outcome.label === "COMPLETED") {
    lines.push("- Review the implemented solution for edge cases");
    lines.push("- Consider adding tests if not already present");
    lines.push("- Document any API changes or new features");
  } else if (outcome.label === "PARTIAL" || outcome.label === "INCOMPLETE") {
    lines.push("- Review failed attempts to avoid repeating mistakes");
    lines.push("- Consider breaking the task into smaller subtasks");
    lines.push("- Check if the original objective needs refinement");
    if (sessionData.failures.length > 3) {
      lines.push("- Multiple failures suggest the approach may need rethinking");
    }
  } else if (outcome.label === "CANCELLED") {
    lines.push("- Determine if the task is still needed");
    lines.push("- Consider what prompted the cancellation");
    lines.push("- Review partial progress before starting again");
  }
  lines.push("");

  // Footer
  lines.push("---");
  lines.push("");
  lines.push("_This summary was auto-generated by Ralph Wiggum._");
  lines.push("_Session data stored in Memorai for cross-session learning._");
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const outputPath = process.argv[2] || DEFAULT_OUTPUT_PATH;

  // Check memorai availability
  if (!databaseExists()) {
    console.error("Error: Memorai database not found. Cannot generate summary.");
    process.exit(1);
  }

  const client = new MemoraiClient();

  // Read input from stdin
  let input: SummaryInput = { session_id: "" };

  try {
    const chunks: Buffer[] = [];
    // Use a timeout to check if there's stdin data
    const hasStdin = await Promise.race([
      (async () => {
        for await (const chunk of Bun.stdin.stream()) {
          chunks.push(chunk);
          return true;
        }
        return chunks.length > 0;
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);

    if (hasStdin && chunks.length > 0) {
      const inputText = Buffer.concat(chunks).toString("utf-8").trim();
      if (inputText) {
        input = { ...input, ...JSON.parse(inputText) };
      }
    }
  } catch {
    // No stdin or invalid JSON
  }

  if (!input.session_id) {
    console.error("Error: session_id is required in input JSON");
    process.exit(1);
  }

  try {
    const summary = generateSummary(client, input);
    writeFileSync(outputPath, summary);

    console.log(
      JSON.stringify({
        path: outputPath,
        status: "generated",
        outcome: input.completion_reason || "unknown",
        session_id: input.session_id,
        storage: "memorai",
      })
    );
  } catch (error) {
    console.error("Error generating summary:", error);
    process.exit(1);
  }
}

main();
