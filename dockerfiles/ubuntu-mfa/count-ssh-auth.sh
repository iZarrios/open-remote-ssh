#!/usr/bin/env bash
# Increments an independent successful-authentication counter for e2e tests.
set -euo pipefail
COUNT_FILE=/var/run/ssh-auth-count
LOCK_FILE=/var/run/ssh-auth-count.lock
mkdir -p "$(dirname "$COUNT_FILE")"
(
  flock 9
  current=0
  if [[ -f "$COUNT_FILE" ]]; then
    current=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
  fi
  echo $((current + 1)) > "$COUNT_FILE"
) 9>"$LOCK_FILE"
exit 0
