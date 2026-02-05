#!/usr/bin/env bash
set -euo pipefail

# ralph-loop.sh — Ralph Wiggum loop for Claude Code with rw2 intelligence layer
# Runs `claude` CLI repeatedly with adaptive strategies, memorai memory,
# transcript analysis, and optional supervisor mode for context cycling.
#
# Graceful degradation: works without bun/scripts (falls back to basic mode).
#
# Usage:
#   ./ralph-loop.sh "Fix the auth bug" --max-iterations 10
#   ./ralph-loop.sh "Add unit tests" -m 20 -c TESTS_PASS -a
#   ./ralph-loop.sh "Refactor the API layer" --agent --supervisor

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ── Defaults ────────────────────────────────────────────────────────────────
PROMPT=""
MAX_ITERATIONS=0  # 0 = unlimited
COMPLETION_PROMISE="TASK_COMPLETE"
PERMISSION_MODE="acceptEdits"  # acceptEdits | bypassPermissions
AGENT_MODE=false
ITERATION=0
TMPFILE=""
RUN_DIR=""
TOTAL_COST=0
TOTAL_INPUT_TOKENS=0
TOTAL_OUTPUT_TOKENS=0
RUN_STARTED_AT=""

# ── Intelligence Layer Variables ────────────────────────────────────────────
SCRIPTS_DIR="$(cd "$(dirname "$0")" && pwd)/scripts"
INTELLIGENCE_AVAILABLE=false
SESSION_ID=""
CURRENT_STRATEGY="explore"
STUCK_COUNT=0
ERROR_COUNT=0
API_ERROR_COUNT=0
LAST_API_ERROR=""
CONTEXT_PCT=0
LAST_ANALYSIS_JSON=""
LAST_STRATEGY_JSON=""

# ── Supervisor Variables ────────────────────────────────────────────────────
SUPERVISOR_MODE=false
MAX_CYCLES=10
CONTEXT_THRESHOLD=60
CYCLE_NUMBER=1
TOTAL_ITERATIONS_ALL_CYCLES=0
CONTINUE_FLAG=false  # First iteration has no prior conversation to continue

# ── User Override Flags ────────────────────────────────────────────────────
NO_INTELLIGENCE_FLAG=false
DRY_RUN=false
FORCE_STREAMING=false

# ── Child Process Tracking ──────────────────────────────────────────────────
CLAUDE_PID=""

# ── Intelligence Detection ──────────────────────────────────────────────────
if command -v bun &>/dev/null && [[ -d "$SCRIPTS_DIR" ]] && [[ -f "$SCRIPTS_DIR/types.ts" ]]; then
    INTELLIGENCE_AVAILABLE=true
fi

# ── Usage ───────────────────────────────────────────────────────────────────
usage() {
    cat <<'USAGE'
ralph-loop.sh — Run Claude Code in an autonomous Ralph Wiggum loop

Usage:
  ./ralph-loop.sh <PROMPT> [OPTIONS]

Arguments:
  PROMPT                          The task for Claude (required, first positional arg)

Options:
  -m, --max-iterations <N>        Max iterations before auto-stop (default: unlimited)
  -c, --completion-promise <TEXT>  Promise phrase to signal completion (default: TASK_COMPLETE)
  -y, --yolo                      Bypass ALL permission checks (full autonomy)
  -a, --agent                     Agent mode: minimal stdout, full logs to disk (for master agents)
  -h, --help                      Show this help message

Intelligence Layer Options (requires bun + scripts/):
  --supervisor                    Enable multi-cycle operation (context cycling)
  --max-cycles <N>                Max cycles in supervisor mode (default: 10)
  --context-threshold <N>         Context % that triggers new cycle (default: 60)
  --nudge <TEXT>                  Write a nudge for next iteration, then exit
  --no-intelligence               Disable intelligence layer (for debugging/benchmarking)
  --dry-run                       Show what would be sent to claude without invoking it

Output Options:
  --force-streaming               Force TTY streaming mode even without a TTY (human mode)

Permission modes:
  Default: --permission-mode acceptEdits (auto-accepts file edits)
  With -y: --dangerously-skip-permissions (bypasses everything)

Agent mode (--agent):
  Designed for master Claude agents to run with minimal context window growth.
  Full output logged to .ralph-loop/<timestamp>/ on disk.
  Only ~40-token status lines emitted to stdout per iteration.
  Requires: jq

Intelligence layer:
  When bun and scripts/ are available, enables adaptive strategies, memorai
  memory, transcript analysis, and context-aware prompts. Without these,
  falls back to basic loop behavior.

Examples:
  ./ralph-loop.sh "Fix the authentication bug in auth.ts" --max-iterations 10
  ./ralph-loop.sh "Add unit tests for all services" -m 20 -c TESTS_PASS
  ./ralph-loop.sh "Refactor the cache layer" --agent -m 10
  ./ralph-loop.sh "Build the feature" --agent --supervisor --max-cycles 5
  ./ralph-loop.sh --nudge "Focus on the API endpoints next"
  ./ralph-loop.sh "Test the auth flow" --dry-run
USAGE
}

# ── Argument Parsing ────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
    case "$1" in
        -m|--max-iterations)
            if [[ -z "${2:-}" ]]; then
                echo "Error: $1 requires a value" >&2
                exit 1
            fi
            MAX_ITERATIONS="$2"
            shift 2
            ;;
        -c|--completion-promise)
            if [[ -z "${2:-}" ]]; then
                echo "Error: $1 requires a value" >&2
                exit 1
            fi
            COMPLETION_PROMISE="$2"
            shift 2
            ;;
        -y|--yolo)
            PERMISSION_MODE="bypassPermissions"
            shift
            ;;
        -a|--agent)
            AGENT_MODE=true
            shift
            ;;
        --supervisor)
            SUPERVISOR_MODE=true
            shift
            ;;
        --max-cycles)
            if [[ -z "${2:-}" ]]; then
                echo "Error: $1 requires a value" >&2
                exit 1
            fi
            MAX_CYCLES="$2"
            shift 2
            ;;
        --context-threshold)
            if [[ -z "${2:-}" ]]; then
                echo "Error: $1 requires a value" >&2
                exit 1
            fi
            CONTEXT_THRESHOLD="$2"
            shift 2
            ;;
        --nudge)
            if [[ -z "${2:-}" ]]; then
                echo "Error: $1 requires a value" >&2
                exit 1
            fi
            # Write nudge file and exit
            mkdir -p .ralph-loop
            printf '%s\n' "$2" > .ralph-loop/nudge.md
            echo "Nudge written to .ralph-loop/nudge.md"
            exit 0
            ;;
        --no-intelligence)
            NO_INTELLIGENCE_FLAG=true
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        --force-streaming)
            FORCE_STREAMING=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            echo -e "${RED}Error: Unknown option '$1'${RESET}" >&2
            usage
            exit 1
            ;;
        *)
            if [[ -z "$PROMPT" ]]; then
                PROMPT="$1"
            else
                PROMPT="$PROMPT $1"
            fi
            shift
            ;;
    esac
done

if [[ -z "$PROMPT" ]]; then
    echo -e "${RED}Error: No prompt provided.${RESET}" >&2
    echo ""
    usage
    exit 1
fi

# ── Numeric Validation ────────────────────────────────────────────────────
if ! [[ "$MAX_ITERATIONS" =~ ^[0-9]+$ ]]; then
    echo "Error: --max-iterations must be a positive integer" >&2
    exit 1
fi
if ! [[ "$MAX_CYCLES" =~ ^[0-9]+$ ]]; then
    echo "Error: --max-cycles must be a positive integer" >&2
    exit 1
fi
if ! [[ "$CONTEXT_THRESHOLD" =~ ^[0-9]+$ ]]; then
    echo "Error: --context-threshold must be a positive integer" >&2
    exit 1
fi

# ── Apply --no-intelligence override (FEAT-3) ──────────────────────────────
# If user explicitly requested no intelligence layer, override the auto-detection
if [[ "$NO_INTELLIGENCE_FLAG" == true ]]; then
    INTELLIGENCE_AVAILABLE=false
fi

# ── Supervisor Mode Warning (ROB-1/FEAT-8) ─────────────────────────────────
# If --supervisor was requested but intelligence layer is unavailable, warn user
if [[ "$SUPERVISOR_MODE" == true && "$INTELLIGENCE_AVAILABLE" != true ]]; then
    if [[ "$AGENT_MODE" == true ]]; then
        # In agent mode, emit structured warning that can be captured in status
        echo "[WARN] --supervisor requires bun + scripts/ -- falling back to basic mode"
    else
        # In human mode, emit to stderr with formatting
        echo -e "${YELLOW}WARNING: --supervisor requires bun + scripts/ -- falling back to basic mode${RESET}" >&2
    fi
fi

# ── TMPFILE Creation (after arg parsing so --help/--nudge don't create it) ─
TMPFILE=$(mktemp /tmp/ralph-loop.XXXXXX)

# ── Agent Mode Setup ──────────────────────────────────────────────────────
if [[ "$AGENT_MODE" == true ]]; then
    # Check jq dependency
    if ! command -v jq &>/dev/null; then
        echo "ERROR: --agent mode requires jq. Install: apt install jq" >&2
        exit 1
    fi

    # Strip colors
    RED='' GREEN='' YELLOW='' CYAN='' BOLD='' DIM='' RESET=''

    # Create log directory
    RUN_DIR=".ralph-loop/$(date +%Y%m%d_%H%M%S)"
    RUN_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    mkdir -p "$RUN_DIR" || { echo "ERROR: Cannot create log dir $RUN_DIR" >&2; exit 1; }

    # Write run config
    cat > "${RUN_DIR}/run-config.json" <<RUNCFG
{
  "prompt": $(printf '%s' "$PROMPT" | jq -Rs .),
  "max_iterations": $MAX_ITERATIONS,
  "completion_promise": $(printf '%s' "$COMPLETION_PROMISE" | jq -Rs .),
  "permission_mode": "$PERMISSION_MODE",
  "started_at": "$RUN_STARTED_AT",
  "cwd": "$(pwd)",
  "intelligence_available": $INTELLIGENCE_AVAILABLE,
  "supervisor_mode": $SUPERVISOR_MODE,
  "max_cycles": $MAX_CYCLES,
  "context_threshold": $CONTEXT_THRESHOLD
}
RUNCFG
fi

# ── Session ID Generation ──────────────────────────────────────────────────
generate_session_id() {
    local ts
    ts=$(date +%Y%m%d%H%M%S)
    local rand
    rand=$(head -c 4 /dev/urandom | od -An -tx1 | tr -d ' \n')
    echo "ralph-${ts}-${rand}"
}

SESSION_ID=$(generate_session_id)

# ── Nudge Reader ────────────────────────────────────────────────────────────
read_and_consume_nudge() {
    local nudge_file=".ralph-loop/nudge.md"
    local consumed_file=".ralph-loop/nudge.consumed.md"
    # Atomic consumption: mv is atomic on same filesystem, so a concurrent
    # write creates a new nudge.md that is preserved (fixes ROB-3/FEAT-6)
    if mv "$nudge_file" "$consumed_file" 2>/dev/null; then
        cat "$consumed_file"
        rm -f "$consumed_file"
    fi
}

# ── Intelligence Pipeline Functions ─────────────────────────────────────────

# Parse Claude's JSON output for token metrics and context %
run_parse_output() {
    [[ "$INTELLIGENCE_AVAILABLE" != true ]] && return 1
    local json_file="$1"
    bun run "$SCRIPTS_DIR/parse-json-output.ts" "$json_file" 2>/dev/null || echo "{}"
}

# Analyze transcript for errors, progress, file changes
run_analysis() {
    [[ "$INTELLIGENCE_AVAILABLE" != true ]] && return 1
    local iteration_text_file="$1"

    # Create synthetic JSONL from iteration text for analyze-transcript.ts
    local synth_jsonl
    synth_jsonl=$(mktemp /tmp/ralph-synth.XXXXXX)

    # Wrap the iteration result text as an assistant message in JSONL format
    local escaped_text
    escaped_text=$(jq -Rs . < "$iteration_text_file")
    echo "{\"role\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":${escaped_text}}]}}" > "$synth_jsonl"

    # Run analysis with session_id via stdin
    local result
    result=$(echo "{\"session_id\":\"${SESSION_ID}\"}" | bun run "$SCRIPTS_DIR/analyze-transcript.ts" "$synth_jsonl" 2>/dev/null) || result="{}"
    rm -f "$synth_jsonl"
    echo "$result"
}

# Determine strategy based on state + analysis
run_strategy() {
    [[ "$INTELLIGENCE_AVAILABLE" != true ]] && return 1
    local state_json="$1"
    local analysis_json="$2"

    local input
    input=$(jq -n \
        --argjson state "$state_json" \
        --argjson analysis "$analysis_json" \
        '{state: $state, analysis: $analysis}')

    echo "$input" | bun run "$SCRIPTS_DIR/strategy-engine.ts" 2>/dev/null || \
        echo '{"strategy":"explore","reason":"Default (error)","action":"continue","guidance":["Continue working"]}'
}

# Build enhanced context/prompt via build-context.ts
run_build_context() {
    [[ "$INTELLIGENCE_AVAILABLE" != true ]] && return 1
    local state_json="$1"
    local strategy_json="$2"
    local analysis_json="${3:-null}"
    local nudge_content="${4:-}"

    local input
    input=$(jq -n \
        --argjson state "$state_json" \
        --argjson strategy "$strategy_json" \
        --argjson analysis "$analysis_json" \
        --arg nudge "$nudge_content" \
        '{state: $state, strategy: $strategy, analysis: (if $analysis == null then null else $analysis end), nudge_content: (if $nudge == "" then null else $nudge end)}')

    echo "$input" | bun run "$SCRIPTS_DIR/build-context.ts" 2>/dev/null || echo ""
}

# Update memory in memorai
run_memory_update() {
    [[ "$INTELLIGENCE_AVAILABLE" != true ]] && return 1
    local state_json="$1"
    local analysis_json="$2"
    local summary="${3:-}"

    local input
    input=$(jq -n \
        --argjson state "$state_json" \
        --argjson analysis "$analysis_json" \
        --arg summary "$summary" \
        '{state: $state, analysis: $analysis, iteration_summary: (if $summary == "" then null else $summary end)}')

    echo "$input" | bun run "$SCRIPTS_DIR/update-memory.ts" 2>/dev/null || echo "{}"
}

# Generate post-loop summary
run_generate_summary() {
    [[ "$INTELLIGENCE_AVAILABLE" != true ]] && return
    local reason="$1"
    local output_path="${2:-.ralph-loop/RALPH_SUMMARY.md}"

    # Use RUN_DIR path if available
    if [[ -n "$RUN_DIR" ]]; then
        output_path="${RUN_DIR}/RALPH_SUMMARY.md"
    fi

    local input
    input=$(jq -n \
        --arg sid "$SESSION_ID" \
        --arg reason "$reason" \
        --argjson iter "$ITERATION" \
        --arg objective "$PROMPT" \
        '{session_id: $sid, completion_reason: $reason, final_iteration: $iter, original_objective: $objective}')

    echo "$input" | bun run "$SCRIPTS_DIR/generate-summary.ts" "$output_path" 2>/dev/null || true
}

# Save cycle handoff for supervisor mode
run_save_handoff() {
    [[ "$INTELLIGENCE_AVAILABLE" != true ]] && return
    local context_pct="$1"

    local input
    input=$(jq -n \
        --arg sid "$SESSION_ID" \
        --argjson cycle "$CYCLE_NUMBER" \
        --arg objective "$PROMPT" \
        --argjson cpct "$context_pct" \
        '{session_id: $sid, cycle_number: $cycle, original_objective: $objective, context_pct: $cpct}')

    echo "$input" | bun run "$SCRIPTS_DIR/save-cycle-handoff.ts" 2>/dev/null || true
}

# Load cycle handoff for supervisor mode
run_load_handoff() {
    [[ "$INTELLIGENCE_AVAILABLE" != true ]] && return 1

    bun run "$SCRIPTS_DIR/load-cycle-handoff.ts" "$SESSION_ID" 2>/dev/null || echo '{"found":false}'
}

# Build the RalphState JSON for TS scripts
build_state_json() {
    jq -n \
        --argjson active true \
        --argjson iter "$ITERATION" \
        --argjson max "$MAX_ITERATIONS" \
        --arg promise "$COMPLETION_PROMISE" \
        --arg started "$RUN_STARTED_AT" \
        --arg strategy "$CURRENT_STRATEGY" \
        --argjson stuck "$STUCK_COUNT" \
        --arg prompt "$PROMPT" \
        --arg sid "$SESSION_ID" \
        '{
            active: $active,
            iteration: $iter,
            max_iterations: $max,
            completion_promise: $promise,
            started_at: $started,
            checkpoint_interval: 0,
            checkpoint_mode: "notify",
            strategy: {current: $strategy, changed_at: 0},
            progress: {stuck_count: $stuck, velocity: "normal", last_meaningful_change: 0},
            phases: [],
            prompt_text: $prompt,
            session_id: $sid
        }'
}

# ── Dry Run Output ───────────────────────────────────────────────────────────
# Prints what would be sent to claude without invoking it (FEAT-1)
print_dry_run_info() {
    local prompt="$1"
    shift
    local args=("$@")

    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${CYAN}  ${BOLD}DRY RUN${RESET}${CYAN} — Iteration ${ITERATION}${RESET}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
    echo -e "${BOLD}Claude Arguments:${RESET}"
    echo "  claude ${args[*]}"
    echo ""
    echo -e "${BOLD}Strategy:${RESET} ${CURRENT_STRATEGY}"
    echo -e "${BOLD}Continue Flag:${RESET} ${CONTINUE_FLAG}"
    echo -e "${BOLD}Intelligence Available:${RESET} ${INTELLIGENCE_AVAILABLE}"
    echo ""
    echo -e "${BOLD}Full Prompt:${RESET}"
    echo -e "${DIM}────────────────────────────────────────────────────────────${RESET}"
    echo "$prompt"
    echo -e "${DIM}────────────────────────────────────────────────────────────${RESET}"
    echo ""

    # Show strategy JSON if available
    if [[ -n "${LAST_STRATEGY_JSON:-}" && "$LAST_STRATEGY_JSON" != "{}" ]]; then
        echo -e "${BOLD}Strategy JSON:${RESET}"
        echo "$LAST_STRATEGY_JSON" | jq . 2>/dev/null || echo "$LAST_STRATEGY_JSON"
        echo ""
    fi

    # Show analysis JSON if available
    if [[ -n "${LAST_ANALYSIS_JSON:-}" && "$LAST_ANALYSIS_JSON" != "{}" ]]; then
        echo -e "${BOLD}Last Analysis JSON:${RESET}"
        echo "$LAST_ANALYSIS_JSON" | jq . 2>/dev/null || echo "$LAST_ANALYSIS_JSON"
        echo ""
    fi
}

# ── Stream-JSON Parser for Human Mode (ROB-6/FEAT-2) ────────────────────────
# Parses stream-json output and displays text content, similar to agent mode but streaming
# Returns text via stdout, stores full output in the file passed as $1
parse_stream_json() {
    local output_file="$1"
    local full_text=""

    # Read stream-json line by line
    while IFS= read -r line; do
        # Save raw line to output file for later promise detection
        printf '%s\n' "$line" >> "$output_file"

        # Skip empty lines
        [[ -z "$line" ]] && continue

        # Parse JSON line - extract text content from assistant messages
        local msg_type content_type text_content
        msg_type=$(printf '%s' "$line" | jq -r '.type // ""' 2>/dev/null) || continue

        case "$msg_type" in
            "assistant")
                # Extract text from content blocks
                text_content=$(printf '%s' "$line" | jq -r '.message.content[]? | select(.type == "text") | .text // ""' 2>/dev/null) || true
                if [[ -n "$text_content" ]]; then
                    printf '%s' "$text_content"
                    full_text+="$text_content"
                fi
                ;;
            "content_block_delta")
                # Streaming delta - extract text delta
                text_content=$(printf '%s' "$line" | jq -r '.delta.text // ""' 2>/dev/null) || true
                if [[ -n "$text_content" ]]; then
                    printf '%s' "$text_content"
                    full_text+="$text_content"
                fi
                ;;
            "content_block_start")
                # Could be start of a new text block
                text_content=$(printf '%s' "$line" | jq -r '.content_block.text // ""' 2>/dev/null) || true
                if [[ -n "$text_content" ]]; then
                    printf '%s' "$text_content"
                    full_text+="$text_content"
                fi
                ;;
            "result")
                # Final result message - extract result text if present
                text_content=$(printf '%s' "$line" | jq -r '.result // ""' 2>/dev/null) || true
                if [[ -n "$text_content" && "$text_content" != "null" ]]; then
                    # Only print if we haven't already streamed it
                    if [[ -z "$full_text" ]]; then
                        printf '%s' "$text_content"
                    fi
                fi
                ;;
        esac
    done

    # Ensure final newline
    echo ""
}

# ── Prompt Builder ──────────────────────────────────────────────────────────
build_prompt() {
    local iter="$1"
    local max="$2"
    local user_prompt="$3"
    local promise="$4"

    local iter_label
    if [[ "$max" -gt 0 ]]; then
        iter_label="iteration ${iter}/${max}"
    else
        iter_label="iteration ${iter}"
    fi

    # Read nudge BEFORE intelligence check so it works in basic mode too (ROB-5/FEAT-7)
    local nudge
    nudge=$(read_and_consume_nudge)

    # ── Intelligence-enhanced prompt ────────────────────────────────────
    if [[ "$INTELLIGENCE_AVAILABLE" == true ]]; then
        local state_json
        state_json=$(build_state_json)


        # Get strategy (use last analysis if available, else empty)
        local analysis_for_strategy="${LAST_ANALYSIS_JSON:-"{}"}"
        if [[ "$analysis_for_strategy" == "" ]]; then
            analysis_for_strategy="{}"
        fi

        local strategy_json
        strategy_json=$(run_strategy "$state_json" "$analysis_for_strategy" 2>/dev/null) || strategy_json=""

        if [[ -n "$strategy_json" && "$strategy_json" != "{}" ]]; then
            # Update current strategy from result
            local new_strat
            new_strat=$(echo "$strategy_json" | jq -r '.strategy // "explore"' 2>/dev/null) || new_strat="explore"
            CURRENT_STRATEGY="$new_strat"
            LAST_STRATEGY_JSON="$strategy_json"

            # Build enhanced context
            local enhanced_prompt
            enhanced_prompt=$(run_build_context "$state_json" "$strategy_json" "${LAST_ANALYSIS_JSON:-null}" "$nudge" 2>/dev/null) || enhanced_prompt=""

            if [[ -n "$enhanced_prompt" ]]; then
                # For agent mode, append STATUS instruction
                if [[ "$AGENT_MODE" == true ]]; then
                    printf '%s\n\nIMPORTANT: End your response with exactly one line in this format:\n[STATUS] one-sentence summary of what you did and what remains' "$enhanced_prompt"
                else
                    echo "$enhanced_prompt"
                fi
                return
            fi
        fi
    fi

    # ── Fallback: basic prompt (no intelligence layer) ──────────────────
    if [[ "$iter" -eq 1 ]]; then
        if [[ "$AGENT_MODE" == true ]]; then
            cat <<PROMPT
You are in ${iter_label} of a Ralph loop.

## Your Task
${user_prompt}

## Ralph Loop Protocol
- Assess the current state of the codebase (check files, git log, git diff)
- Work on the next incremental step toward completing the task
- Verify your work (run tests, check builds, review changes)
- If the task is OBJECTIVELY COMPLETE and verified, output exactly:
  <promise>${promise}</promise>
- If NOT complete, summarize what remains
- Each iteration should make meaningful progress
- IMPORTANT: End your response with exactly one line in this format:
  [STATUS] one-sentence summary of what you did and what remains
PROMPT
        else
            cat <<PROMPT
You are in ${iter_label} of a Ralph loop.

## Your Task
${user_prompt}

## Ralph Loop Protocol
- First, assess the current state of the codebase and any previous work (check files, git log, git diff, etc.)
- Work on the next incremental step toward completing the task
- Verify your work (run tests, check builds, review changes as appropriate)
- If the task is OBJECTIVELY COMPLETE and verified, output exactly on its own line:
  <promise>${promise}</promise>
- If NOT complete, summarize what remains and what you accomplished this iteration — you will be re-invoked automatically
- Do NOT claim completion unless you have verified it objectively
- Each iteration should make meaningful progress — do not repeat work already done
PROMPT
        fi
    else
        if [[ "$AGENT_MODE" == true ]]; then
            echo "Ralph loop ${iter_label}. Continue working. End with: [STATUS] summary"
        else
            cat <<PROMPT
You are in ${iter_label} of a Ralph loop. Continue working on your task. Check your previous progress and take the next step. Output <promise>${promise}</promise> when objectively complete.
PROMPT
        fi
    fi

    # Append nudge if present (basic mode support - ROB-5/FEAT-7)
    if [[ -n "$nudge" ]]; then
        printf "\n## Nudge from User\n%s\n" "$nudge"
    fi
}

# ── Status JSON Writer (Leash integration) ────────────────────────────────
update_status_json() {
    [[ "$AGENT_MODE" != true ]] && return
    local status="$1"
    local summary="$2"
    local promise_detected="$3"

    jq -n \
        --arg session_type "ralph-loop" \
        --arg status "$status" \
        --argjson iteration "$ITERATION" \
        --argjson max_iterations "$MAX_ITERATIONS" \
        --arg prompt_preview "${PROMPT:0:80}" \
        --arg last_summary "$summary" \
        --argjson promise_detected "$promise_detected" \
        --arg started_at "$RUN_STARTED_AT" \
        --arg last_updated "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --argjson total_cost_usd "$TOTAL_COST" \
        --argjson total_input_tokens "$TOTAL_INPUT_TOKENS" \
        --argjson total_output_tokens "$TOTAL_OUTPUT_TOKENS" \
        --arg log_dir "$RUN_DIR" \
        --arg session_id "$SESSION_ID" \
        --arg strategy "$CURRENT_STRATEGY" \
        --argjson error_count "$ERROR_COUNT" \
        --argjson api_error_count "$API_ERROR_COUNT" \
        --arg last_api_error "$LAST_API_ERROR" \
        --argjson stuck_count "$STUCK_COUNT" \
        --argjson context_pct "$CONTEXT_PCT" \
        --argjson intelligence_available "$INTELLIGENCE_AVAILABLE" \
        --argjson supervisor_mode "$SUPERVISOR_MODE" \
        --argjson cycle_number "$CYCLE_NUMBER" \
        '{
          session_type: $session_type,
          status: $status,
          iteration: $iteration,
          max_iterations: $max_iterations,
          prompt_preview: $prompt_preview,
          last_summary: $last_summary,
          promise_detected: $promise_detected,
          started_at: $started_at,
          last_updated: $last_updated,
          total_cost_usd: $total_cost_usd,
          total_input_tokens: $total_input_tokens,
          total_output_tokens: $total_output_tokens,
          log_dir: $log_dir,
          session_id: $session_id,
          strategy: $strategy,
          error_count: $error_count,
          api_error_count: $api_error_count,
          last_api_error: $last_api_error,
          stuck_count: $stuck_count,
          context_pct: $context_pct,
          intelligence_available: $intelligence_available,
          supervisor_mode: $supervisor_mode,
          cycle_number: $cycle_number
        }' > "${RUN_DIR}/status.json"
}

# ── Post-Iteration Analysis ─────────────────────────────────────────────────
run_post_iteration_pipeline() {
    [[ "$INTELLIGENCE_AVAILABLE" != true ]] && return
    [[ "$AGENT_MODE" != true ]] && return
    local iteration_text_file="$1"
    local iteration_summary="$2"

    # Step 1: Analyze transcript
    LAST_ANALYSIS_JSON=$(run_analysis "$iteration_text_file" 2>/dev/null) || LAST_ANALYSIS_JSON="{}"

    # Extract error count from analysis
    local new_errors
    new_errors=$(echo "$LAST_ANALYSIS_JSON" | jq -r '.errors | length // 0' 2>/dev/null) || new_errors=0
    ERROR_COUNT=$((ERROR_COUNT + new_errors))

    # Check for meaningful changes to update stuck count
    local meaningful
    meaningful=$(echo "$LAST_ANALYSIS_JSON" | jq -r '.meaningful_changes // false' 2>/dev/null) || meaningful="false"
    if [[ "$meaningful" == "true" ]]; then
        STUCK_COUNT=0
    else
        STUCK_COUNT=$((STUCK_COUNT + 1))
    fi

    # Step 2: Strategy is determined next iteration in build_prompt()
    # (strategy depends on analysis, which depends on this iteration's output)

    # Step 3: Update memory in memorai
    local state_json
    state_json=$(build_state_json)
    run_memory_update "$state_json" "$LAST_ANALYSIS_JSON" "$iteration_summary" >/dev/null 2>&1 || true

    # Step 4: Parse token metrics for context tracking (supervisor mode)
    if [[ "$SUPERVISOR_MODE" == true ]] && [[ -f "${RUN_DIR}/iteration-${ITERATION}.json" ]]; then
        local parsed
        parsed=$(run_parse_output "${RUN_DIR}/iteration-${ITERATION}.json" 2>/dev/null) || parsed="{}"
        CONTEXT_PCT=$(echo "$parsed" | jq -r '.tokens.context_pct // 0' 2>/dev/null) || CONTEXT_PCT=0
    fi
}

# ── Cleanup & Signal Handling ───────────────────────────────────────────────
cleanup() {
    [[ -n "${TMPFILE:-}" ]] && rm -f "$TMPFILE"
}
trap cleanup EXIT

handle_interrupt() {
    # Kill child claude process if running (prevents orphaned processes)
    [[ -n "$CLAUDE_PID" ]] && kill "$CLAUDE_PID" 2>/dev/null

    # Generate summary on interrupt
    run_generate_summary "cancelled" 2>/dev/null || true

    if [[ "$AGENT_MODE" == true ]]; then
        update_status_json "INTERRUPTED" "Interrupted by user" "false"
        echo "[RALPH DONE] status=INTERRUPTED iterations=${ITERATION} log_dir=${RUN_DIR} strategy=${CURRENT_STRATEGY}"
    else
        echo ""
        echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${YELLOW}  Ralph loop interrupted by user after ${ITERATION} iteration(s)${RESET}"
        echo -e "${YELLOW}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    fi
    cleanup
    exit 130
}
trap handle_interrupt INT TERM

# ── Banner (human mode only) ──────────────────────────────────────────────
if [[ "$AGENT_MODE" != true ]]; then
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "${CYAN}  ${BOLD}Ralph Loop${RESET}${CYAN} — Autonomous Claude Code Loop${RESET}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo -e "  ${BOLD}Task:${RESET}    $PROMPT"
    if [[ "$MAX_ITERATIONS" -gt 0 ]]; then
        echo -e "  ${BOLD}Max:${RESET}     $MAX_ITERATIONS iterations"
    else
        echo -e "  ${BOLD}Max:${RESET}     unlimited"
    fi
    echo -e "  ${BOLD}Promise:${RESET} <promise>${COMPLETION_PROMISE}</promise>"
    if [[ "$PERMISSION_MODE" == "bypassPermissions" ]]; then
        echo -e "  ${BOLD}Perms:${RESET}   ${YELLOW}YOLO — all permissions bypassed${RESET}"
    else
        echo -e "  ${BOLD}Perms:${RESET}   acceptEdits (auto-accept file changes)"
    fi
    if [[ "$INTELLIGENCE_AVAILABLE" == true ]]; then
        echo -e "  ${BOLD}Intel:${RESET}   ${GREEN}active${RESET} (strategies, memorai, analysis)"
        if [[ "$SUPERVISOR_MODE" == true ]]; then
            echo -e "  ${BOLD}Super:${RESET}   ${GREEN}enabled${RESET} (max ${MAX_CYCLES} cycles, threshold ${CONTEXT_THRESHOLD}%)"
        fi
    else
        echo -e "  ${BOLD}Intel:${RESET}   ${DIM}basic mode (bun/scripts not found)${RESET}"
    fi
    echo -e "  ${BOLD}Session:${RESET} ${DIM}${SESSION_ID}${RESET}"
    if [[ "$DRY_RUN" == true ]]; then
        echo -e "  ${BOLD}Mode:${RESET}    ${YELLOW}DRY RUN — will not invoke claude${RESET}"
    fi
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
fi

# ── Run Inner Loop (one cycle) ──────────────────────────────────────────────
# Returns: 0 = promise detected (complete), 1 = max iterations, 2 = context threshold, 130 = interrupted
run_inner_loop() {
    local cycle_start_iteration="$ITERATION"

    while true; do
        ITERATION=$((ITERATION + 1))
        TOTAL_ITERATIONS_ALL_CYCLES=$((TOTAL_ITERATIONS_ALL_CYCLES + 1))

        # ── Iteration label ─────────────────────────────────────────────────
        if [[ "$MAX_ITERATIONS" -gt 0 ]]; then
            ITER_LABEL="${ITERATION}/${MAX_ITERATIONS}"
        else
            ITER_LABEL="${ITERATION}"
        fi

        # ── Check max iterations ────────────────────────────────────────────
        if [[ "$MAX_ITERATIONS" -gt 0 && "$ITERATION" -gt "$MAX_ITERATIONS" ]]; then
            run_generate_summary "max_iterations" 2>/dev/null || true
            if [[ "$AGENT_MODE" == true ]]; then
                update_status_json "MAX_REACHED" "Max iterations reached" "false"
                echo "[RALPH DONE] status=MAX_REACHED iterations=$((ITERATION - 1)) log_dir=${RUN_DIR} strategy=${CURRENT_STRATEGY} cost_usd=${TOTAL_COST}"
            else
                echo ""
                echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
                echo -e "${RED}  Max iterations (${MAX_ITERATIONS}) reached without completion${RESET}"
                echo -e "${RED}  Task may be incomplete — review the current state${RESET}"
                echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
            fi
            return 1
        fi

        # ── Build prompt ────────────────────────────────────────────────────
        FULL_PROMPT=$(build_prompt "$ITERATION" "$MAX_ITERATIONS" "$PROMPT" "$COMPLETION_PROMISE")

        # ── Build claude args ───────────────────────────────────────────────
        CLAUDE_ARGS=(-p "$FULL_PROMPT")
        if [[ "$CONTINUE_FLAG" == true ]]; then
            CLAUDE_ARGS+=(--continue)
        fi
        if [[ "$PERMISSION_MODE" == "bypassPermissions" ]]; then
            CLAUDE_ARGS+=(--dangerously-skip-permissions)
        else
            CLAUDE_ARGS+=(--permission-mode "$PERMISSION_MODE")
        fi

        # After first iteration of a cycle, always use --continue
        CONTINUE_FLAG=true

        # ── Dry Run Mode: Print info and exit ────────────────────────────────
        if [[ "$DRY_RUN" == true ]]; then
            # Add output format for completeness in dry run display
            local display_args=("${CLAUDE_ARGS[@]}")
            if [[ "$AGENT_MODE" == true ]]; then
                display_args+=(--output-format json)
            fi
            print_dry_run_info "$FULL_PROMPT" "${display_args[@]}"
            echo -e "${GREEN}[DRY RUN] Exiting after showing iteration ${ITERATION} configuration.${RESET}"
            echo -e "${DIM}Run without --dry-run to actually invoke claude.${RESET}"
            return 0
        fi

        # ── Execute: Agent Mode ─────────────────────────────────────────────
        if [[ "$AGENT_MODE" == true ]]; then
            CLAUDE_ARGS+=(--output-format json)

            set +e
            # Run claude in background and track PID for signal handling (ROB-4/FEAT-5)
            claude "${CLAUDE_ARGS[@]}" </dev/null > "$TMPFILE" 2>"${RUN_DIR}/iteration-${ITERATION}.stderr" &
            CLAUDE_PID=$!
            wait $CLAUDE_PID
            CLAUDE_EXIT=$?
            CLAUDE_PID=""
            set -e

            # Save full JSON log
            cp "$TMPFILE" "${RUN_DIR}/iteration-${ITERATION}.json"

            # Parse JSON response
            RESULT_TEXT=$(jq -r '.result // ""' "$TMPFILE" 2>/dev/null || echo "")
            IS_ERROR=$(jq -r '.is_error // false' "$TMPFILE" 2>/dev/null || echo "true")
            ITER_COST=$(jq -r '.total_cost_usd // 0' "$TMPFILE" 2>/dev/null || echo "0")
            ITER_INPUT=$(jq -r '(.usage.input_tokens // 0) + (.usage.cache_creation_input_tokens // 0) + (.usage.cache_read_input_tokens // 0)' "$TMPFILE" 2>/dev/null || echo "0")
            ITER_OUTPUT=$(jq -r '.usage.output_tokens // 0' "$TMPFILE" 2>/dev/null || echo "0")

            # Accumulate totals
            TOTAL_COST=$(awk "BEGIN{printf \"%.4f\", $TOTAL_COST + $ITER_COST}" 2>/dev/null || echo "$TOTAL_COST")
            TOTAL_INPUT_TOKENS=$((TOTAL_INPUT_TOKENS + ITER_INPUT))
            TOTAL_OUTPUT_TOKENS=$((TOTAL_OUTPUT_TOKENS + ITER_OUTPUT))

            # Save text-only result
            printf '%s\n' "$RESULT_TEXT" > "${RUN_DIR}/iteration-${ITERATION}.txt"

            # Detect promise
            PROMISE_FOUND="none"
            if printf '%s' "$RESULT_TEXT" | grep -q "<promise>${COMPLETION_PROMISE}</promise>" 2>/dev/null; then
                PROMISE_FOUND="DETECTED"
            fi

            # Determine status and extract summary
            if [[ "$IS_ERROR" == "true" ]] || [[ "$CLAUDE_EXIT" -ne 0 ]]; then
                STATUS="ERROR"
                SUMMARY=$(printf '%s' "$RESULT_TEXT" | head -c 200 | tr '\n' ' ')
                # Track API-level errors (BUG-1/FEAT-4)
                if [[ "$IS_ERROR" == "true" ]]; then
                    API_ERROR_COUNT=$((API_ERROR_COUNT + 1))
                    LAST_API_ERROR=$(printf '%s' "$RESULT_TEXT" | head -c 500 | tr '\n' ' ')
                fi
            elif [[ "$PROMISE_FOUND" == "DETECTED" ]]; then
                STATUS="COMPLETE"
            else
                STATUS="WORKING"
            fi

            # Extract summary: try [STATUS] line first, fallback to last non-empty line
            if [[ "$STATUS" != "ERROR" ]]; then
                SUMMARY=$(printf '%s' "$RESULT_TEXT" | grep -oP '^\[STATUS\]\s*\K.*' | tail -1 || true)
                if [[ -z "$SUMMARY" ]]; then
                    # Strip promise tags and empty lines, then take the last meaningful line
                    SUMMARY=$(printf '%s' "$RESULT_TEXT" | grep -v '<promise>.*</promise>' | sed '/^$/d' | tail -1 | head -c 150 | tr '\n' ' ')
                fi
            fi

            # ── Run post-iteration intelligence pipeline ────────────────────
            run_post_iteration_pipeline "${RUN_DIR}/iteration-${ITERATION}.txt" "$SUMMARY"

            # ── Emit status line (enhanced with strategy + errors) ──────────
            local strategy_tag=""
            if [[ "$INTELLIGENCE_AVAILABLE" == true ]]; then
                strategy_tag=" | ${CURRENT_STRATEGY} | ${ERROR_COUNT}err"
            fi
            STATUS_LINE="[ITER ${ITER_LABEL}] ${STATUS}${strategy_tag} | ${SUMMARY:0:200} | promise=${PROMISE_FOUND}"
            echo "$STATUS_LINE"

            # Append to summary log
            echo "$STATUS_LINE" >> "${RUN_DIR}/summary.log"

            # Update Leash status
            if [[ "$PROMISE_FOUND" == "DETECTED" ]]; then
                update_status_json "$STATUS" "$SUMMARY" "true"
            else
                update_status_json "$STATUS" "$SUMMARY" "false"
            fi

            # Handle completion
            if [[ "$PROMISE_FOUND" == "DETECTED" ]]; then
                run_generate_summary "promise" 2>/dev/null || true
                echo "[RALPH DONE] status=COMPLETE iterations=${ITERATION} log_dir=${RUN_DIR} strategy=${CURRENT_STRATEGY} cost_usd=${TOTAL_COST}"
                return 0
            fi

            # ── Check context threshold (supervisor mode) ───────────────────
            if [[ "$SUPERVISOR_MODE" == true ]]; then
                # Use integer comparison — CONTEXT_PCT might have decimals, truncate
                local ctx_int
                ctx_int=$(printf '%.0f' "$CONTEXT_PCT" 2>/dev/null) || ctx_int=0
                if [[ "$ctx_int" -ge "$CONTEXT_THRESHOLD" ]]; then
                    echo "[CYCLE ${CYCLE_NUMBER}] Context at ${CONTEXT_PCT}% — cycling"
                    return 2
                fi
            fi

        # ── Execute: Human Mode ─────────────────────────────────────────────
        else
            # Iteration header
            local strat_info=""
            if [[ "$INTELLIGENCE_AVAILABLE" == true ]]; then
                strat_info=" ${DIM}[${CURRENT_STRATEGY}]${RESET}"
            fi
            echo -e "${CYAN}──── Iteration ${ITER_LABEL}${strat_info} ────────────────────────────────────────${RESET}"

            # ── TTY Detection (ROB-6/FEAT-2) ───────────────────────────────────
            # If stdout is not a TTY (piped, CI/CD, etc.) and --force-streaming is not set,
            # use stream-json output format to avoid hanging
            local USE_STREAM_JSON=false
            if [[ ! -t 1 && "$FORCE_STREAMING" != true ]]; then
                USE_STREAM_JSON=true
                # Check jq dependency for stream-json parsing
                if ! command -v jq &>/dev/null; then
                    echo "WARNING: No TTY detected and jq not available. Output may hang." >&2
                    USE_STREAM_JSON=false
                fi
            fi

            set +e
            if [[ "$USE_STREAM_JSON" == true ]]; then
                # Non-TTY mode: use stream-json and parse it
                # Clear TMPFILE first since parse_stream_json appends to it
                > "$TMPFILE"
                claude "${CLAUDE_ARGS[@]}" --output-format stream-json </dev/null 2>&1 | parse_stream_json "$TMPFILE"
                CLAUDE_EXIT=${PIPESTATUS[0]}
            else
                # TTY mode: use normal streaming output
                claude "${CLAUDE_ARGS[@]}" </dev/null 2>&1 | tee "$TMPFILE"
                CLAUDE_EXIT=$?
            fi
            set -e

            # Check for completion promise
            # For stream-json mode, we need to search the raw JSONL for the promise in result text
            local PROMISE_DETECTED=false
            if [[ "$USE_STREAM_JSON" == true ]]; then
                # Extract result text from stream-json and check for promise
                if grep -o '"result":"[^"]*"' "$TMPFILE" 2>/dev/null | grep -q "<promise>${COMPLETION_PROMISE}</promise>"; then
                    PROMISE_DETECTED=true
                fi
                # Also check content blocks for the promise
                if grep -q "<promise>${COMPLETION_PROMISE}</promise>" "$TMPFILE" 2>/dev/null; then
                    PROMISE_DETECTED=true
                fi
            else
                # Normal TTY mode - check TMPFILE directly
                if grep -q "<promise>${COMPLETION_PROMISE}</promise>" "$TMPFILE" 2>/dev/null; then
                    PROMISE_DETECTED=true
                fi
            fi

            if [[ "$PROMISE_DETECTED" == true ]]; then
                run_generate_summary "promise" 2>/dev/null || true
                echo ""
                echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
                echo -e "${GREEN}  ${BOLD}Task complete!${RESET}${GREEN} Promise fulfilled after ${ITERATION} iteration(s)${RESET}"
                echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
                return 0
            fi

            echo ""
            echo -e "${YELLOW}  Promise not yet detected. Continuing in 2s...${RESET}"
        fi

        # Brief pause between iterations
        sleep 2
    done
}

# ── Main Execution ──────────────────────────────────────────────────────────
if [[ "$SUPERVISOR_MODE" == true && "$INTELLIGENCE_AVAILABLE" == true ]]; then
    # ── Supervisor Mode: Multi-Cycle Loop ───────────────────────────────
    ORIGINAL_PROMPT="$PROMPT"
    while [[ "$CYCLE_NUMBER" -le "$MAX_CYCLES" ]]; do

        if [[ "$CYCLE_NUMBER" -gt 1 ]]; then
            # Load handoff from previous cycle
            local_handoff=$(run_load_handoff 2>/dev/null) || local_handoff='{"found":false}'
            handoff_found=$(echo "$local_handoff" | jq -r '.found // false' 2>/dev/null) || handoff_found="false"

            if [[ "$handoff_found" == "true" ]]; then
                # Inject handoff context into the prompt for the first iteration of new cycle
                # Always rebuild from ORIGINAL_PROMPT to prevent unbounded growth
                handoff_context=$(echo "$local_handoff" | jq -r '.formatted_context // ""' 2>/dev/null) || handoff_context=""
                if [[ -n "$handoff_context" ]]; then
                    PROMPT="${handoff_context}

---
## ORIGINAL TASK
${ORIGINAL_PROMPT}"
                else
                    PROMPT="$ORIGINAL_PROMPT"
                fi
            else
                PROMPT="$ORIGINAL_PROMPT"
            fi

            # Start fresh conversation for new cycle (drop --continue)
            CONTINUE_FLAG=false

            if [[ "$AGENT_MODE" == true ]]; then
                echo "[CYCLE ${CYCLE_NUMBER}/${MAX_CYCLES}] Starting new cycle"
            else
                echo -e "${CYAN}━━ Supervisor: Cycle ${CYCLE_NUMBER}/${MAX_CYCLES} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
            fi
        fi

        # Run the inner loop
        run_inner_loop && LOOP_EXIT=0 || LOOP_EXIT=$?

        case "$LOOP_EXIT" in
            0)
                # Promise detected — done
                exit 0
                ;;
            1)
                # Max iterations — done
                exit 1
                ;;
            2)
                # Context threshold — save handoff and cycle
                run_save_handoff "$CONTEXT_PCT" 2>/dev/null || true
                CYCLE_NUMBER=$((CYCLE_NUMBER + 1))
                CONTEXT_PCT=0
                ;;
            *)
                # Unexpected — exit
                exit "$LOOP_EXIT"
                ;;
        esac
    done

    # Max cycles exhausted
    run_generate_summary "max_iterations" 2>/dev/null || true
    if [[ "$AGENT_MODE" == true ]]; then
        echo "[RALPH DONE] status=MAX_CYCLES cycles=$((CYCLE_NUMBER - 1)) total_iterations=${TOTAL_ITERATIONS_ALL_CYCLES} cost_usd=${TOTAL_COST}"
    else
        echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
        echo -e "${RED}  Max cycles (${MAX_CYCLES}) exhausted${RESET}"
        echo -e "${RED}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    fi
    exit 1

else
    # ── Standard Mode: Single loop (no supervisor) ──────────────────────
    run_inner_loop
    exit $?
fi
