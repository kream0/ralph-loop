# ralph-loop TODO

Post-testing audit. 132 checks across 4 levels, 14 bugs fixed during testing.
Items below are outstanding WARNs and feature ideas discovered during the session.

Last updated: 2026-02-04

---

## Priority Legend

- **P0** -- Critical: breaks core functionality or causes data loss
- **P1** -- Important: impacts correctness or usability in common scenarios
- **P2** -- Nice to have: cosmetic, edge-case, or future improvement

---

## Bugs

### [BUG-1] P1 -- Agent mode: dual error tracking gap

`is_error` (from Claude's JSON response, line 735 of `ralph-loop.sh`) tracks API-level
errors (timeouts, auth failures, rate limits). `ERROR_COUNT` (line 591) tracks
application-level errors found by transcript analysis in `scripts/analyze-transcript.ts`.
Only `ERROR_COUNT` is written to `status.json` (line 547). A master agent monitoring
`status.json` has zero visibility into API-level errors.

**Impact:** Master agent cannot detect when Claude API itself is failing.

**Where:** `ralph-loop.sh:735` (`IS_ERROR` parse), `ralph-loop.sh:547` (`error_count`
in `update_status_json`), `ralph-loop.sh:755` (error branch only sets `STATUS="ERROR"`
but does not increment `ERROR_COUNT`).

**Fix:** Add `api_error_count` field to `status.json`, or unify by incrementing
`ERROR_COUNT` when `IS_ERROR == "true"`.

---

### [BUG-2] P2 -- Agent mode: raw promise tag leaks into summary

When an iteration contains `<promise>TASK_COMPLETE</promise>` but no `[STATUS]` line,
the fallback summary extraction (line 768) picks up the last non-empty line, which may
be the raw XML tag itself. The summary then reads something like
`<promise>TASK_COMPLETE</promise>` in `status.json` and the status line.

**Impact:** Cosmetic. Ugly summary text in logs and Leash dashboard.

**Where:** `ralph-loop.sh:766-769` (fallback summary extraction).

**Fix:** Strip `<promise>...</promise>` tags before fallback summary extraction, or
use the line before the promise tag.

---

### [BUG-3] P1 -- Token counting underreports input tokens

`total_input_tokens` in `status.json` reads only `usage.input_tokens` (line 737).
It does not include `cache_creation_input_tokens` or `cache_read_input_tokens`.
The `parse-json-output.ts` script (line 54-56) correctly sums all three, but that
script is only called in the post-iteration pipeline for supervisor context tracking
-- not for the main token accumulation in the bash loop.

The `total_cost_usd` field is accurate because it comes directly from Claude's
`total_cost_usd` field.

**Impact:** `total_input_tokens` in `status.json` is lower than actual. Cost is correct.

**Where:** `ralph-loop.sh:737` (`ITER_INPUT` reads only `usage.input_tokens`),
`scripts/parse-json-output.ts:54-56` (correct summation).

**Fix:** Sum all three token fields in the bash loop:
`ITER_INPUT=$(jq -r '(.usage.input_tokens // 0) + (.usage.cache_creation_input_tokens // 0) + (.usage.cache_read_input_tokens // 0)' ...)`.

---

## Robustness

### [ROB-1] P1 -- Supervisor mode: no warning when intelligence layer missing

If `--supervisor` is passed but `bun`/`scripts/` are unavailable, the script silently
falls back to basic single-loop mode. The supervisor features (context cycling,
handoff, multi-cycle) are completely disabled without any indication to the user.

**Where:** `ralph-loop.sh:845` (supervisor entry point checks
`INTELLIGENCE_AVAILABLE`). Detection at line 58-60.

**Fix:** Emit a warning (stderr in human mode, status line in agent mode) when
`--supervisor` is passed but `INTELLIGENCE_AVAILABLE == false`. Something like:
`WARNING: --supervisor requires bun + scripts/ -- falling back to basic mode`.

---

### [ROB-2] P2 -- Supervisor mode: handoff data lost without memorai

When memorai is not initialized, `save-cycle-handoff.ts` exits with error (line 24-27),
and `run_save_handoff` in bash silently fails (line 383, `|| true`). The new cycle
starts without any context about what the previous cycle accomplished.

**Impact:** Supervisor mode technically works without memorai (cycles still happen at
the context threshold), but each cycle starts cold with just the original prompt.
Significantly less efficient.

**Where:** `scripts/save-cycle-handoff.ts:24-27`, `scripts/load-cycle-handoff.ts:25-30`,
`ralph-loop.sh:370-383`.

**Fix (P2):** Consider a filesystem-based fallback for handoff data (e.g., write JSON
to `.ralph-loop/handoff-cycle-N.json`) when memorai is unavailable.

---

### [ROB-3] P1 -- Nudge race condition (theoretical)

`read_and_consume_nudge()` (line 257-263) reads the nudge file with `cat`, then deletes
it with `rm -f`. If a new nudge is written between the `cat` and `rm`, the new nudge
is silently lost.

**Impact:** Very narrow window. Unlikely in practice but possible under rapid nudging.

**Where:** `ralph-loop.sh:257-263`.

**Fix:** Use atomic consumption: `mv nudge.md nudge.consumed.md && cat nudge.consumed.md && rm -f nudge.consumed.md`. The `mv` is atomic on the same filesystem, so a concurrent write creates a new `nudge.md` that is preserved.

---

### [ROB-4] P1 -- Child process cleanup on SIGINT/SIGTERM

`handle_interrupt` (line 624-639) generates a summary and writes status, but does not
explicitly kill child processes. If `claude` CLI is mid-execution when the signal
arrives, the child process may be orphaned.

**Where:** `ralph-loop.sh:624-639` (`handle_interrupt`), line 726 (`claude` invocation
in agent mode), line 821 (`claude` invocation in human mode).

**Fix:** Track the PID of the `claude` child process and kill it in `handle_interrupt`:
```
CLAUDE_PID=""
# In agent mode execution:
claude "${CLAUDE_ARGS[@]}" </dev/null > "$TMPFILE" 2>"..." &
CLAUDE_PID=$!
wait $CLAUDE_PID
# In handle_interrupt:
[[ -n "$CLAUDE_PID" ]] && kill "$CLAUDE_PID" 2>/dev/null
```

---

### [ROB-5] P2 -- Nudge not consumed in basic mode

The nudge system (`--nudge` flag, `read_and_consume_nudge()`) is tightly coupled to
the intelligence layer. In basic mode (no bun/scripts), nudges are written to
`.ralph-loop/nudge.md` but never read because `build_prompt()` only calls
`read_and_consume_nudge()` inside the `INTELLIGENCE_AVAILABLE == true` branch (line 441).

**Impact:** Users in basic mode can write nudges that are silently ignored.

**Where:** `ralph-loop.sh:441` (nudge read only in intelligence branch),
`ralph-loop.sh:476-521` (basic prompt builder ignores nudges).

**Fix:** Read and inject nudge content in the basic prompt builder too. Add nudge
consumption before the `if [[ "$INTELLIGENCE_AVAILABLE" == true ]]` block, and append
nudge text to the basic prompt if present.

---

### [ROB-6] P2 -- Human mode TTY requirement

`claude` CLI in streaming mode (human mode, no `--output-format json`) requires a TTY.
When piped through `tee` in a non-TTY context (CI/CD, cron, automation script), it may
hang or produce no output. Agent mode (`--output-format json`) is unaffected.

**Where:** `ralph-loop.sh:821` (`claude "${CLAUDE_ARGS[@]}" </dev/null 2>&1 | tee "$TMPFILE"`).

**Impact:** Human mode unusable in CI/CD or when called by another script.

**Fix:** Consider adding `--output-format stream-json` support for human mode when
no TTY is detected. Or document this as a known limitation and recommend `--agent`
mode for non-interactive contexts.

---

## Features

### [FEAT-1] P2 -- `--dry-run` flag for testing

Add a `--dry-run` flag that goes through all prompt building, strategy selection, and
context construction steps but does not actually invoke `claude`. Useful for testing
prompt content, validating the intelligence pipeline, and debugging.

**Where:** New flag in argument parsing (line 111-186). Skip `claude` invocation in
`run_inner_loop()`.

---

### [FEAT-2] P2 -- `--output-format stream-json` for human mode

Use `--output-format stream-json` instead of plain streaming in human mode. This would:
- Remove the TTY dependency (fixes ROB-6)
- Enable structured output parsing even in human mode
- Allow token/cost tracking in human mode (currently only agent mode)

**Trade-off:** Loses the real-time streaming visual in the terminal. Could be a separate
flag like `--structured-human` or auto-detected when no TTY is present.

**Where:** `ralph-loop.sh:811-837` (human mode execution block).

---

### [FEAT-3] P2 -- `--no-intelligence` flag

Explicitly disable the intelligence layer even when bun/scripts are available. Useful
for debugging, benchmarking basic vs. intelligent mode, or when the intelligence layer
is misbehaving.

**Where:** New flag in argument parsing. Set `INTELLIGENCE_AVAILABLE=false` after
detection (line 58-60).

---

### [FEAT-4] P1 -- Unify error tracking in status.json

Add an `api_errors` or `api_error_count` field to `status.json` alongside the existing
`error_count` (transcript-analysis errors). Alternatively, add a `last_api_error` field
with the error message. This gives the master agent full visibility.

Related to BUG-1.

**Where:** `ralph-loop.sh:525-576` (`update_status_json`), `ralph-loop.sh:755`
(error detection branch).

---

### [FEAT-5] P1 -- Signal forwarding to child processes

Forward SIGINT/SIGTERM to the active `claude` child process before cleanup. This
ensures Claude can handle graceful shutdown (e.g., saving partial work) rather than
being orphaned.

Related to ROB-4.

**Where:** `ralph-loop.sh:624-639` (`handle_interrupt`).

---

### [FEAT-6] P2 -- Atomic nudge consumption

Replace the current `cat + rm` nudge consumption with `mv + cat + rm` for atomicity.
Prevents the theoretical race condition in ROB-3.

**Where:** `ralph-loop.sh:257-263` (`read_and_consume_nudge`).

---

### [FEAT-7] P2 -- Basic nudge support (no intelligence layer)

Read and inject nudge content in the basic prompt builder so nudges work even without
bun/scripts. The nudge is already written to disk by the `--nudge` flag handler
regardless of intelligence availability.

Related to ROB-5.

**Where:** `ralph-loop.sh:420-522` (`build_prompt`).

---

### [FEAT-8] P2 -- Supervisor mode intelligence warning

When `--supervisor` is passed but the intelligence layer is unavailable, emit a visible
warning. Currently falls through silently to basic single-loop mode.

Related to ROB-1.

**Where:** After argument parsing, before main execution (around line 845).

---

## Documentation

### [DOC-1] P2 -- Document `--continue` fix for cycle 1

The bug where `--continue` was passed on the first iteration of cycle 1 (no prior
conversation) has been fixed. `CONTINUE_FLAG` is now initialized to `false` (line 55)
and only set to `true` after the first iteration runs (line 719). Document this fix
in a CHANGELOG or release notes.

**Where:** `ralph-loop.sh:55` (`CONTINUE_FLAG=false`), `ralph-loop.sh:719`
(set to true after first iteration).

---

### [DOC-2] P2 -- Document token counting discrepancy

Explain in README.md that `total_input_tokens` in `status.json` underreports because
it only counts `usage.input_tokens`, not cache tokens. Clarify that `total_cost_usd`
is accurate. Reference BUG-3 for the fix.

**Where:** `README.md`, Agent Mode section.

---

### [DOC-3] P2 -- Document human mode TTY limitation

Add a note in README.md that human mode requires a TTY and is not suitable for CI/CD
or non-interactive contexts. Recommend `--agent` mode for those use cases.

**Where:** `README.md`, Usage section or a new "Known Limitations" section.

---

## Summary

| Priority | Bugs | Robustness | Features | Documentation | Total |
|----------|------|------------|----------|---------------|-------|
| P0       | 0    | 0          | 0        | 0             | 0     |
| P1       | 2    | 3          | 2        | 0             | 7     |
| P2       | 1    | 3          | 6        | 3             | 13    |
| **Total**| **3**| **6**      | **8**    | **3**         | **20**|
