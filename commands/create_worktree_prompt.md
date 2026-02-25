---
model: haiku
description: Create a git worktree with isolated branch for parallel development
argument-hint: <branch-name>
allowed-tools: Bash, Read, Glob, Grep
---

# Create Git Worktree

Create a new git worktree in `.worktrees/<BRANCH_NAME>` for isolated parallel development.

## Variables

```
BRANCH_NAME: $1 (required)
WORKTREE_BASE: .worktrees
WORKTREE_DIR: .worktrees/<BRANCH_NAME>
```

## Workflow

1. **Validate**: Error if no BRANCH_NAME provided
2. **Create directory**: `mkdir -p .worktrees`
3. **Create worktree**:
   - Try: `git worktree add .worktrees/<BRANCH_NAME> <BRANCH_NAME>`
   - If branch doesn't exist: `git worktree add -b <BRANCH_NAME> .worktrees/<BRANCH_NAME>`
4. **Verify**: `git worktree list | grep .worktrees/<BRANCH_NAME>`

## Report

```
Worktree created:
  Branch:   <BRANCH_NAME>
  Location: .worktrees/<BRANCH_NAME>

To work in it:  cd .worktrees/<BRANCH_NAME>
To remove it:   git worktree remove .worktrees/<BRANCH_NAME>
```
