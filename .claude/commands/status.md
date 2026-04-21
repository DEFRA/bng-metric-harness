---
description: Show git status and current branch for harness + both sibling repos.
---

Report uncommitted work and current branch across the workspace:

```sh
npm run status
npm run branch
```

`status` prints `git status --short` for each repo with a header. `branch` shows a side-by-side table of each repo's current branch.
