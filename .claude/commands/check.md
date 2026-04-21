---
description: Run lint and tests across both siblings, sequentially.
---

Full quality pass across the workspace:

```sh
npm run lint
npm run test
```

Both run sequentially (fe → be) so output is readable. Exit code is non-zero if any repo failed; a summary block at the end shows pass/fail per repo.
