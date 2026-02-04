#!/usr/bin/env bun
/**
 * Ralph Wiggum - Strategy Engine
 *
 * Determines the current strategy based on:
 * - Iteration count (explore -> focused -> cleanup phases)
 * - Error patterns (recovery mode when stuck)
 * - Progress velocity
 *
 * Usage: echo '<state_json>' | bun run strategy-engine.ts
 * Input: JSON containing current state and transcript analysis
 * Output: StrategyResult JSON to stdout
 */

import type {
  Strategy,
  StrategyResult,
  RalphState,
  TranscriptAnalysis,
} from "./types";

interface StrategyInput {
  state: RalphState;
  analysis: TranscriptAnalysis;
}

// Strategy thresholds
const EXPLORE_END = 10;
const FOCUSED_END = 35;
const REPEATED_ERROR_THRESHOLD = 3;
const STUCK_THRESHOLD = 5;

function determineBaseStrategy(iteration: number): Strategy {
  if (iteration <= EXPLORE_END) {
    return "explore";
  } else if (iteration <= FOCUSED_END) {
    return "focused";
  } else {
    return "cleanup";
  }
}

function getStrategyGuidance(strategy: Strategy, context: StrategyInput): string[] {
  const guidance: string[] = [];

  switch (strategy) {
    case "explore":
      guidance.push("Explore the problem space broadly");
      guidance.push("Try different approaches to understand the task");
      guidance.push("Don't commit to a single solution yet");
      guidance.push("Document what you learn for later iterations");
      break;

    case "focused":
      guidance.push("Commit to the best approach identified during exploration");
      guidance.push("Implement incrementally with tests");
      guidance.push("If stuck on an approach, pivot quickly");
      guidance.push("Track progress against milestones");
      break;

    case "cleanup":
      guidance.push("Focus on finishing incomplete work");
      guidance.push("Fix remaining bugs and edge cases");
      guidance.push("Ensure all tests pass");
      guidance.push("Prepare final deliverables");
      guidance.push("Time is limited - prioritize ruthlessly");
      break;

    case "recovery":
      guidance.push("STOP and analyze what's going wrong");
      guidance.push("Review failed attempts in memory");
      guidance.push("Try a fundamentally different approach");
      const repeatedErrors = context.analysis.repeated_errors || [];
      if (repeatedErrors.length > 0) {
        const topError = repeatedErrors[0];
        guidance.push(`Focus on fixing: ${topError.pattern} (${topError.count} occurrences)`);
      }
      guidance.push("Consider simplifying the problem");
      break;
  }

  return guidance;
}

function determineStrategy(input: StrategyInput): StrategyResult {
  const { state, analysis } = input;
  const iteration = state.iteration;
  const currentStrategy = state.strategy?.current || "explore";

  // Check for recovery conditions
  const repeatedErrors = analysis.repeated_errors || [];
  const hasRepeatedErrors = repeatedErrors.some(
    (e) => e.count >= REPEATED_ERROR_THRESHOLD
  );
  const stuckCount = state.progress?.stuck_count ?? 0;
  const isStuck = stuckCount >= STUCK_THRESHOLD;
  const noMeaningfulChanges = !analysis.meaningful_changes;

  // Recovery takes precedence
  if (hasRepeatedErrors || isStuck) {
    // Safe access: find the first error that meets the threshold
    const topError = repeatedErrors.find((e) => e.count >= REPEATED_ERROR_THRESHOLD);
    const reason = hasRepeatedErrors && topError
      ? `Detected ${topError.count}x repeated "${topError.pattern}" errors`
      : `Stuck for ${stuckCount} iterations without meaningful progress`;

    return {
      strategy: "recovery",
      reason,
      action: currentStrategy === "recovery" ? "continue" : "switch",
      guidance: getStrategyGuidance("recovery", input),
    };
  }

  // Determine phase-based strategy
  const baseStrategy = determineBaseStrategy(iteration);

  // Check if we need to switch
  const shouldSwitch = baseStrategy !== currentStrategy && currentStrategy !== "recovery";

  let reason: string;
  if (shouldSwitch) {
    switch (baseStrategy) {
      case "explore":
        reason = `Iteration ${iteration}: Exploration phase (iterations 1-${EXPLORE_END})`;
        break;
      case "focused":
        reason = `Iteration ${iteration}: Focused implementation phase (iterations ${EXPLORE_END + 1}-${FOCUSED_END})`;
        break;
      case "cleanup":
        reason = `Iteration ${iteration}: Cleanup phase (iterations ${FOCUSED_END + 1}+)`;
        break;
      default:
        reason = `Iteration ${iteration}: Continuing ${baseStrategy} phase`;
    }
  } else {
    reason = `Continuing ${baseStrategy} phase (iteration ${iteration})`;
  }

  // Add velocity context
  if (analysis.meaningful_changes) {
    reason += " - making progress";
  } else if (noMeaningfulChanges && iteration > 1) {
    reason += " - no meaningful changes detected, consider adjusting approach";
  }

  return {
    strategy: baseStrategy,
    reason,
    action: shouldSwitch ? "switch" : "continue",
    guidance: getStrategyGuidance(baseStrategy, input),
  };
}

async function main() {
  // Read input from stdin with timeout protection
  let inputText = "";
  try {
    const chunks: Buffer[] = [];
    const stdinPromise = (async () => {
      for await (const chunk of Bun.stdin.stream()) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf-8").trim();
    })();

    // Timeout after 5 seconds to prevent hangs
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("stdin timeout")), 5000)
    );

    inputText = await Promise.race([stdinPromise, timeoutPromise]);
  } catch (error) {
    console.error("Error reading stdin:", error);
    // Output default strategy on error
    console.log(JSON.stringify({
      strategy: "explore",
      reason: "Default (stdin error)",
      action: "continue",
      guidance: ["Continue working on the task"]
    }));
    process.exit(0);
  }

  if (!inputText) {
    console.error("Usage: echo '<state_json>' | bun run strategy-engine.ts");
    console.error("Input should be JSON with 'state' and 'analysis' fields");
    // Output default on empty input
    console.log(JSON.stringify({
      strategy: "explore",
      reason: "Default (no input)",
      action: "continue",
      guidance: ["Continue working on the task"]
    }));
    process.exit(0);
  }

  try {
    const input: StrategyInput = JSON.parse(inputText);

    // Validate required fields
    if (!input.state || !input.analysis) {
      console.error("Input must contain 'state' and 'analysis' fields");
      console.log(JSON.stringify({
        strategy: "explore",
        reason: "Default (invalid input)",
        action: "continue",
        guidance: ["Continue working on the task"]
      }));
      process.exit(0);
    }

    // Provide defaults for missing state fields
    // Use nullish coalescing to preserve 0 as valid iteration
    input.state.iteration = input.state.iteration ?? 1;
    // Type guard: ensure iteration is a valid number (not a string, NaN, etc.)
    if (typeof input.state.iteration !== 'number' || isNaN(input.state.iteration)) {
      input.state.iteration = 1;
    }
    input.state.strategy = input.state.strategy || { current: "explore", changed_at: 0 };
    input.state.progress = input.state.progress || {
      stuck_count: 0,
      velocity: "normal",
      last_meaningful_change: 0,
    };

    // Provide defaults for analysis
    input.analysis.repeated_errors = input.analysis.repeated_errors || [];
    input.analysis.meaningful_changes = input.analysis.meaningful_changes ?? true;

    const result = determineStrategy(input);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error("Error processing input:", error);
    // Output default on parse error
    console.log(JSON.stringify({
      strategy: "explore",
      reason: "Default (parse error)",
      action: "continue",
      guidance: ["Continue working on the task"]
    }));
    process.exit(0);
  }
}

main();
