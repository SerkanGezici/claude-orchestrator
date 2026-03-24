# claude-orchestrator

Multi-AI consensus analysis plugin for Claude Code. Runs Claude + Gemini CLI + Codex CLI in parallel, performs cross-critique between all AIs, and measures convergence to produce a high-confidence final report.

## What It Does

1. **Health Check** -- Pings all AI CLIs (Claude, Gemini, Codex) in parallel to determine availability
2. **Parallel Analysis** -- Each available AI independently analyzes the target project/question
3. **Cross-Critique** -- Each AI reads the others' reports and refines its own findings
4. **Convergence Measurement** -- Jaccard similarity + evidence quality scoring across all reports
5. **Final Report** -- Claude synthesizes a consensus report with confidence levels per finding

## Architecture

```
                     +-----------+
                     |  Claude   |  (always active -- coordinator + analyst)
                     +-----+-----+
                           |
              +------------+------------+
              |                         |
       +------+------+          +------+------+
       |  Gemini CLI |          |  Codex CLI  |
       | (--yolo)    |          | (exec stdin)|
       +------+------+          +------+------+
              |                         |
              +------------+------------+
                           |
                    +------+------+
                    | Convergence |  (Jaccard + evidence scoring)
                    +------+------+
                           |
                    +------+------+
                    | Final Report|  (confidence-ranked findings)
                    +-------------+
```

**Turn loop (max 10 turns):**

```
Turn 1:  Claude analyzes  |  Gemini analyzes  |  Codex analyzes   (parallel)
Turn 2:  Each AI reads others' reports, critiques, and improves   (parallel)
Turn N:  Repeat until convergence >= 90% or max turns reached
Final:   Claude synthesizes all reports into consensus document
```

## Prerequisites

- **Claude Code** (always required -- this is a Claude Code plugin)
- **Gemini CLI** (`pip install google-generativeai` or `npm install -g @anthropic-ai/gemini-cli`)
- **Codex CLI** (`npm install -g @openai/codex`)

At least one external AI (Gemini or Codex) must be available. The system gracefully degrades if one is missing.

## Installation

From a local directory:

```bash
claude plugins add /path/to/claude-orchestrator
```

From GitHub:

```bash
claude plugins add github:your-org/claude-orchestrator
```

## Usage

### `/mutabakat` -- Turkish interface (same functionality)

```
/mutabakat                              # Full project audit
/mutabakat security review of auth      # Focused analysis
```

### `/orchestrate` -- English interface

```
/orchestrate                            # Full project audit
/orchestrate compare REST vs gRPC       # Brainstorm mode
```

Both commands follow the same flow:

1. Validate workspace
2. Health-check all AI CLIs
3. Run turn loop (parallel analysis + cross-critique)
4. Measure convergence after each turn
5. Produce final consensus report

### Direct Runner Usage

The runner can also be used standalone:

```bash
# Health check
node lib/run-orchestration.js --health-check

# Single turn (for scripting)
node lib/run-orchestration.js --single-turn --turn 1 \
  --task "audit security" --workspace "/path/to/project"

# Convergence measurement
node lib/run-orchestration.js --check-convergence /tmp/all-reports.json
```

## File Structure

```
claude-orchestrator/
  plugin.json              # Plugin manifest
  package.json             # No dependencies
  lib/
    logger.js              # Simple stderr logger (no winston)
    convergence.js         # Jaccard + JSON convergence scoring
    health-checker.js      # Parallel AI CLI ping
    gemini-wrapper.js      # Gemini CLI wrapper (merged + enhanced)
    codex-wrapper.js       # Codex CLI wrapper (merged + enhanced)
    run-orchestration.js   # Self-contained runner (3 modes)
  commands/
    mutabakat.md           # /mutabakat command definition
    orchestrate.md         # /orchestrate command definition
```

## How Convergence Works

Reports are compared using two strategies:

1. **JSON mode** -- If all reports contain a structured `findings` JSON block, findings are matched by normalized title (with Jaccard fuzzy matching for similar titles). Severity agreement provides a bonus.

2. **Text mode** -- Fallback: bullet points and numbered lists are extracted, deduplicated via Jaccard similarity, and cross-matched across reports.

**Score formula:**
```
score = semantic_similarity * 0.4 + evidence_quality * 0.6 + severity_bonus
```

Convergence threshold: **90%** (configurable via `--threshold`).

## License

MIT
