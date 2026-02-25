---
model: haiku
description: Remove a git worktree and optionally delete its branch
argument-hint: <branch-name>
allowed-tools: Bash
---

# Remove Git Worktree

## Variables

```
BRANCH_NAME: $1 (required)
```

## Workflow

1. Error if no BRANCH_NAME provided
2. Remove worktree: `git worktree remove .worktrees/<BRANCH_NAME>`
   - If fails, try: `git worktree remove .worktrees/<BRANCH_NAME> --force`
3. Delete branch: `git branch -d <BRANCH_NAME>` (use `-D` if unmerged)
4. Verify with `git worktree list`

Report what was removed.
