# Customer-facing error text

How the BNG service keeps every error message a customer can see consistent
and maintainable: the backend owns the error codes, the frontend keeps all
their wording in one file, and a check holds the two together.

This page is the implementation plan for that, and the rules once it is in
place. Step 1 is done (see [Status](#status)); steps 2 to 4 are to come.

## Why

Before this work, only the upload drop-out page had its wording in one place
(`dropout-copy.yaml`). Everything else was spread out:

| Kind of error | Where its wording lived | Problem |
| --- | --- | --- |
| Upload drop-out page | `src/server/error-file/dropout-copy.yaml`, by backend code | The one that worked. 62 codes still show the backend's developer message as a list heading, and 5 show "PLACEHOLDER – …" |
| On-screen edits | JS constants in `common/helpers/habitat-ref.js` | Only `HABITAT_REF_IN_USE` was handled. `ENHANCEMENT_NOT_VALID` and the out-of-scope check fall through to a generic page |
| Form field validation | Inline in each controller, or Joi `.messages()` | No shared helper or pattern |
| Error pages (404, 500, …) | A hard-coded switch on HTTP status in `common/helpers/errors.js` | No "service unavailable" page |
| Upload refused by the CDP uploader (virus, too large, wrong type) | None | The user always sees "We couldn't accept your file. Please try again." |

The backend had one registry of 81 codes (`ERROR_CODES` in
`src/validation/geopackage/errors.js`), but it mixed upload and edit codes
without saying which was which, and every other route (projects, saving edits,
auth, reports) answered with an HTTP status and no code.

## The design

### 1. The backend owns the codes

- Every refusal a customer can meet has a code in `ERROR_CODES`.
- `ERROR_CODE_SURFACES` says where a customer meets each code: `upload` (the
  drop-out page), `edit` (the page where a habitat is changed), or both. Every
  code is an upload code unless the backend lists it otherwise.
- A code's `message` is developer text, for logs. It is never the wording a
  customer should see.

### 2. The frontend keeps all wording in one file

`src/server/common/error-text/error-text.yaml`, in a section for each surface:

| Section | What it words | Keyed by |
| --- | --- | --- |
| `upload` | The drop-out page (the former `dropout-copy.yaml`, unchanged) | Backend code |
| `edit` | A refusal of a change made on screen: `summary` for the error summary, `inline` by the field | Backend code |
| `forms` | A field's own validation, before anything reaches the backend | Field, then rule |
| `request` *(step 2)* | Error pages: not found, conflict, service unavailable | Backend code, then HTTP status |

`placeholder` anywhere means the wording is awaiting UCD. Product, BAs and UCD
change the wording by pull request to this one file.

`common/error-text/error-text.js` reads the file once and checks its shape, so
a slip fails the tests and the server's start rather than a user's page. Pages
look wording up by section and code (`editErrorText(code)`,
`formErrorText(field, rule)`); the drop-out page reads `upload` through
`error-file/dropout-copy.js`, as before.

### 3. One check holds them together

`npm run check:dropout-copy`, in this repository, compares the two:

- every backend `upload` code has an entry under `upload.errors`, and every
  `edit` code one under `edit`;
- neither section keeps an entry for a code the backend no longer has, or, in
  `edit`, for one that refuses no edit.

In GitHub Actions it writes what it found, for a reader who is not a
developer, to the run's job summary: a verdict, each problem, and what to do.

## Adding or changing an error

**A developer adding a refusal** to the backend:

1. Add its code to `ERROR_CODES`, with a doc comment saying what it checks.
2. If a customer meets it anywhere but the drop-out page, list it in
   `ERROR_CODE_SURFACES`'s edit-only or upload-and-edit set.
3. In bng-metric-frontend, add an entry to `error-text.yaml` in each section
   the code belongs in: wording agreed with UCD, or `placeholder`.

The check fails until step 3 is done.

**UCD changing wording**: edit the entry in `error-text.yaml` by pull request.
The file's header explains each field; the frontend's tests check its shape.

## Status

| Step | What | State |
| --- | --- | --- |
| 1 | Backend `ERROR_CODE_SURFACES`; frontend `error-text.yaml` with `upload`, `edit` and a first `forms` entry; the check reads both and compares the edit section | Done: bng-metric-backend `BMD-1083-error-surfaces`, bng-metric-frontend `BMD-1083-error-text`, bng-metric-harness `BMD-1083-error-text-check` |
| 2 | Codes for the remaining customer-facing refusals (not found, edit conflicts, the CDP uploader's rejections); a `request` section; a "service unavailable" page; show `ENHANCEMENT_NOT_VALID` and `HABITAT_DISTINCTIVENESS_NOT_IN_SCOPE` on the edit pages | To do |
| 3 | Field validation wording into `forms`, page by page as each is touched, with a shared GOV.UK error-summary helper | To do |
| 4 | UCD words the backlog: the `upload` entries still `catch-all`, `service-message` or `placeholder`, and the `edit` placeholders | To do |

### Step 1's pull requests, and the order to merge them

1. **bng-metric-harness** (builds on DEFRA/bng-metric-harness#215) reads
   `error-text.yaml` or, in an older frontend, `dropout-copy.yaml`, and the
   backend's surfaces or, for an older backend, the explainer's notes. It
   passes against every mix of old and new, so merge it first.
2. **bng-metric-backend** adds `ERROR_CODE_SURFACES`. Nothing but the check
   reads it, so it is safe at any point.
3. **bng-metric-frontend** moves the copy into `error-text.yaml`. Merge it
   after the harness change: the check on the harness's `main` before it looks
   only for `dropout-copy.yaml`.

After step 1, re-run `/geopackage-validation-explainer` so the validation
document links to `error-text.yaml` on the frontend's `main`.

## Decisions

- **One file, not one per section**, so there is one place to look and one
  file to review. Sections keep it navigable; at about 1,500 lines with forms,
  the header's section list is the contents page.
- **Surfaces, not one kind per code**: `HABITAT_DISTINCTIVENESS_NOT_IN_SCOPE`
  is met both on upload and on an edit.
- **The backend declares surfaces; nothing infers them.** Where a code is
  raised does not reliably say where a customer meets it.
- **No i18n library yet.** The service is English only; keyed YAML keeps the
  door open for Welsh without the cost now.
