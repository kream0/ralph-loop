# ralph-loop.sh

A standalone bash script that runs Claude Code in an autonomous [Ralph Wiggum](https://ghuntley.com/ralph/) loop with an optional intelligence layer. No plugins needed — just a bash loop that feeds the same prompt to `claude` repeatedly until the task is done.

**With the intelligence layer** (bun + scripts/): adaptive strategies, memorai memory, transcript analysis, context-aware prompts, and supervisor mode for context cycling. **Without it**: gracefully degrades to basic loop behavior.

## Usage

```bash
./ralph-loop.sh "<prompt>" [OPTIONS]
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `-m`, `--max-iterations N` | Safety cap on iterations | unlimited |
| `-c`, `--completion-promise TEXT` | Phrase Claude outputs when done | `TASK_COMPLETE` |
| `-y`, `--yolo` | Bypass all permission checks | off |
| `-a`, `--agent` | Agent mode: minimal stdout, full logs to disk | off |
| `-h`, `--help` | Show help | — |

### Intelligence Layer Options (requires `bun` + `scripts/`)

| Flag | Description | Default |
|------|-------------|---------|
| `--supervisor` | Enable multi-cycle operation (context cycling) | off |
| `--max-cycles N` | Max cycles in supervisor mode | 10 |
| `--context-threshold N` | Context % that triggers new cycle | 60 |
| `--nudge "TEXT"` | Write a nudge for the next iteration, then exit | — |

### Examples

```bash
# Basic — loops until Claude signals done
./ralph-loop.sh "Fix the authentication bug in auth.ts"

# With safety cap
./ralph-loop.sh "Refactor the API layer" -m 10

# With custom completion promise
./ralph-loop.sh "Add unit tests for all services" -m 20 -c TESTS_PASS

# Agent mode — for master Claude agents (minimal context window growth)
./ralph-loop.sh "Fix all bugs" -m 10 -a

# Agent mode with intelligence + supervisor (context cycling)
./ralph-loop.sh "Build the feature" --agent --supervisor --max-cycles 5

# Send a nudge to a running loop (from another terminal)
./ralph-loop.sh --nudge "Focus on the API endpoints next"
```

## How It Works

1. Each iteration runs `claude -p "<wrapped-prompt>" --continue`
2. `--continue` means Claude picks up its previous session — it sees all file changes from prior iterations
3. The script wraps your prompt with Ralph loop instructions (iteration count, verification protocol, promise format)
4. When Claude outputs `<promise>TASK_COMPLETE</promise>`, the loop exits successfully
5. Ctrl+C stops gracefully with an iteration summary

## Intelligence Layer

When `bun` and the `scripts/` directory are available, the loop activates adaptive strategies, memorai memory, transcript analysis, context-aware prompts, and supervisor mode. All 9 TypeScript files in `scripts/`:

| Script | Purpose |
|--------|---------|
| `types.ts` | Shared type definitions (RalphState, AnalysisResult, StrategyResult, etc.) |
| `strategy-engine.ts` | Adaptive strategy selection (explore/focused/cleanup/recovery) with type guards |
| `analyze-transcript.ts` | Detects errors, file changes, test status, meaningful progress from output |
| `build-context.ts` | Builds rich prompts with goal recitation, strategy guidance, learnings |
| `update-memory.ts` | Stores progress, failures, and learnings in memorai for cross-session recall |
| `generate-summary.ts` | Generates RALPH_SUMMARY.md at all exit points (completion, max iterations, interrupt) |
| `save-cycle-handoff.ts` | Saves state to memorai before context limit for supervisor cycling |
| `load-cycle-handoff.ts` | Restores handoff state at the start of a new supervisor cycle |
| `parse-json-output.ts` | Parses Claude JSON output for token metrics and context usage %, with value clamping |

### Graceful Degradation

If `bun` is not installed, `scripts/` is missing, or `memorai` is not available, the loop falls back to basic mode automatically:

- No adaptive strategies -- uses a static prompt wrapper instead
- No memorai memory -- no cross-session recall
- No transcript analysis -- no error/progress detection
- No supervisor cycling -- `--supervisor` requires the intelligence layer
- The core Ralph loop (repeated `claude -p --continue`) still works identically

No configuration needed -- it just works.

### Strategy Phases

| Phase | Iterations | Behavior |
|-------|-----------|----------|
| **Explore** | 1–10 | Broadly explore the problem space |
| **Focused** | 11–35 | Commit to best approach, implement incrementally |
| **Cleanup** | 36+ | Fix remaining bugs, ensure tests pass |
| **Recovery** | (auto) | Triggered by repeated errors or stuck detection |

### Nudge System

Send a one-time priority instruction to the next iteration:

```bash
# From another terminal while the loop is running
./ralph-loop.sh --nudge "Focus on the API endpoints next"
```

The nudge is injected once into the next iteration's prompt, then automatically consumed.

## Agent Mode (`--agent` / `-a`)

Designed for when a master Claude Code agent runs this script via its Bash tool. Reduces context window growth by ~99%.

**Requires:** `jq` (`apt install jq`)

### What changes in agent mode

| Aspect | Human mode | Agent mode |
|--------|-----------|------------|
| Claude's full output | Piped to stdout via `tee` | Saved to disk only |
| Per-iteration stdout | ~5,000 tokens | ~40 tokens (one status line) |
| Colors/decorations | ANSI colors, box-drawing | None |
| Output format | Plain text | `--output-format json` |
| Prompt on iter 2+ | Full protocol repeated | Minimal 1-line nudge |
| Logs | None | `.ralph-loop/<timestamp>/` |
| Leash integration | None | `status.json` updated per iteration |
| Intelligence pipeline | Strategy in header | Full analysis + memory + strategy |

### What the master agent sees

```
[ITER 1/10] WORKING | explore | 0err | Explored codebase, found bug in auth.ts:42 | promise=none
[ITER 2/10] WORKING | focused | 0err | Fixed auth.ts, 2 tests still failing | promise=none
[ITER 3/10] COMPLETE | focused | 0err | All 15 tests passing | promise=DETECTED
[RALPH DONE] status=COMPLETE iterations=3 log_dir=.ralph-loop/20260204_083000 strategy=focused cost_usd=0.0420
```

### Log directory structure

```
.ralph-loop/
  20260204_083000/
    run-config.json          # Frozen run parameters
    iteration-1.json         # Full JSON response from claude
    iteration-1.txt          # Extracted text-only result
    iteration-1.stderr       # CLI warnings/errors
    summary.log              # One status line per iteration
    status.json              # Live-updated for Leash monitoring
    RALPH_SUMMARY.md         # Post-loop summary (with intelligence layer)
```

### Reading full logs after a run

```bash
# View what Claude did on iteration 2
cat .ralph-loop/20260204_083000/iteration-2.txt

# View all status lines
cat .ralph-loop/20260204_083000/summary.log

# Check cost and token usage
cat .ralph-loop/20260204_083000/status.json

# Read the post-loop summary
cat .ralph-loop/20260204_083000/RALPH_SUMMARY.md
```

## Supervisor Mode (`--supervisor`)

Enables multi-cycle operation for long-running tasks that would exceed Claude's context window.

```bash
./ralph-loop.sh "Build the entire feature" --agent --supervisor --max-cycles 5 --context-threshold 60
```

When context usage exceeds the threshold (default: 60%):
1. Current state is saved to memorai via handoff
2. A new Claude session starts (fresh context window)
3. Handoff data is injected into the first prompt of the new cycle
4. Work continues seamlessly

## Robustness

The script includes defensive measures to prevent silent failures:

- **Argument validation:** All flags that require values (`--max-iterations`, `--max-cycles`, `--context-threshold`, `--completion-promise`, `--nudge`) emit clear errors if the value is missing.
- **Numeric validation:** `--max-iterations`, `--max-cycles`, and `--context-threshold` are validated as positive integers before the loop starts.
- **JSON escaping:** All values written to `status.json` and `run-config.json` are escaped via `jq`, preventing broken JSON from special characters in prompts or summaries.
- **Agent mode status line truncation:** Summary text in status lines is capped at 200 characters to prevent context window bloat in the master agent.
- **RUN_DIR creation validation:** The script exits with an error if the log directory cannot be created.
- **Token value clamping:** `parse-json-output.ts` clamps token values to prevent nonsensical percentages from malformed Claude responses.
- **Strategy engine type guards:** `strategy-engine.ts` validates input shapes before processing, falling back to defaults on unexpected data.
- **Agent mode [STATUS] line resilience:** If Claude does not emit a `[STATUS]` line, the script falls back to extracting the last non-empty line of output instead of crashing.
- **set +e around claude calls:** The `claude` CLI invocation is wrapped in `set +e` / `set -e` so that non-zero exit codes (e.g., from timeouts or API errors) do not terminate the loop prematurely.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Completion promise detected — task done |
| `1` | Max iterations or max cycles reached without completion |
| `130` | Interrupted by Ctrl+C |

## Requirements

| Dependency | Required for | Install |
|-----------|-------------|---------|
| `claude` CLI | Core loop | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) |
| `jq` | Agent mode (`--agent`) | `apt install jq` |
| `bun` | Intelligence layer | [bun.sh](https://bun.sh) |
| `memorai` | Intelligence layer (memory) | `file:../../../memorai` (see Setup) |

## Setup

### Basic (no intelligence layer)

Just run the script -- requires `claude` CLI on PATH. If using `--agent`, also requires `jq`.

### With Intelligence Layer

```bash
cd ralph-loop/scripts
bun install
```

**memorai dependency:** The `scripts/package.json` references memorai via a relative path (`file:../../../memorai`). This means memorai must be cloned/available at `../../../memorai` relative to the `scripts/` directory. Adjust the path in `package.json` if your layout differs.

You also need memorai initialized in your project:

```bash
memorai init
```

## Run From Your Project Directory

The script should be run from the root of whatever project you want Claude to work on:

```bash
cd /path/to/my-project
~/.claude/scripts/ralph-loop.sh "Fix all failing tests" -m 15
```

## The Ralph Wiggum Technique

The core idea (by Geoffrey Huntley): feed the same prompt to an AI agent in a loop. Each iteration, the agent sees its own previous work in the filesystem and git history, building incrementally toward completion. The "self-referential" aspect comes from files, not from piping output back as input.

```
prompt → claude works → exits → same prompt again → sees previous work → iterates → done
```
