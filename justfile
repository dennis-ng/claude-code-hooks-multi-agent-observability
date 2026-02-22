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

# ─── Hooks ───────────────────────────────────────────────

# Test a hook script (e.g. just hook-test pre_tool_use)
hook-test name:
    echo '{"session_id":"test-hook","tool_name":"Bash","tool_input":{"command":"echo hello"},"tool_use_id":"tu_test1"}' | uv run {{project_root}}/.claude/hooks/{{name}}.py

# Send a test event to the observability server
test-event:
    curl -s -X POST http://localhost:4000/api/events \
      -H "Content-Type: application/json" \
      -d '{"session_id":"test-123","project_dir":"/tmp/test","source_app":"test","event_type":"SessionStart","timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}'
    @echo ""
    @echo "Check dashboard at http://localhost:4000"

# List all hook scripts
hooks:
    @ls -1 {{project_root}}/.claude/hooks/*.py | xargs -I{} basename {} .py

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
