---
description: Review a GitHub pull request efficiently using minimal API calls
userInvocable: true
arguments: PR URL or owner/repo#number
---

# Review a GitHub Pull Request

You are reviewing a GitHub pull request. Extract the owner, repo, and PR number from the user's input.

## Step 1: Fetch everything in exactly 2 parallel requests

Use WebFetch to make these two calls **in parallel**:

1. **PR metadata** — `https://api.github.com/repos/{owner}/{repo}/pulls/{number}`
   - Prompt: "Extract: title, body/description, author, base branch, head branch, state, number of changed files, additions, deletions. Return all fields verbatim."

2. **File patches** — `https://api.github.com/repos/{owner}/{repo}/pulls/{number}/files`
   - Prompt: "For EVERY file EXCEPT package-lock.json and any other lockfiles (yarn.lock, pnpm-lock.yaml), return the complete 'patch' field content exactly as-is, prefixed with the filename. Include every line of every patch - do not summarize, truncate, or skip any content. I need the full diffs for code review."

Do NOT fetch individual files or raw file contents. The patches contain everything needed.

### Files to always skip in review

- package-lock.json
- yarn.lock
- pnpm-lock.yaml
- Any auto-generated lockfiles

## Step 2: Analyse and report

Review the diff holistically. Organise findings into these categories:

### Security

- Input validation gaps (client-side only, missing server-side checks)
- Authentication/authorisation issues
- Injection risks (SQL, XSS, command injection)
- Secrets or credentials in code
- CSRF considerations for state-changing endpoints

### Correctness

- Logic errors, off-by-one, null/undefined handling
- Missing error handling for external calls
- Race conditions or state management issues

### Code quality

- Naming, readability, duplication
- Consistency with surrounding codebase patterns
- Test coverage gaps (are new paths tested?)

### GDS/GOV.UK compliance (if frontend changes)

- Accessibility (ARIA, labels, error summaries)
- Design system component usage
- Back links, breadcrumbs, page titles

### Nits (keep brief)

- Minor style or formatting issues

## Output format

Start with a one-line summary of what the PR does, then a table:

| Area         | Status |
| ------------ | ------ |
| Security     | ...    |
| Correctness  | ...    |
| Code quality | ...    |
| Tests        | ...    |

Then list findings grouped by category. For each finding, reference the file and relevant diff context. End with an overall assessment.

Skip categories with no findings rather than saying "looks good".
