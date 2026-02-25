# Lightweight Observability System
# Usage: just <recipe>

set dotenv-load
set quiet

project_root := justfile_directory()

# List available recipes
default:
    @just --list

# ─── Docker ────────────────────────────────────────────────

# Start observability system
start:
    docker compose up -d --build
    @echo "Observability starting at http://localhost:4000"

# Stop observability system
stop:
    docker compose down

# Restart observability system
restart: stop start

# View logs
logs:
    docker compose logs -f observability

# Check container status
status:
    docker compose ps

# Reset everything (delete all data)
reset:
    docker compose down -v
    rm -rf {{project_root}}/data/
    @echo "All data deleted"

# ─── Install ─────────────────────────────────────────────

# Install hooks: symlink scripts + merge config into ~/.claude/settings.json
install:
    #!/usr/bin/env python3
    import json, shutil
    from pathlib import Path

    repo = Path("{{project_root}}")
    gcfg = repo / "global_claude_config"
    claude_dir = Path.home() / ".claude"
    claude_dir.mkdir(exist_ok=True)

    def symlink(name, source):
        target = claude_dir / name
        if target.is_symlink():
            if target.resolve() == source.resolve():
                print(f"✓ ~/.claude/{name} already symlinked")
                return
            target.unlink()
        elif target.is_dir():
            shutil.move(str(target), str(target) + ".bak")
            print(f"  Backed up ~/.claude/{name} to ~/.claude/{name}.bak")
        elif target.exists():
            target.rename(str(target) + ".bak")
            print(f"  Backed up ~/.claude/{name} to ~/.claude/{name}.bak")
        target.symlink_to(source)
        print(f"✓ Symlinked: ~/.claude/{name} -> {source}")

    symlink("hooks", gcfg / "hooks")
    symlink("commands", gcfg / "commands")
    symlink("CLAUDE.md", gcfg / "CLAUDE.md")

    # Merge hooks config into settings.json
    settings_path = claude_dir / "settings.json"
    settings = {}
    if settings_path.exists():
        settings = json.loads(settings_path.read_text())

    hooks_config = json.loads((gcfg / "hooks-config.json").read_text())
    settings["hooks"] = hooks_config["hooks"]

    settings_path.write_text(json.dumps(settings, indent=2) + "\n")
    print(f"✓ Merged hooks config into ~/.claude/settings.json")
    print()
    print("Done! Restart Claude Code for hooks to take effect.")

# Uninstall: remove symlinks + remove hooks from settings
uninstall:
    #!/usr/bin/env python3
    import json
    from pathlib import Path

    claude_dir = Path.home() / ".claude"

    for name in ["hooks", "commands", "CLAUDE.md"]:
        target = claude_dir / name
        if target.is_symlink():
            target.unlink()
            print(f"✓ Removed symlink: ~/.claude/{name}")
            backup = Path(str(target) + ".bak")
            if backup.exists():
                backup.rename(target)
                print(f"✓ Restored backup: ~/.claude/{name}.bak")
        else:
            print(f"  ~/.claude/{name} is not a symlink — skipped")

    # 3. Remove hooks from settings.json
    settings_path = claude_dir / "settings.json"
    if settings_path.exists():
        settings = json.loads(settings_path.read_text())
        if "hooks" in settings:
            del settings["hooks"]
            settings_path.write_text(json.dumps(settings, indent=2) + "\n")
            print("✓ Removed hooks from ~/.claude/settings.json")

    print()
    print("Done! Restart Claude Code for changes to take effect.")

# ─── Hooks ───────────────────────────────────────────────

# Test a hook script (e.g. just hook-test pre_tool_use)
hook-test name:
    echo '{"session_id":"test-hook","tool_name":"Bash","tool_input":{"command":"echo hello"},"tool_use_id":"tu_test1"}' | uv run {{project_root}}/global_claude_config/hooks/{{name}}.py

# Send a test event to the observability server
test-event:
    curl -s -X POST http://localhost:4000/api/events \
      -H "Content-Type: application/json" \
      -d '{"session_id":"test-123","project_dir":"/tmp/test","source_app":"test","event_type":"SessionStart","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}'
    @echo ""
    @echo "Check dashboard at http://localhost:4000"

# List all hook scripts
hooks:
    @ls -1 {{project_root}}/global_claude_config/hooks/*.py | xargs -I{} basename {} .py

# ─── Health ──────────────────────────────────────────────

# Check if observability server is running
health:
    @curl -sf http://localhost:4000/health > /dev/null 2>&1 \
      && echo "Observability: UP (http://localhost:4000)" \
      || echo "Observability: DOWN — run 'just start'"

# Open dashboard in browser
open:
    open http://localhost:4000

# ─── Cleanup ─────────────────────────────────────────────

# Clean local hook log files
clean-logs:
    rm -rf {{project_root}}/logs/*
    @echo "Local hook logs cleared"
