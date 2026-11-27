## Uploading every example file

`npm run test:uploads` uploads every example GeoPackage in `example-files/`
through the backend's own upload code, and fails if the service accepts a file
it should refuse, or refuses one it should accept. CI runs it on every pull
request to this repo and to the backend, against the backend code in that pull
request, so an unexpected change in what the service accepts is seen on the
change that made it.

```sh
npm run install:be      # once: the test runs the backend checked out beside the harness
npm run test:uploads    # both corpora
npx vitest run tests/scripts/example-uploads/legacy-uploads.test.mjs   # one corpus
```

`BNG_BACKEND_DIR` names another backend checkout, such as a worktree of a
backend branch. Without an installed backend the upload tests skip, unless
`REQUIRE_BACKEND=true`, as CI sets, when they fail instead.

### What each file should do

**The folder a file is in says whether it should be accepted.** Each corpus,
the legacy template's (`example-files/`) and the BNG Service template's
(`example-files/service-template/`), has the same folders:

| Folder | Should be |
| --- | --- |
| `valid/` | accepted |
| `incomplete/` (BNG Service template only) | accepted, with the features it is named for saved Incomplete |
| `spatial-problems/`, `invalid-schema/`, `empty-layer/`, `attribute-problems/`, `malformed/`, `filename-problems/`, `lineage-problems/`, `version-problems/` | refused |
| `bng-500/` | not uploaded: real survey data, accepted or refused as the site happens to be |
| `permutations/` | not uploaded: the scenario corpus, which `npm run compare:metric` uploads and compares with the metric |

A folder not in this table fails the test, so a new folder cannot be left out
of it unnoticed. A file added to one of these folders is tested from then on.

`scripts/example-uploads/expectations.mjs` holds the table. **The folder is
the whole answer**: there are no exceptions. A file the service accepts, such
as a baseline with no hedgerows, is in `valid/` or `incomplete/`, however
unusual it is; a file in a folder of problems is refused.

A flaw the service does not refuse yet has no file until it does. The BNG
Service template's README lists it under Gaps, from `GAPS` in
`scripts/service-template/recipes.mjs`; an irreplaceable area habitat is one.
Once the backend change that refuses it has merged, add the file to the
folder of problems in a harness change. The backend runs this test at harness
`main`, so the order matters: a file added first would fail every backend
pull request until the backend refused it.

The BNG Service template's README writes an Expected cell for every file
from the recipes. A test holds each cell to the file's folder, so a recipe
whose Expected cell says accepted cannot sit in a folder of problems.

### How a file is uploaded

As a user uploads it, at the endpoint its name says:

- A legacy baseline file goes to the baseline upload, and a legacy
  post-intervention file (`Post-intervention - …` or `…-post-intervention.gpkg`)
  to the post-intervention upload, on its own. A legacy post-intervention
  upload rebuilds the baseline from the file's own Baseline columns, so it needs
  no baseline before it.
- A BNG Service template file holds both stages, so it goes to the baseline
  upload and then, onto the project that left, to the post-intervention
  upload. A baseline-stage file (`…-baseline.gpkg`) goes to the baseline upload
  only.

Each upload runs the backend's checks in the validate route's order: first the
upload's metadata, the filename included (the route's own
`habitatDataSchema`), then `importUploadFile`: the format gate, the geometry and
data-quality checks, and the documents the save would write (see
[Comparing the service with the metric](compare-metric.md)). It needs no S3,
CDP Uploader, worker pool or database. The backend's service-template flag is
off for the legacy corpus and on for the BNG Service template's, as the
service reads one template or the other.

A file is accepted when every upload is. If the service throws, that is a
wrong result whatever the file expects.

### What a failure says

Each file is a test of its own, named by its path under `example-files/`. A
wrong result fails that test with the file, whether it should have been
accepted or refused, and what happened, with the upload that refused it and
its error codes:

```
valid/Baseline - three rlb polygons.gpkg should have been accepted, and was refused at the baseline upload with GPKG_RLB_TOO_MANY_POLYGONS
```

In CI, the same goes to the run's job summary, as a table of every wrong result
for each corpus, followed by the known gaps.

### Where it runs in CI

In its own workflow, **Example file uploads**
(`.github/workflows/example-file-uploads.yml`), as one check, `Upload every
example file`. It runs on this repo's pull requests (against the backend branch
of the same name if there is one, otherwise the backend's `main`), merge
groups and pushes to `main`. The backend calls it (`workflow_call`) with the
commit under test on each of its pull requests, merge groups and pushes to
`main`, from its own `example-file-uploads.yml`, so a pull request there is
checked against its own code. A wrong result fails the check.

The backend calls the workflow at this repo's `main`, so a change to the test
reaches the backend's pull requests once it merges here. For the check to
block a merge, a ruleset must require it; that is set in each repo's settings,
not here.

The backend is checked out and installed by
`.github/actions/check-out-backend`, which the metric comparison uses too.
