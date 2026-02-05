# Backlog

Long-term items and future enhancements.

## Current Status

All 20 items from TODO.md audit have been completed. No outstanding issues.

## Future Enhancements (Ideas)

- [ ] Add `--quiet` flag for minimal output
- [ ] Add `--verbose` flag for debug output
- [ ] Support for custom claude CLI paths
- [ ] Webhook notifications for status changes
- [ ] Integration tests for all new features
- [ ] Performance benchmarking (basic vs intelligent mode)
- [ ] Token/cost tracking in human mode (stream-json already parses this, just need accumulation)

## Completed (moved from TODO.md)

All 20 items completed across Sessions 1 and 2 on 2026-02-05:

### Bugs (3)
- BUG-1: API error tracking in status.json
- BUG-2: Promise tag filtering in summary
- BUG-3: Token counting includes cache tokens

### Robustness (6)
- ROB-1: Supervisor mode intelligence warning
- ROB-2: Filesystem fallback for handoff without memorai
- ROB-3: Atomic nudge consumption
- ROB-4: Child process cleanup on signals
- ROB-5: Basic nudge support without intelligence layer
- ROB-6: Human mode TTY auto-detection with stream-json fallback

### Features (8)
- FEAT-1: --dry-run flag
- FEAT-2: Stream-json parsing for human mode
- FEAT-3: --no-intelligence flag
- FEAT-4: API error fields in status.json
- FEAT-5: Signal forwarding to child processes
- FEAT-6: Atomic nudge consumption
- FEAT-7: Basic nudge support
- FEAT-8: Supervisor mode intelligence warning

### Documentation (3)
- DOC-1: Changelog with --continue fix
- DOC-2: Token counting fix (code)
- DOC-3: Known Limitations section with TTY docs
