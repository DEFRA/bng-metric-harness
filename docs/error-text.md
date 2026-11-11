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
  customer should see, and the frontend never shows it.
- `ERROR_CODE_DETAILS` says what else an error sends for the frontend to word
  it. **Values**: anything the message names from the file, such as a layer
  name or an area, sent raw in `details` (a number as a number). **Variants**:
  when one code words a problem more than one way, `details.variants` names
  the way, for example `bng-service` for the BNG Service template's wording
  of a check the legacy template shares.

### 2. The frontend keeps all wording in one file

`src/server/common/error-text/error-text.yaml`, in a section for each surface:

| Section | What it words | Keyed by |
| --- | --- | --- |
| `upload` | The drop-out page (the former `dropout-copy.yaml`, unchanged) | Backend code |
| `edit` | A refusal of a change made on screen: `summary` for the error summary, `inline` by the field | Backend code |
| `forms` | A field's own validation, before anything reaches the backend | Field, then rule |
| `request` *(step 2)* | Error pages: not found, conflict, service unavailable | Backend code, then HTTP status |

Wording that is not final says so with a `wording` field on its entry, in any
section: `wording: interim` is shown but UCD has not reviewed it, and
`wording: none` has no words of its own yet, so the page shows a generic
message. An entry with no `wording` field is final. An older frontend wrote
`placeholder` in the entry's place instead, which the current one refuses, so
the check below advises whichever the frontend it reads takes. Product, BAs and
UCD change the wording by pull request to this one file.

The drop-out page has two designs, and an `upload` entry words its error for
each:

- `singleProblemPage`: the page shown when the error is the file's only
  problem, a title and a sentence of its own, or the name of a shared page
  (`catch-all`, `file-problem` or `service-problem`). It can give `one` and
  `several` versions, for an error that names one habitat and for one that
  names more. An entry with no `singleProblemPage` is shown in the problems
  list even alone.
- `problemsList`: the error's heading on the page that lists a file's
  problems, and its bullets.

An older frontend names them `whenAlone` and `inList`, and says
`whenAlone: list` for an error shown in the list even alone. The checks below
read either.

A `problemsList` heading can name `{values}` from the error's details, and
give a `variants` entry for each way the backend words the problem. Its bullets
are an `item` for each habitat the error lists, filled from that habitat, or,
for an error that lists none, one `detail`, filled from the error's details.
`problemsList: catch-all` heads the list with the catch-all title, for a code
the page never lists. A code with no entry, or whose details lack a value its
heading names, also shows the catch-all title: never the backend's message.

`common/error-text/error-text.js` reads the file once and checks its shape, so
a slip fails the tests and the server's start rather than a user's page. Pages
look wording up by section and code (`editErrorText(code)`,
`formErrorText(field, rule)`); the drop-out page reads `upload` through
`error-file/dropout-copy.js`, as before.

### 3. One check holds them together

`npm run check:error-codes`, in this repository, compares the two:

- every backend `upload` code has an entry under `upload.errors`, and every
  `edit` code one under `edit`;
- neither section keeps an entry for a code the backend no longer has, or for
  one that does not belong there: an `upload` entry for a code met only on an
  edit, or an `edit` entry for one that refuses no edit;
- no `upload` entry shows the backend's message (`inList: service-message`, in an older frontend),
  has a heading or `detail` that names a `{value}` the backend does not list
  for the code in `ERROR_CODE_DETAILS`, or has a variant the backend never
  names; and the wording has a variant for every one the backend can name.
  An `item` names a habitat's values, which the backend does not list, so it
  is not checked.

If the backend's `errors.js` will not load, the check fails and says so,
rather than quietly checking less.

In GitHub Actions it writes what it found, for a reader who is not a
developer, to the run's job summary: a verdict, each problem, and what to do.

## Adding or changing an error

**A developer adding a refusal** to the backend:

1. Add its code to `ERROR_CODES`, with a doc comment saying what it checks.
2. If a customer meets it anywhere but the drop-out page, list it in
   `ERROR_CODE_SURFACES`'s edit-only or upload-and-edit set.
3. If its message names a value from the file, send the value in `details`
   too, and list it in `ERROR_CODE_DETAILS`; likewise each variant, if the
   code words the problem more than one way.
4. In bng-metric-frontend, add an entry to `error-text.yaml` in each section
   the code belongs in: wording agreed with UCD, or `wording: none`. A value the
   wording names needs its format in the drop-out page's `DETAIL_VALUES`
   (`error-file/controller.js`).

The check fails until step 4 is done.

**UCD changing wording**: edit the entry in `error-text.yaml` by pull request.
The file's header explains each field; the frontend's tests check its shape.

## Status

| Step | What | State |
| --- | --- | --- |
| 1 | Backend `ERROR_CODE_SURFACES`; frontend `error-text.yaml` with `upload`, `edit` and a first `forms` entry; the check reads both and compares the edit section | Done: bng-metric-backend `BMD-1083-error-surfaces`, bng-metric-frontend `BMD-1083-error-text`, bng-metric-harness `BMD-1083-error-text-check` |
| 2 | Codes for the remaining customer-facing refusals (not found, edit conflicts, the CDP uploader's rejections); a `request` section; a "service unavailable" page; show `ENHANCEMENT_NOT_VALID` and `HABITAT_DISTINCTIVENESS_NOT_IN_SCOPE` on the edit pages | To do |
| 3 | Field validation wording into `forms`, page by page as each is touched, with a shared GOV.UK error-summary helper | To do |
| 4 | UCD words the backlog: the entries marked `wording: none` or `wording: interim`, and the `upload` entries on a shared fallback | To do |
| — | No backend message on the drop-out page: the backend sends the values and variants its messages name (`ERROR_CODE_DETAILS`), the frontend words every upload code from them, and the check compares the two | Done, but for the check: DEFRA/bng-metric-backend#619 and DEFRA/bng-metric-frontend#479 are merged; DEFRA/bng-metric-frontend#480 and DEFRA/bng-metric-harness#225 are in review |

### The details pull requests, and the order to merge them

1. **bng-metric-backend** (DEFRA/bng-metric-backend#619, merged) adds the
   values and variants to `details`, and `ERROR_CODE_DETAILS`.
2. **bng-metric-frontend** (DEFRA/bng-metric-frontend#479, merged) words every
   upload code from them.
3. **bng-metric-frontend** (DEFRA/bng-metric-frontend#480) names the one bullet
   of an error that lists no habitats `detail`, apart from a habitat's `item`,
   so the check can tell which bullets the backend's values fill.
4. **bng-metric-harness** (DEFRA/bng-metric-harness#225) checks headings and
   details against `ERROR_CODE_DETAILS`. It passes on the frontend's `main`
   with or without step 3, but checks the bullets only once step 3 is merged.

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
