#!/usr/bin/env python3
"""Tiny TODO CLI for MixCode README demo recordings."""

from __future__ import annotations

import json
import sys
from pathlib import Path

STORE = Path(__file__).with_name("todos.json")


def load() -> list[dict]:
    if not STORE.exists():
        return []
    return json.loads(STORE.read_text(encoding="utf-8"))


def save(items: list[dict]) -> None:
    STORE.write_text(json.dumps(items, indent=2) + "\n", encoding="utf-8")


def cmd_list() -> int:
    items = load()
    if not items:
        print("No todos.")
        return 0
    for i, item in enumerate(items, 1):
        mark = "x" if item.get("done") else " "
        print(f"{i}. [{mark}] {item.get('text', '')}")
    return 0


def cmd_add(text: str) -> int:
    items = load()
    items.append({"text": text, "done": False})
    save(items)
    print(f"Added: {text}")
    return 0


def cmd_done(index: int) -> int:
    items = load()
    if index < 1 or index > len(items):
        print(f"Invalid index: {index}", file=sys.stderr)
        return 1
    items[index - 1]["done"] = True
    save(items)
    print(f"Done: {items[index - 1]['text']}")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] in {"-h", "--help"}:
        print("Usage: todo.py list | add <text> | done <n>")
        return 0
    cmd = argv[1]
    if cmd == "list":
        return cmd_list()
    if cmd == "add":
        return cmd_add(" ".join(argv[2:]).strip() or "untitled")
    if cmd == "done":
        return cmd_done(int(argv[2]))
    print(f"Unknown command: {cmd}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
