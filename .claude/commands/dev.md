---
description: Start both frontend and backend in parallel from the workspace root.
---

Run both sibling apps with one command. Shell out via the harness script:

```sh
npm run dev
```

Both `[fe]` (cyan) and `[be]` (magenta) will stream to the same terminal; any crash kills both.

If a sibling repo is missing, run `npm run bootstrap` first.
