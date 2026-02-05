# ralph-loop - Autonomous Loop Runner for Claude Code

## SESSION INITIALIZATION (mandatory)

Read these files at the start of EVERY session before doing anything:
1. `LAST_SESSION.md` - previous session continuity
2. `TODO.md` - current priorities and remaining items
3. `BACKLOG.md` - long-term items

---

## CRITICAL RULES (non-negotiable)

These rules override everything else. Violations are unacceptable.

### 1. Agent workflow discipline (PROTECT YOUR CONTEXT WINDOW)
Your context window is a precious, finite resource. Every file you read, every grep result, every tool output consumes it irreversibly. **Delegate aggressively to agents.**

**Default behavior:** Before doing ANY investigation, exploration, code reading, or multi-step analysis yourself, ask: "Can an agent do this instead?" If yes, spawn one. If multiple independent investigations are needed, spawn multiple agents **in parallel** in a single message.

**Rules:**
- **ALWAYS use `model: "opus"` for agents.** No exceptions. Never use haiku or sonnet for agents.
- **NEVER read files directly** to "understand the codebase" or "investigate an issue." Spawn an Explore agent instead.
- **NEVER run grep/glob yourself** for open-ended searches. Spawn an agent.
- **Spawn agents in parallel** when tasks are independent. One message, multiple Task tool calls.
- **Your main context is for:** coordinating agents, making decisions based on their results, writing code, and talking to the user. NOT for accumulating raw file contents or search results.
- **When a task has 2+ investigation steps**, spawn an agent for each step in parallel rather than doing them sequentially yourself.

**Anti-patterns (violations):**
- Reading 5 files yourself to "understand" something -> should be one Explore agent
- Running grep, reading the matches, running more greps -> should be one agent
- Investigating a bug by reading multiple files yourself -> one agent
- Any chain of Read/Grep/Glob that exceeds 3 calls -> you should have used an agent

**The litmus test:** If you're about to make your 3rd Read/Grep/Glob call on a single investigation thread, STOP. You should have spawned an agent.

### 2. Test changes before committing
Always verify bash syntax with `bash -n ralph-loop.sh` after making changes. Test new flags with `--dry-run` when possible.

### 3. Preserve backward compatibility
New flags and features should not break existing workflows. Default behavior must remain unchanged unless explicitly requested.

---

## Architecture

| Component | Tech | Notes |
|-----------|------|-------|
| Main Script | Bash | `ralph-loop.sh` - autonomous loop runner |
| Intelligence Layer | Bun + TypeScript | `scripts/` - optional enhanced features |
| State Storage | Filesystem | `.ralph-loop/` directory |
| Output Format | JSON (agent) / Streaming (human) | `--agent` flag switches modes |

---

## Key Files

| File | Purpose |
|------|---------|
| `ralph-loop.sh` | Main entry point - all loop logic |
| `scripts/build-context.ts` | Intelligence layer - context construction |
| `scripts/analyze-transcript.ts` | Transcript analysis for errors/status |
| `scripts/select-strategy.ts` | Dynamic strategy selection |
| `scripts/save-cycle-handoff.ts` | Cycle handoff to memorai |
| `scripts/load-cycle-handoff.ts` | Load handoff from memorai |
| `.ralph-loop/status.json` | Runtime state for agent monitoring |
| `.ralph-loop/nudge.md` | User nudge injection point |

---

## Commands

```bash
# Basic usage
./ralph-loop.sh "Your prompt here"

# Agent mode (for automation/monitoring)
./ralph-loop.sh "prompt" --agent --max-iterations 10

# Supervisor mode (multi-cycle with context management)
./ralph-loop.sh "prompt" --supervisor --context-threshold 150000

# Testing
./ralph-loop.sh "prompt" --dry-run          # Show what would be sent without invoking claude
./ralph-loop.sh "prompt" --no-intelligence  # Disable intelligence layer for debugging

# Syntax verification
bash -n ralph-loop.sh
```

---

## Status JSON Fields

When running in `--agent` mode, `.ralph-loop/status.json` contains:

| Field | Description |
|-------|-------------|
| `status` | RUNNING, PAUSED, COMPLETE, ERROR, INTERRUPTED |
| `iteration` | Current iteration number |
| `error_count` | Transcript-analysis errors |
| `api_error_count` | API-level errors (timeouts, auth, rate limits) |
| `last_api_error` | Last API error message |
| `total_input_tokens` | Cumulative input tokens (including cache) |
| `total_output_tokens` | Cumulative output tokens |
| `total_cost_usd` | Cumulative cost |
| `summary` | Last iteration summary |

---

## Environment

- Requires: `bash`, `jq`, `claude` CLI
- Optional: `bun` + `scripts/` directory for intelligence layer
- Optional: `memorai` for supervisor mode handoff persistence
