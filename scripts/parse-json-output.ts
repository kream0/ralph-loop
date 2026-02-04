#!/usr/bin/env bun
/**
 * Ralph Wiggum - Parse JSON Output
 *
 * Parses the JSON output from `claude -p --output-format json`
 * Extracts response text and token metrics for context tracking.
 */

import type { ParsedJsonOutput, TokenMetrics } from "./types";

interface ClaudeJsonResponse {
  type: string;
  subtype: string;
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  result: string;
  session_id: string;
  total_cost_usd: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  modelUsage?: {
    [model: string]: {
      inputTokens: number;
      outputTokens: number;
      contextWindow: number;
      costUSD: number;
    };
  };
}

function parseJsonOutput(rawJson: string): ParsedJsonOutput {
  try {
    const response: ClaudeJsonResponse = JSON.parse(rawJson);

    // Extract token counts from usage or modelUsage
    let inputTokens = 0;
    let outputTokens = 0;
    let contextWindow = 200000; // Default for Opus/Sonnet

    // Clamp a token value: must be a non-negative integer within safe integer range
    const clampTokens = (v: unknown): number => {
      const n = Number(v) || 0;
      return Math.max(0, Math.min(n, Number.MAX_SAFE_INTEGER));
    };

    // Primary source: usage field
    if (response.usage) {
      inputTokens = clampTokens(response.usage.input_tokens) +
                    clampTokens(response.usage.cache_creation_input_tokens) +
                    clampTokens(response.usage.cache_read_input_tokens);
      outputTokens = clampTokens(response.usage.output_tokens);
    }

    // Secondary source: modelUsage (more detailed, overrides usage if present)
    if (response.modelUsage) {
      // Sum across all models used (usually just one primary model)
      let modelInputTokens = 0;
      let modelOutputTokens = 0;
      for (const modelData of Object.values(response.modelUsage)) {
        modelInputTokens += clampTokens(modelData.inputTokens);
        modelOutputTokens += clampTokens(modelData.outputTokens);
        contextWindow = clampTokens(modelData.contextWindow) || contextWindow;
      }
      // Use modelUsage totals if they're higher (more accurate source)
      if (modelInputTokens > 0 || modelOutputTokens > 0) {
        inputTokens = Math.max(inputTokens, modelInputTokens);
        outputTokens = Math.max(outputTokens, modelOutputTokens);
      }
    }

    const totalTokens = inputTokens + outputTokens;
    const contextPctRaw = contextWindow > 0
      ? Math.round((totalTokens / contextWindow) * 10000) / 100  // 2 decimal places
      : 0;
    const contextPct = Math.max(0, Math.min(contextPctRaw, 100));

    const tokens: TokenMetrics = {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      context_window: contextWindow,
      context_pct: contextPct,
    };

    return {
      text: response.result || "",
      tokens,
      session_id: response.session_id || "",
      duration_ms: response.duration_ms || 0,
      cost_usd: response.total_cost_usd || 0,
    };
  } catch (error) {
    // If parsing fails, return safe defaults
    console.error("Failed to parse JSON output:", error);
    return {
      text: rawJson, // Return raw output as text
      tokens: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        context_window: 200000,
        context_pct: 0,
      },
      session_id: "",
      duration_ms: 0,
      cost_usd: 0,
    };
  }
}

// Main execution
async function main() {
  // Read from stdin or file argument
  let input = "";

  if (process.argv.length > 2) {
    // Read from file
    const filePath = process.argv[2];
    input = await Bun.file(filePath).text();
  } else {
    // Read from stdin
    const chunks: string[] = [];
    for await (const chunk of Bun.stdin.stream()) {
      chunks.push(new TextDecoder().decode(chunk));
    }
    input = chunks.join("");
  }

  if (!input.trim()) {
    console.error("No input provided");
    process.exit(1);
  }

  const parsed = parseJsonOutput(input.trim());

  // Output as JSON for consumption by bash/other scripts
  console.log(JSON.stringify(parsed, null, 2));
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
