#!/usr/bin/env bun
/**
 * Ralph Wiggum - Transcript Analyzer
 *
 * Parses JSONL transcript files and extracts:
 * - Error patterns and repeated errors
 * - Files modified
 * - Test execution status
 * - Phase completion signals
 * - Meaningful change detection
 *
 * Usage: bun run analyze-transcript.ts <transcript_path>
 * Input: Optional JSON state via stdin
 * Output: TranscriptAnalysis JSON to stdout
 */

import { readFileSync } from "fs";
import type { TranscriptAnalysis, ErrorEntry, RepeatedError } from "./types";
import { ERROR_PATTERNS } from "./types";
import { MemoraiClient, search, storeMemory, databaseExists } from "memorai";

// Phase completion markers
const PHASE_PATTERNS = [
  { regex: /phase\s+(?:1|one|first)\s+(?:complete|done|finished)/i, label: "phase-1" },
  { regex: /phase\s+(?:2|two|second)\s+(?:complete|done|finished)/i, label: "phase-2" },
  { regex: /phase\s+(?:3|three|third)\s+(?:complete|done|finished)/i, label: "phase-3" },
  { regex: /implementation\s+(?:complete|done|finished)/i, label: "implementation" },
  { regex: /tests?\s+(?:all\s+)?pass(?:ing|ed)?/i, label: "tests-passing" },
  { regex: /refactor(?:ing)?\s+(?:complete|done|finished)/i, label: "refactoring" },
  { regex: /setup\s+(?:complete|done|finished)/i, label: "setup" },
];

// File modification patterns (from tool calls)
const FILE_PATTERNS = [
  { regex: /"tool":\s*"(?:Write|Edit|NotebookEdit)".*?"file_?path":\s*"([^"]+)"/g },
  { regex: /(?:Created|Updated|Modified|Wrote to|Edited)\s+(?:file\s+)?[`"]([^`"]+)[`"]/gi },
];

// Test execution patterns
const TEST_PATTERNS = {
  run: /(?:npm\s+test|bun\s+test|pytest|jest|vitest|cargo\s+test|go\s+test)/i,
  pass: /(?:tests?\s+passed|all\s+tests?\s+pass|0\s+fail|PASS\s|passed:\s*\d+.*failed:\s*0)/i,
  fail: /(?:tests?\s+failed|FAIL\s|failed:\s*[1-9]|error:.*test)/i,
};

interface TranscriptMessage {
  role: "user" | "assistant" | "system";
  message: {
    content: Array<{ type: string; text?: string; tool_use?: unknown }>;
  };
}

function parseTranscript(path: string): TranscriptMessage[] {
  const content = readFileSync(path, "utf-8");
  // Handle both LF and CRLF line endings
  const lines = content.trim().replace(/\r\n/g, "\n").split("\n").filter(Boolean);

  const messages: TranscriptMessage[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.role && parsed.message) {
        messages.push(parsed);
      }
    } catch {
      // Skip malformed lines
    }
  }

  return messages;
}

function extractTextContent(message: TranscriptMessage): string {
  if (!message.message?.content) return "";

  return message.message.content
    .filter((block) => block.type === "text" && block.text)
    .map((block) => block.text!)
    .join("\n");
}

function extractFullContent(message: TranscriptMessage): string {
  if (!message.message?.content) return "";

  // Include both text and stringified tool calls for pattern matching
  return message.message.content
    .map((block) => {
      if (block.type === "text" && block.text) return block.text;
      if (block.tool_use) return JSON.stringify(block.tool_use);
      return JSON.stringify(block);
    })
    .join("\n");
}

function findErrors(messages: TranscriptMessage[]): ErrorEntry[] {
  const errors: ErrorEntry[] = [];

  for (const msg of messages) {
    const content = extractFullContent(msg);

    for (const pattern of ERROR_PATTERNS) {
      const match = content.match(pattern.regex);
      if (match) {
        // Extract a sample (the matched text plus some context)
        const matchIndex = content.indexOf(match[0]);
        const start = Math.max(0, matchIndex - 20);
        const end = Math.min(content.length, matchIndex + match[0].length + 50);
        const sample = content.slice(start, end).replace(/\n/g, " ").trim();

        errors.push({
          pattern: pattern.label,
          sample: sample.length > 100 ? sample.slice(0, 100) + "..." : sample,
        });
      }
    }
  }

  return errors;
}

function findRepeatedErrors(errors: ErrorEntry[]): RepeatedError[] {
  const counts = new Map<string, number>();

  for (const error of errors) {
    counts.set(error.pattern, (counts.get(error.pattern) || 0) + 1);
  }

  return Array.from(counts.entries())
    .filter(([_, count]) => count >= 2)
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => b.count - a.count);
}

function findModifiedFiles(messages: TranscriptMessage[]): string[] {
  const files = new Set<string>();

  for (const msg of messages) {
    const content = extractFullContent(msg);

    for (const pattern of FILE_PATTERNS) {
      // Reset regex state for global patterns
      pattern.regex.lastIndex = 0;
      let match;
      while ((match = pattern.regex.exec(content)) !== null) {
        const filepath = match[1];
        // Filter out non-file paths
        if (filepath && !filepath.includes("undefined") && filepath.includes("/")) {
          files.add(filepath);
        }
      }
    }
  }

  return Array.from(files);
}

function detectTestStatus(messages: TranscriptMessage[]): {
  tests_run: boolean;
  tests_passed: boolean;
  tests_failed: boolean;
} {
  let tests_run = false;
  let tests_passed = false;
  let tests_failed = false;

  for (const msg of messages) {
    const content = extractFullContent(msg);

    if (TEST_PATTERNS.run.test(content)) {
      tests_run = true;
    }
    if (TEST_PATTERNS.pass.test(content)) {
      tests_passed = true;
    }
    if (TEST_PATTERNS.fail.test(content)) {
      tests_failed = true;
    }
  }

  return { tests_run, tests_passed, tests_failed };
}

function findPhaseCompletions(messages: TranscriptMessage[]): string[] {
  const phases = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;

    const content = extractTextContent(msg);

    for (const pattern of PHASE_PATTERNS) {
      if (pattern.regex.test(content)) {
        phases.add(pattern.label);
      }
    }
  }

  return Array.from(phases);
}

function detectMeaningfulChanges(
  filesModified: string[],
  testsRun: boolean,
  phaseCompletions: string[],
  messages?: TranscriptMessage[]
): boolean {
  // Consider changes meaningful if:
  // - Files were modified
  // - Tests were run
  // - Phase completions were detected
  if (filesModified.length > 0 || testsRun || phaseCompletions.length > 0) {
    return true;
  }

  // Also consider meaningful if assistant produced substantive output
  if (messages && messages.length > 0) {
    const lastAssistant = messages
      .filter((m) => m.role === "assistant")
      .pop();

    if (lastAssistant) {
      const content = lastAssistant.message.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text || "")
        .join("\n");

      // Substantive output: >500 chars OR contains code blocks
      const hasCodeBlock = /```[\s\S]+?```/.test(content);
      const isSubstantive = content.length > 500 || hasCodeBlock;

      if (isSubstantive) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Phase 2: Store significant error patterns to memorai for cross-session learning.
 * Only stores repeated errors (3+) which indicate patterns worth remembering.
 * Silently fails if memorai is not available.
 */
function storeErrorPatternsToMemorai(
  repeatedErrors: RepeatedError[],
  errors: ErrorEntry[],
  sessionId?: string
): void {
  try {
    if (!databaseExists()) {
      return;
    }

    // Only store if there are repeated errors (3+ occurrences)
    const significantErrors = repeatedErrors.filter((e) => e.count >= 3);
    if (significantErrors.length === 0) {
      return;
    }

    let client: MemoraiClient;
    try {
      client = new MemoraiClient();
    } catch {
      return; // Silently fail if client can't be initialized
    }

    for (const repeatedError of significantErrors) {
      // Get sample from the errors
      const sample = errors.find((e) => e.pattern === repeatedError.pattern);

      // Check if this error pattern was recently stored (avoid duplicates)
      const existing = client.search({
        query: repeatedError.pattern,
        tags: ["ralph", "error-pattern"],
        limit: 1,
      });

      // Only store if not recently stored or low relevance match
      if (existing.length === 0 || existing[0].relevance < 80) {
        client.store({
          category: "reports",
          title: `Repeated Error: ${repeatedError.pattern}`,
          content: `Error pattern occurred ${repeatedError.count} times in a single iteration.\n\nType: ${repeatedError.pattern}\nSample: ${sample?.sample || "N/A"}\n\nThis is a significant blocker that required recovery mode.`,
          tags: [
            "ralph",
            "error-pattern",
            repeatedError.pattern.toLowerCase().replace(/\s+/g, "-"),
          ],
          importance: repeatedError.count >= 5 ? 9 : 7, // Higher importance for very frequent errors
          sessionId,
        });
      }
    }
  } catch {
    // Silently fail - memorai integration is optional
  }
}

async function main() {
  const transcriptPath = process.argv[2];

  if (!transcriptPath) {
    console.error("Usage: bun run analyze-transcript.ts <transcript_path>");
    process.exit(1);
  }

  // Try to read optional state from stdin (for sessionId)
  let sessionId: string | undefined;
  try {
    const chunks: Buffer[] = [];
    const hasStdin = await Promise.race([
      (async () => {
        for await (const chunk of Bun.stdin.stream()) {
          chunks.push(chunk);
          return true;
        }
        return chunks.length > 0;
      })(),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);

    if (hasStdin && chunks.length > 0) {
      const inputText = Buffer.concat(chunks).toString("utf-8").trim();
      if (inputText) {
        const state = JSON.parse(inputText);
        sessionId = state.session_id || state.sessionId;
      }
    }
  } catch {
    // No stdin or invalid JSON - continue without sessionId
  }

  try {
    const messages = parseTranscript(transcriptPath);

    const errors = findErrors(messages);
    const repeated_errors = findRepeatedErrors(errors);
    const files_modified = findModifiedFiles(messages);
    const testStatus = detectTestStatus(messages);
    const phase_completions = findPhaseCompletions(messages);
    const meaningful_changes = detectMeaningfulChanges(
      files_modified,
      testStatus.tests_run,
      phase_completions,
      messages
    );

    // Phase 2: Store significant error patterns to memorai
    storeErrorPatternsToMemorai(repeated_errors, errors, sessionId);

    const analysis: TranscriptAnalysis = {
      errors,
      repeated_errors,
      files_modified,
      tests_run: testStatus.tests_run,
      tests_passed: testStatus.tests_passed,
      tests_failed: testStatus.tests_failed,
      phase_completions,
      meaningful_changes,
    };

    console.log(JSON.stringify(analysis, null, 2));
  } catch (error) {
    console.error("Error analyzing transcript:", error);
    process.exit(1);
  }
}

main();
