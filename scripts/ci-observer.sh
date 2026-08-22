#!/usr/bin/env bash
# Zero-perturbation observer: snapshot the bun test process tree every second
# so a hung test shows which child process exists and what it waits on.
OUT="$1"
: > "$OUT"
while true; do
  {
    echo "===== $(date -u +%H:%M:%S) ====="
    ps -eo pid,ppid,stat,etimes,args --sort=pid | grep -Ev "grep|ps -eo" | tail -n +2
    for pid in $(pgrep -f "bun test" 2>/dev/null); do
      echo "--- pid $pid wchan: $(cat /proc/$pid/wchan 2>/dev/null)"
    done
  } >> "$OUT" 2>/dev/null
  sleep 1
done
