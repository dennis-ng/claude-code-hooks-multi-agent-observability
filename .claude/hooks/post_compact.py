#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "python-dotenv",
# ]
# ///

"""Post-compact context re-injection hook.

Fires via SessionStart(matcher="compact") after auto or manual compaction.
Re-injects critical context that compression loses:
  - CLAUDE.md project rules (static)
  - git diff dirty files (dynamic)
  - Recent errors from error journal (dynamic)
"""

import json
import os
import subprocess
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass


def get_claude_md():
    """Read CLAUDE.md content (truncated to keep token budget low)."""
    claude_md = Path("CLAUDE.md")
    if not claude_md.exists():
        return None
    try:
        content = claude_md.read_text().strip()
        # Cap at ~500 chars to stay within token budget
        if len(content) > 500:
            content = content[:500] + "\n..."
        return content
    except Exception:
        return None


def get_dirty_files():
    """Get list of uncommitted/changed files via git diff."""
    try:
        # Staged + unstaged changes
        result = subprocess.run(
            ["git", "diff", "--name-only", "HEAD"],
            capture_output=True, text=True, timeout=5
        )
        files = []
        if result.returncode == 0 and result.stdout.strip():
            files = result.stdout.strip().splitlines()

        # Also include untracked files
        untracked = subprocess.run(
            ["git", "ls-files", "--others", "--exclude-standard"],
            capture_output=True, text=True, timeout=5
        )
        if untracked.returncode == 0 and untracked.stdout.strip():
            files += [f"(new) {f}" for f in untracked.stdout.strip().splitlines()]

        return files if files else None
    except Exception:
        return None


def get_current_branch():
    """Get the current git branch name."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return None


def get_error_journal(max_entries=3):
    """Read last N entries from error journal if it exists."""
    journal_paths = [
        Path("logs/errors.jsonl"),
        Path("logs/error_journal.jsonl"),
        Path(".claude/data/errors.jsonl"),
    ]
    for path in journal_paths:
        if path.exists():
            try:
                lines = path.read_text().strip().splitlines()
                if not lines:
                    continue
                recent = lines[-max_entries:]
                entries = []
                for line in recent:
                    try:
                        entry = json.loads(line)
                        # Extract just the essentials
                        msg = entry.get("message") or entry.get("error") or str(entry)
                        entries.append(f"- {msg[:150]}")
                    except json.JSONDecodeError:
                        entries.append(f"- {line[:150]}")
                return entries
            except Exception:
                continue
    return None


def build_context(input_data):
    """Build the post-compact context string."""
    parts = []

    parts.append("=== POST-COMPACT CONTEXT RE-INJECTION ===")
    parts.append("")

    # 1. Project rules from CLAUDE.md
    claude_md = get_claude_md()
    if claude_md:
        parts.append("## Project Rules (CLAUDE.md)")
        parts.append(claude_md)
        parts.append("")

    # 2. Current branch + dirty files (the "what am I working on" signal)
    branch = get_current_branch()
    if branch:
        parts.append(f"## Current Branch: {branch}")

    dirty_files = get_dirty_files()
    if dirty_files:
        parts.append(f"## Dirty Files ({len(dirty_files)} changed)")
        for f in dirty_files[:20]:  # Cap at 20 files
            parts.append(f"  - {f}")
        if len(dirty_files) > 20:
            parts.append(f"  ... and {len(dirty_files) - 20} more")
        parts.append("")

    # 3. Recent errors
    errors = get_error_journal()
    if errors:
        parts.append("## Recent Errors")
        parts.extend(errors)
        parts.append("")

    parts.append("=== END POST-COMPACT CONTEXT ===")
    return "\n".join(parts)


def main():
    try:
        input_data = json.loads(sys.stdin.read())

        context = build_context(input_data)

        # Log the injection
        log_dir = Path("logs")
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / "post_compact.json"
        log_entries = []
        if log_file.exists():
            try:
                log_entries = json.loads(log_file.read_text())
            except (json.JSONDecodeError, ValueError):
                log_entries = []
        log_entries.append({
            "session_id": input_data.get("session_id", "unknown"),
            "context_length": len(context),
        })
        log_file.write_text(json.dumps(log_entries, indent=2))

        # Output context for injection via hookSpecificOutput
        output = {
            "hookSpecificOutput": {
                "hookEventName": "SessionStart",
                "additionalContext": context
            }
        }
        print(json.dumps(output))
        sys.exit(0)

    except json.JSONDecodeError:
        sys.exit(0)
    except Exception:
        sys.exit(0)


if __name__ == "__main__":
    main()
