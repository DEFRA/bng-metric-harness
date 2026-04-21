---
description: Pull latest and install deps across harness + both siblings.
---

Bring the workspace up to date:

```sh
npm run pull
npm run install:all
```

`pull` is fast-forward-only — if a repo has diverged or local changes, it warns and moves on rather than erroring.
