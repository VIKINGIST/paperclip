#!/bin/bash
# Filter tsc output: show only first 10 unique errors + count.
# Mirrors ElectroBoard's scripts/tsc-filter.sh pattern (swap npm→pnpm, monorepo cmd).
#
# Usage:
#   bash scripts/tsc-filter.sh              # runs typecheck itself
#   pnpm -r typecheck 2>&1 | bash scripts/tsc-filter.sh --pipe
#
# Known non-TTY behavior: see memory tsc_filter_root_cause (not fixed here — separate concern).
# Uses pnpm (not npm) per D:/paperclip convention.

if [ "$1" = "--pipe" ]; then
  OUTPUT=$(cat)
  EXIT_CODE=0
else
  OUTPUT=$(cd "$(dirname "$0")/.." && pnpm -r typecheck 2>&1)
  EXIT_CODE=$?
fi

# tsc may produce zero stdout on success; we trust EXIT_CODE 0 means clean.
if [ -z "$OUTPUT" ]; then
  if [ "$EXIT_CODE" -eq 0 ]; then
    echo "tsc: OK (0 errors)"
    exit 0
  else
    echo "tsc: FAILED with exit code $EXIT_CODE but no output captured"
    exit "$EXIT_CODE"
  fi
fi

# pnpm -r prefixes each tsc output line with "<pkg> typecheck: "; strip it so
# error paths look like raw tsc output (e.g. "src/foo.ts(1,1): error TS...").
STRIPPED=$(echo "$OUTPUT" | sed -E 's/^[^ ]+ typecheck: //')

TOTAL=$(echo "$STRIPPED" | grep -c "^src/")
UNIQUE=$(echo "$STRIPPED" | grep "^src/" | sed -E 's/\([0-9]+,[0-9]+\)//g' | sort -u | wc -l)

if [ "$TOTAL" -eq 0 ]; then
  # No errors in src/ — but tsc still failed (e.g. node_modules type errors).
  if [ "$EXIT_CODE" -eq 0 ]; then
    echo "tsc: OK (0 errors)"
    exit 0
  fi
  echo "tsc: FAILED but no src/ errors — likely tooling issue. First 10 lines:"
  echo "$OUTPUT" | head -10
  exit "$EXIT_CODE"
fi

echo "=== tsc: $TOTAL errors ($UNIQUE unique) ==="
echo "$STRIPPED" | grep "^src/" | head -10
if [ "$TOTAL" -gt 10 ]; then
  echo "... and $((TOTAL - 10)) more"
fi
exit "$EXIT_CODE"
