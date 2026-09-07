# Deriving the baseline from the post-intervention file alone

**BMD-1001 · spike · status: analysis complete; backend derivation built behind a feature flag**

Whether the full BNG calculation can be produced from a single post-intervention
upload in the **unaltered** Natural England QGIS template, what that costs, and
what an ecologist would have to do for it to be right.

Companion to the options paper *Reconciling post-intervention with baseline*.
This document covers Option B only, and replaces its section 8 open questions
with answers where the code or the template settles them.

---

## 1. The idea in one paragraph

Every habitat row in the NE template holds **baseline and proposed values side by
side, over one shape**. So a post-intervention row already states what was there
before as well as what will be there after. What the file loses is the baseline
*parcel list*: where one baseline parcel was divided by the scheme, the original
shape no longer exists anywhere in the file. The derivation reconstructs that
list by grouping rows whose baseline attributes are identical and whose shapes
adjoin, and rebuilds every baseline figure from the post-intervention geometry.

---

## 2. Feasibility verdict

| Habitat type | Verdict | Why |
| --- | --- | --- |
| **Area habitats** | **Yes, with guidance** | Every engine input is already on the row except size, and size is recoverable exactly. Area habitats must account for the whole red line — the existing `AREA_SUM_MISMATCH` check enforces that to 0.5 m² and *rejects* any file that fails — so summing the measured parcels reconstructs the baseline area in full. What remains is **attribute** coverage: a row can tile its share of the site and still leave its baseline columns blank. That is fully detectable and quantifiable. |
| **Hedgerows** | **Yes, with guidance** | Units need only length, type and condition, all on the row, and the length is **exact** wherever the file accounts for every metre that existed — a partly-removed hedge split into a `Retained` row and a `Lost` row reconstructs to its full surveyed length (§4). The gap is **completeness**, not arithmetic, and it rests entirely on guidance: nothing ties the hedgerow layer to the red line, so a hedge removed without a row left behind is invisible and indistinguishable from one that never existed. |
| **Watercourses** | **Yes, with guidance** | As hedgerows, plus two specifics. Re-meandering — the one case where the post-intervention length legitimately exceeds the baseline — is recoverable only through the template's dedicated meanders layer, which **could not be read at all** until this spike (see §7). And a missing encroachment value silently defaults to a multiplier of 1, which inflates the baseline; detectable and reported. |
| **Individual trees** | **Yes, with guidance** | Arithmetically the cleanest case. A tree's baseline area is a four-band reference lookup with no geometry, no adjacency and no merging — and it is *already computed correctly on every post-intervention upload today and thrown away*. Same completeness gap as the linear layers, and a felled tree left as a `Lost` row counts toward the baseline exactly as it should. |
| **Vertical area habitats, irreplaceable habitats** | **No** | The NE template has no columns for green walls, green roofs, intertidal hard structures as vertical area, or irreplaceable habitat. If a site has any, they are absent from **both** sides of the calculation. This is a template limitation, not a derivation one — it applies equally to the existing two-upload journey. |

---

## 3. Reassembling divided area parcels

Rows are grouped on **baseline broad habitat type, baseline habitat type,
baseline condition, baseline strategic significance and location**. Groups are
then tested geometrically: two parcels are treated as parts of one original where
they share a boundary longer than a small absolute floor **and** longer than 2%
of the smaller parcel's perimeter.

Three deliberate exclusions from the grouping key:

- **Retention category is not in the key.** Verified against the corpus fixture
  `example-files/valid/Post-intervention - complete.gpkg`, where the ten parts of
  one divided parcel carry *Lost*, *Retained* and *Enhanced* between them.
  Retention describes the intervention — precisely what differs between the parts
  of a split.
- **Parcel reference is not in the key.** It defaults to the literal string
  `Null` on untouched rows, so keying on it would merge every unfilled row.
  Agreement between real references raises confidence; disagreement is reported.
- **Baseline distinctiveness is not in the key.** It is a strict one-to-one
  function of habitat type across every row of the reference data, so it adds
  nothing. It is recomputed instead, and a mismatch is reported.

### Measured proof that the premise holds

Run against the corpus pair `Baseline - complete with area refs.gpkg` and
`Post-intervention - complete.gpkg`, using the service's own GEOS loader, the ten
post-intervention parts of parcel `H2` reconstruct the baseline parcel **exactly**:

| Parcel | Baseline file | Post-intervention file, parts summed |
| --- | --- | --- |
| H1 | 675.289 m² | 675.289 m² |
| **H2** | **13 607.588 m²** | **13 607.588 m²** (H2-1 … H2-10) |
| H3 | 567.275 m² | 567.275 m² |
| **Site total** | **14 850.152 m²** | **14 850.152 m²** |

Identical to the milli-square-metre, not merely close. Area is conserved across a
division because the same ground is being described either way.

The same run shows why the `Area` column can never be used: baseline `H2` records
`2460` against a measured `13 607.588`, and `H2-1` records `127` against a
measured `7 850.142` — wrong by factors of about 5 and 62. The column is a QGIS
convenience that tracks whatever the geometry was when the row was last touched,
and in this corpus it is simply stale. The service measures the shape.

### Why the threshold is low-risk

The grouping key already pins habitat type and condition, so every member of a
group resolves to the same distinctiveness and condition scores. Baseline units
are `size × distinctiveness × condition`. For **any** partition of a group,
`Σ units = (Σ sizes) × distinctiveness × condition`.

**So the adjacency threshold cannot change the habitat unit total, cannot change
the net-change percentage, and cannot change the >10% verdict.** It changes only
the parcel list an assessor reads. That is why a permissive threshold is the
right default: a false merge costs nothing arithmetically, while a false split
degrades the list a human has to reconcile against the survey.

**2% is an opening value, not an evidenced one.** There is no ground truth in the
repository to set it against. Every real upload records its own merge evidence —
shared length, both perimeters, both fractions, and whether the shared edge was a
single straight segment — so the threshold can be set from evidence later.

One ambiguity is irreducible: no threshold separates "one parcel split down the
middle" from "two parcels that always abutted". Two 10×10 squares sharing a full
edge read identically either way. That is handled by labelling, not by geometry.

### Naming a reassembled parcel

Where every part is a numbered piece of one name — `H2-1` … `H2-10` — the
reassembled parcel takes that name, and records that **the service chose it**.
Parts named any other way get a composite that claims nothing.

Only the *label* is ever inferred. The parcel is put back together from geometry
and matching attributes before any reference is read, and every source row is
listed alongside it, so the naming guess cannot move a number or change which
rows were joined. That keeps the options paper's objection to reference-based
lineage intact: nothing here depends on a naming practice being followed.

---

## 4. Linear features: where the original length comes from

**The template cannot carry it.** The `Length` and `Area` columns are QGIS
default-value expressions with `applyOnUpdate="1"`:

```xml
<default applyOnUpdate="1" field="Area"   expression="$area"/>
<default applyOnUpdate="1" field="Length" expression="$length"/>
```

which means QGIS **rewrites them from the geometry every time the feature is
edited**. They track the current shape and can never hold an earlier value. The
corpus proves the corollary: in the split fixture, row `H2-3` carries `2460` —
the *whole parent parcel's* area — on a row that is one tenth of it. The service
measures the geometry and never reads these columns.

So for an enhanced hedgerow or watercourse the baseline length is taken from the
**row's own post-intervention geometry**, with the meanders layer as the escape
route where a watercourse was realigned.

### Which way that errs — it cuts both ways

The engine clamps the baseline length **down** to the post-intervention length
whenever post ≤ baseline (`resolveEnhancedLinearLengths`). So:

- for any feature whose alignment did not change, the derived figure is
  **numerically identical** to the two-upload result — verified on every
  Enhanced linear row in the permutations corpus;
- where the line was **lengthened**, the derived baseline is understated, so the
  reported gain is understated. An ecologist cannot inflate the >10% test by
  extending a line;
- where the line was **shortened, or partly removed, the error runs the other
  way**. The lost length was never in the derived baseline to be lost, so the
  loss simply disappears.

That last case is the serious one and it is easy to miss. Measured on the
shipped pair `Post-intervention - retained hedgerow.gpkg`: the two-upload
journey reports a hedgerow net change of **−1.368 units (−56.44%)**, and the
derived baseline reports **0 (0%)**. A real loss of more than half the hedgerow
units vanishes entirely.

So no single direction can be claimed for an assumed length, and the service
does not claim one — the finding records the bias as *unknown* and says both
directions out loud. This is the same limitation as §5's unbounded case, seen
from the arithmetic rather than from the parcel list: **what the file does not
contain, the derivation cannot miss.**

### The linear baseline is recoverable — by discipline rather than by a gate

The error above is not inherent to deriving from one file. It is the cost of a
**breach** of guidance, and the template already contains the mechanism that
prevents it.

A hedge is never shortened to show that part of it is going. It is **split**,
and the removed section gets its own row with retention **Lost**, drawn over the
ground it occupied. `Lost` is already in the template's retention vocabulary, so
this asks for discipline rather than a new convention — and, crucially, no
reference matching between rows.

Measured end to end from a GeoPackage, on one 200 m hedge of which 120 m is kept:

| How the file records it | Derived baseline |
| --- | --- |
| 120 m `Retained` **+ 80 m `Lost`** | **200 m** — the whole surveyed hedge |
| 120 m `Retained`, removed section deleted | 120 m — the loss is invisible |

The first row is exact. Nothing is inferred, no length is assumed, and the
`own-post-intervention-length` fallback never has to be reached, because every
retained and enhanced line keeps its own alignment.

That is why the derivation reads the layers **before** the Lost filter: a Lost
row is not noise to be discarded, it is the only evidence that a removed feature
ever existed.

**One thing this cannot do.** The two files above differ by one row, and nothing
inside the second distinguishes it from a site whose hedge was only ever 120 m
long. Both are structurally valid and both pass every check. So the guidance is
load-bearing in a way no engineering can replace — which is the subject of §6.

### Why a separate baseline layer is not the answer

A natural proposal is to ask users to record baseline and post-intervention
linear features as separate rows, paired by reference — the way the map already
*looks*, since the project ships `Hedgerow Baseline EDIT ME` and
`Hedgerows Proposed EDIT ME` as distinct layers a user can show and hide.

Those layers are not what they appear to be. The project contains **no layer
filters at all** — zero `subsetString` entries, and none in any datasource URI —
so all three hedgerow layers are unfiltered views of the *same rows in the same
table*, differing only in styling and which form fields are shown. A hedgerow
drawn once appears in all of them. They are three lenses on one row, not three
rows.

Asking for genuinely separate rows then runs into two blockers:

- **The template cannot say "this row records the baseline only."** It would have
  to be inferred from *baseline filled, proposed blank* — but the Hedgerows
  `Retention Category` default is the literal string `Null`, so a deliberate
  baseline-only row is byte-identical to one the surveyor has not finished.
- **It reintroduces reference matching.** Pairing rows by `Parcel Ref` is exactly
  the cross-row dependency §3.3 of the options paper argues against, and a file
  that ignores the convention looks identical to one that follows it.

The `Lost` decomposition above achieves the same result within the semantics the
template already has, and needs neither.

---

## 5. Trade-offs against the two-upload journey

### Exactly as good

- **Individual trees.** Baseline area is a band lookup already computed today.
- **Area-habitat unit totals.** Units are linear in area, area is conserved
  across a split, and the red-line check forces any accepted file to tile the
  site. However parcels group, the total is identical.
- **Enhanced linear features that were not lengthened**, and all retained and
  created linear features.

### Worse, but bounded and signed

- **Enhanced linear features that were lengthened.** Understates the gain, never
  overstates it. The meanders layer removes even this where it is used.

### Worse, and unbounded

- **Omitted hedgerows, watercourses and trees.** Nothing ties those layers to the
  red line. A feature removed *without a row left behind* is invisible: the
  baseline is understated, the net gain overstated, and **there is no ceiling on
  the error**. This is the strongest argument for keeping the two-upload journey
  available rather than retiring it.
- **Rows with blank baseline attributes.** Geometric coverage is guaranteed by
  the accept gate; attribute coverage is not. A row can tile its share of the
  site and say nothing about what was there.
- **The parcel list is an assumption, not a record.** Totals survive it; an
  assessor's reconciliation against the original survey does not.

---

## 6. What the service can check, and what it must take on trust

The verdict is withheld rather than published wherever the report itself has
raised a warning that pushes the gain **upwards** — so anything the service
knows might flatter the applicant stops a Met/Not-met answer being given, while
a finding that can only understate the gain does not.

**Checkable — each becomes a finding in the reconciliation report, carrying the
direction it pushes the net gain:**

1. Blank baseline attributes — count *and* area or length share
2. Conditions that cannot be assessed
3. Values outside the template's own controlled vocabularies, per layer
4. Distinctiveness disagreeing with the one-to-one lookup from its type
5. `Area` or `Length` disagreeing with the measured geometry — positive proof the
   file was edited outside QGIS
6. Retained area rows whose proposed habitat type differs from the baseline
7. Every merge group, with member references and both shared-boundary fractions
8. Duplicate, blank or literal-`Null` references
9. Meanders links that fail, in both directions
10. Rows producing no units at all — otherwise silently dropped from the totals
11. Red-line coverage and parcel overlaps — the **only** structural completeness
    guarantee, and it covers area habitats alone

**Must be taken on trust:**

1. That every hedgerow, watercourse and tree present before development is in the
   file, including removed ones
2. That each linear feature's baseline length equals its post-intervention
   length, unless the meanders layer was used
3. That two adjoining parcels with identical baseline attributes were one parcel,
   not two
4. That vertical-area and irreplaceable habitats are genuinely absent
5. That the dropdown values describe the site accurately

Item 1 cannot be turned into a check by any amount of engineering — "there were
no hedges" and "the surveyor did not draw them" are byte-identical files. The
only honest instrument is an **explicit declaration in the journey**, recorded as
a user attestation rather than dressed up as a service check.

---

## 7. Two defects found in the template and the gate

- **A trailing space in a column name.** The meanders layer's
  `Habitat created in advance/years ` column carries a trailing space — the only
  column in the entire template with stray whitespace. The service's column
  comparison lower-cases but does not trim, so **until this spike, no file
  containing a populated meanders table could be uploaded at all.** The one clean
  route out of the re-meandering problem was unreachable. Fixed by normalising
  both sides of the comparison.
- **The meanders layer was never read.** It was absent from the backend's layer
  aliases entirely, so even a well-formed file would have had it ignored.

---

## 7a. What the user actually sees

The derivation is only worth having if the journey reaches it, and two things
stood between the two.

**The upload landed on the previous design.** Baseline uploads have finished on
`/projects/{id}/project-summary` since those pages were built; post-intervention
uploads still fell through to `/projects/{id}/post-intervention-habitat-list`,
because only the baseline upload type carried a `successRoute`. Harmless while
every journey began with a baseline upload that had already taken the user to
the summary. Fatal here: with a post-intervention file alone, nothing else ever
routes there, so the current design was unreachable for the entire journey. The
habitat list keeps its job as the editing surface — every habitat detail page
still backs out to it.

**The summary pages could not see a derived baseline.** They read
`project.baseline` directly rather than going through `baselineData`, at six
sites. Because `hasBaselineData` *had* been updated, the redirect guards let the
pages render and they then contradicted themselves: a confident **0.00 units**
under "On-site baseline", beside a **+25.20%** net change calculated from the
derived baseline the tile was failing to show. A blank page would have been
safer than a wrong one. All six now read the same document the headline does.

Where a derived baseline is in play the tile says so three times over — the
heading reads *On-site baseline (derived)*, a grey **Derived** tag sits beside
it, and *How we worked this out* links to the derivation page. Where coverage is
insufficient the figures are still shown, because they are the best the file
supports, but the Met / Not met verdict is replaced by **Cannot be determined**
rather than published from a baseline the service knows it could not fully
account for.

**One thing deliberately left alone.** The task list at
`/add-project-details/{id}` still shows "On-site baseline habitats — Not yet
started" for a post-intervention-only project, and still links that row to the
upload page. That is accurate — no baseline file *was* uploaded — and the row is
the entry point to the optional baseline upload the corroboration depends on.
The project list no longer routes users through it: `has_baseline` now counts
either document, so a derived project opens straight on the summary.

---

## 8. Draft user guidance

No authoritative Natural England completion guidance exists to quote — the PDF
shipped with the template is a two-page cover sheet with no completion rules.
**Everything below is inferred from the template's own dropdown filters and
reference data. It is ours to author and own, must not be presented as an NE
requirement, and needs ecologist review before publication.**

Not all of it carries equal weight. **G3 and G4 are load-bearing**: they are the
only thing standing between the service and an overstated gain on the linear and
point layers, because those layers have no equivalent of the red-line rule that
makes area completeness enforceable. Everything else is either checkable, or
affects the parcel list rather than the numbers.

**One dependency on policy, not yet confirmed.** G4 tells a user that a
re-aligned linear feature is recorded as the old line `Lost` and the new line
`Created`. That is a policy question rather than an engineering one — creation
and enhancement do not score the same way, so treating a moved hedgerow as a
creation changes the answer even though the plants may be the same. The current
expectation is that moving a hedgerow does constitute creation, and confirmation
is being sought. **If policy decides otherwise, G4 needs rewriting and the
enhancement route needs a way to carry the original length** — which, for
hedgerows, the template does not have. Watercourses are unaffected either way,
because the meanders layer keeps both alignments as drawn geometry.

| # | Guidance | If ignored | Can we detect it? |
| --- | --- | --- | --- |
| G1 | Draw an area-habitat polygon over **every** part of the red line — no gaps, no overlaps. | Baseline area understated; the >10% test is wrong. | **Yes, fully.** The file is already *rejected*. |
| G2 | Fill all baseline columns on **every** area row, including parcels being built on. | The row contributes no baseline units, silently inflating net gain. | **Yes.** Reported with the count *and the area share*; above a threshold the verdict is withheld rather than published wrong. |
| **G3** | **Every metre of hedgerow and watercourse, and every tree, that exists today must appear as drawn geometry on some row.** Where part of a feature is removed, **split it into sections** — one row per section, each carrying the original baseline attributes, retention **Lost** for what goes and **Retained**/**Enhanced** for what stays. Never shorten a line to show that part of it is going. | The most serious failure: the removed length was never in the derived baseline, so the loss is never subtracted and the gain is overstated with no ceiling. | **No.** A file missing a `Lost` row is byte-identical to one describing a site that never had that feature. Mitigated only by an explicit user declaration, and by the report stating row counts, `Lost` counts and total derived length on every project. |
| **G4** | **Never re-draw a Retained or Enhanced line.** If the alignment changes, record the old line as **Lost** and the new line as **Created** — or, for a watercourse, use the meanders layer, which keeps both alignments (G7). | The row's own length is taken as its baseline length. Lengthening understates the gain; shortening overstates it. | **Partly.** A watercourse marked *Enhanced by Realignment* with no meanders child is reported, and so is an orphan child. For hedgerows there is no equivalent signal — the assumption is recorded on the feature and in the report, with its direction stated as unknown. |
| G5 | Where one parcel is divided, give every part the **same** parcel reference and identical baseline attributes. | The reassembly groups wrongly; the parcel list will not reconcile with the survey. | **Partially.** We can see adjoining rows that share attributes but disagree on reference, and warn. Unit totals are unaffected either way. |
| G6 | Never edit the Area, Length or Count columns by hand. | Nothing in the calculation — but it destroys the only cross-check that detects non-QGIS editing. | **Yes.** In QGIS these always equal the geometry, so a breach heads the report. |
| G7 | For a re-meandered watercourse: set retention **Enhanced** and enhancement type **Enhanced by Realignment**, keep the **old** channel on the Rivers row, and draw the **new** channel in the meanders layer pointing back at it. | The length change is invisible; the enhancement is scored against the wrong length. | **Yes, both directions** — a realignment row with no child, and an orphan child. |
| G8 | Give every row a reference that is unique within its layer. Never leave the word `Null`. | The meanders join fails; the reassembly loses its tiebreak; an assessor cannot trace a row. | **Yes.** Duplicates are not an error for area habitats — they are the split signal — but they are for watercourses. |
| G9 | Choose on-site or off-site explicitly on every row. | Off-site parcels merge into on-site baseline parcels. | **Yes.** Including the template's own invalid `On site` default on two layers. |
| G10 | Use the dropdowns. Do not type into controlled columns, and do not edit the file outside QGIS. | Arbitrary strings enter columns the engine looks up by exact match. | **Yes, per column.** The template's only file-level constraint is its primary key — there are no database-level checks at all. |
| G11 | When a parcel is **Retained**, set the proposed habitat type to the same habitat as the baseline. | A retained parcel silently becomes a different habitat. | **Yes.** Area habitats are the only layer where retained can change habitat type — the template pins only the broad type there. |
| G12 | Leave distinctiveness to the dropdown; never override it. | Distinctiveness stops matching the habitat — a direct multiplier on units. | **Yes, by recomputation.** |
| G13 | For a newly planted tree set category **Newly Planted**; for an existing tree, **Existing**. | A new tree is counted as a baseline tree, inflating the baseline. | **Yes**, but indirectly — we key on the baseline tree size band, because the template defaults the category inconsistently across its six tree layers. |
| G14 | Every point is one tree. If several trees share a location, draw one point per tree. | Trees undercounted on both sides. | **Partially.** A count other than 1 is reported, but QGIS resets it on the next edit, so it cannot be relied on. |

---

## 9. Separately: two pre-existing defects in the tree path

Found while mapping, **present in the shipped two-upload journey**, and
deliberately **not fixed here** because fixing them would move existing results
and needs its own sign-off:

- A tree's top-level area is overwritten with its *proposed* notional area, so an
  enhanced tree whose baseline and proposed size bands differ is scored with the
  proposed band on **both** sides of the calculation.
- Tree advance and delay years never reach the engine at all — the Urban Trees
  layer spells both columns differently from every other layer.

Both make tree net gain optimistic. The new derivation does not repeat either,
and rows affected by the first are named in the reconciliation report.
