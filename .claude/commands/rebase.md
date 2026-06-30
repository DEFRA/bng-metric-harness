---
description: Rebase the current branch of a sibling repo onto origin/main.
argument-hint: backend|frontend|library|journey-tests|prototype
---

Rebase the named sibling's current branch onto the latest `origin/main`.

The argument selects the target repo: `backend` → `../bng-metric-backend`, `frontend` → `../bng-metric-frontend`, `library` → `../bng-library`, `journey-tests` → `../bng-metric-journey-tests`, `prototype` → `../bng-metric-digital-prototype`. If no argument is given, ask which repo to target — do not guess.

## Procedure

Run from the chosen sibling's directory. Use absolute paths (`path.resolve(import.meta.dirname, '..', '..', '<repo>')`-style); never `cd` interactively.

1. **Pre-flight checks** (abort with a clear message if any fail):
   - Confirm the working tree is clean: `git status --porcelain`. If output is non-empty, stop and report — the user must commit, stash, or discard first.
   - Confirm the current branch is not `main`. If it is, stop and explain there's nothing to rebase.
   - Show the user the current branch and the number of commits ahead/behind `origin/main` so they know what's about to move.

2. **Create a safety branch** at the current tip if one doesn't already exist:
   ```sh
   git branch <current-branch>-backup
   ```
   If the backup branch already exists, leave it alone and tell the user it's still pointing at the prior tip.

3. **Fetch and rebase**:
   ```sh
   git fetch origin
   git rebase origin/main
   ```

4. **Conflict handling**:
   - If `git rebase` exits non-zero with conflicts: list the conflicted files (`git status --short`), stop, and hand back to the user. Do **not** attempt automated resolution — the user resolves, then runs `git rebase --continue` (or asks you to verify).
   - If the user resolves and asks you to continue, run `git rebase --continue` and loop on conflicts until the rebase finishes or the user aborts (`git rebase --abort`).

5. **Post-rebase summary**: report the new commit list (`git log origin/main..HEAD --oneline`) and stop. Do **not** force-push automatically.

## Force-push (only on explicit request)

If — and only if — the user asks to push the rebased branch, use `--force-with-lease` (never plain `--force`):

```sh
git push --force-with-lease
```

Refuse to force-push to `main` or `master` under any circumstance.

## Optional follow-up: squash

If the user asks to squash the branch into a single commit after the rebase, the simplest path is:

```sh
git reset --soft origin/main
git commit -m "<branch-aligned message>"
```

Confirm the message with the user before committing. Then they can `git push --force-with-lease`.
