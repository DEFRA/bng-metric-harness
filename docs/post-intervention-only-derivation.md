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
| **Individual trees** | **Yes, but the weakest completeness case** | Arithmetically the cleanest case. A tree's baseline area is a four-band reference lookup with no geometry, no adjacency and no merging — and it is *already computed correctly on every post-intervention upload today and thrown away*. Same completeness gap as the linear layers, and a felled tree left as a `Lost` row counts toward the baseline exactly as it should. **The gap is worse here than the arithmetic suggests.** User Guide 2.4.1 tells users that tree points are *“for illustrative purposes only”* and *“cannot be imported into the GIS import tool or exported to the main metric or SSM”*. In the legacy workflow the layer therefore feeds nothing, no error check has ever touched it, and users have had no reason to complete it carefully. G13 and G14 rest on much weaker ground than their hedgerow and watercourse equivalents, which at least reach the CSV export. |
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
  Agreement between real references raises confidence and disagreement is
  reported, but neither decides the group. Note that agreement can only actually
  arrive once the uniqueness constraint is dropped: today a shared ref fails the
  upload before the reassembly sees it.
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

### How references are handled

**A reference is a label, never an identity.** Parcels are reassembled from
geometry and baseline attributes, and only then is a reference read. The
calculation does not move if every ref in the file is wrong, absent, or
identical.

That has to be the design, because refs cannot be relied on. The template's own
default is the literal string `Null` rather than an empty cell, published
guidance endorses leaving it that way (§8, G8), and no convention has ever been
specified for what happens to a ref when a parcel is subdivided.

**Sentinels.** `''`, `Null`, `N/A` and `(no selection)` say nothing, compared
case-insensitively after trimming, and are dropped before any label is chosen.

#### Three jobs, only one of which a ref should do

| Job | Keyed on today | Should be keyed on |
| --- | --- | --- |
| **Grouping** — which rows were one baseline parcel | geometry + baseline attributes | unchanged, this is right |
| **Identity** — which stored feature this row *is*, across a re-upload | the ref | geometry, with the ref as a hint |
| **Labelling** — what an assessor calls the parcel | the ref | unchanged, this is right |

Only the middle row is wrong, and it is the reason a uniqueness constraint was
ever needed. `carry-forward-feature-ids` keeps a stored `featureId` when a ref
matches on both sides, so that a corrected re-upload reads as an update rather
than a delete-and-reinsert. Ref was chosen as the natural key because a check
already enforced its uniqueness. The check is the hangover, not the requirement.

#### Uniqueness is not a real constraint

`checkDuplicateHabitatRefs` rejects any repeated area-habitat `Parcel Ref` and
sets `valid: false`. It is not variant-aware, so it applies to a
post-intervention upload too, and it ignores `null` and `''` but **not** the
literal `Null`. Exercised directly:

```
REJECTED  ['Null','Null','Null']    what the template writes by default
REJECTED  ['PR-1','PR-1','PR-2']
REJECTED  ['H2','H2','H2']          the parts of one divided parcel
accepted  ['H2-1','H2-2','H2-3']
accepted  ['','','']
```

So a file left exactly as the template writes it fails as soon as it holds two
area habitats, and the one division convention that names the parent honestly
fails too. Neither outcome is defensible, and neither is required by anything
downstream of the derivation: **nothing in the reassembly, the units, the area
reconciliation or the trading rules reads a ref at all.**

The constraint is treated here as removable, and the rest of this section
describes the behaviour that follows.

#### What each ref state should do

| In the file | Today | Proposed |
| --- | --- | --- |
| Distinct real refs, one row each | Accepted, each parcel keeps its ref | Unchanged |
| All `Null`, untouched | **Rejected** | Accepted. No label; identity from geometry; counted in the report |
| Parts of a split sharing the parent ref (`H2`, `H2`) | **Rejected** | Accepted, and treated as **evidence**: rows that agree on attributes, adjoin, *and* share a ref are a stronger merge than geometry alone |
| Suffixed parts (`H2-1` … `H2-10`) | Accepted, stem inferred | Unchanged, and the strongest case: the parent name is recoverable |
| Two unrelated parcels both called `PR-1` | **Rejected** | Accepted. They do not adjoin and do not share attributes, so they never merge; the collision is reported and changes nothing |
| Partially filled: `H2` on one part, `Null` on another | Accepted | Unchanged. The sentinel is dropped, the real ref labels the parcel |
| Unrelated names on adjoining parts | Accepted, `derived:…` label | Unchanged, and the disagreement is reported |
| Repeated refs on hedgerows, watercourses, trees | Accepted, never checked | Accepted, but see the two joins below |

The middle row is the prize. Today a shared ref is fatal; under this design it
becomes the one piece of corroborating evidence the file offers for a merge the
service would otherwise have to justify from geometry alone.

#### Identity across a re-upload, without unique refs

Ref stops being the carry-forward key and becomes the first of three tiers:

1. **Ref**, when it is non-sentinel and unambiguous on both sides. Cheap, exact,
   and correct for the well-kept files that have it.
2. **Geometry**, otherwise: the canonical checksum this template already
   defines, byte-identical across the backend, the QGIS actions and
   `gpkg_common.py`. An unedited feature re-uploads to the same fingerprint
   whatever its ref says.
3. **A fresh id**, when neither resolves. Exactly today's fallback.

Tier 2 is what makes the constraint droppable: a file of nothing but `Null`
refs still carries identity forward, because the shapes are the identity.
It fails only where a feature was both re-drawn and unlabelled, which is the
case no scheme could resolve.

#### What actually blocks removing the check

Less than it first appeared. Removing it is safe for the derivation, which reads
no refs, and one of the two joins that looked like a blocker turns out not to be
reachable at all.

**`buildBaselineLinearLengthByRef` is a two-upload construct and is already
inert here.** It is built in `save-upload-for-project.js` as
`buildBaselineLinearLengthByRef(baseline?.hedgerows ?? [], baseline?.watercourses ?? [])`,
so a project with no uploaded baseline hands it two empty arrays, the map comes
out empty, and every Enhanced linear row falls straight through to the tiers in
§4. It cannot mis-key on a duplicate ref because it never has a row to key. It
still wants a collision guard for the two-upload journey and for corroboration,
where `Map.set` means the last row of a repeated ref silently wins, but that is
a defect on a path this document does not describe rather than a precondition
for anything here.

**The meanders join is the real one, and no column on the baseline row can
replace it.** The Rivers layer carries 29 columns and exactly one length,
`Length`, which is a `$length` default expression over the row's own geometry.
Per 2.5.32 that geometry is the OLD channel, so `Length` is the baseline length.
The realigned length exists nowhere on that row. It exists only on the meanders
layer, whose entire schema is `Baseline Parcel Ref` and `Length`.

Guidance 2.5.37 is sometimes read as pointing at a column on the baseline row:

> …this will need to be manually filled out in the *Length Enhanced* column of
> the chosen metric, using the value in the attributes table in the *enhanced by
> realignment* column.

The template does not support that reading. No Rivers column is named or aliased
anything of the kind, and the three `Realigned Proposed …` layers are views of
the meanders table. The instruction is to read the Length from the attribute
table of the Enhancement by Realignment layer, which is the meanders layer's own
`Length`. Calling that layer illustrative means only that it does not export to
Excel automatically; it is still the sole record of the new alignment.

The derivation does not need that column, because it measures the geometry it
already reads. What it needs is the **association** between a realigned channel
and the Rivers row it replaces, and in the legacy format that association is
expressed only as a ref.

So the meanders join should follow the same tiering as identity:

1. **`Baseline Parcel Ref`**, when it resolves to exactly one
   Enhanced-by-Realignment Rivers row.
2. **Geometry**, when it does not: a realigned channel is a re-drawing of a
   specific old channel and sits alongside it, so proximity and overlap identify
   the parent where a ref cannot. Recorded as inferred, exactly as a merged
   parcel's name is.
3. **Neither**, which is today's `meanders-child-orphan` finding, unchanged.

That removes the last thing the uniqueness constraint was protecting. Two Rivers
rows sharing a ref stop being a rejection and become a case tier 2 resolves.

Conversion to the legacy format keeps de-duplicating regardless: legacy really
does reject repeated habitat refs, which is an external constraint on that route
and not evidence for one here.

#### Choosing the label for a reassembled parcel

After the group is formed, `mergedRef` looks at the distinct non-sentinel refs
across its members:

| Distinct real refs in the group | Label the parcel carries | Marked inferred? |
| --- | --- | --- |
| Exactly one | That ref | No, it is the parcel's own |
| Several, all numbered pieces of one stem (`H2-1` … `H2-10`) | The stem, `H2` | **Yes** |
| Several, unrelated (`North Field`, `Long Meadow`) | `derived:Long Meadow+North Field` | No, it claims nothing |
| None (all sentinel) | `null` | No |

The stem rule accepts `-`, `_`, `.`, `/` or a space before a purely numeric
tail, and requires every member to agree. `H2-1` beside `H3-1` gives no stem,
and neither does `H2-north`, because that is a name rather than a piece number.
Refs are sorted before the composite is built, so the label is a function of the
group rather than of read order.

Under the proposed behaviour one row is added to that table: **several members
all carrying the same ref gives that ref, not inferred**, because the surveyor
named the parcel and every part agrees.

Whatever is chosen, `derivation.sourceRefs` lists every contributing ref and
`derivation.refInferred` records whether the service picked the name. The
parcel's own `featureId` is the lowest member id, so re-uploading the same file
reassembles to the same identity.

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

### A tension inside the guidance itself

G3 and G4 both increase row count: a partial loss becomes two rows, a moved line
becomes two. The legacy route has hard ceilings — **248 rows** per metric tab
(User Guide 3.1.5) and **20** for the SSM (1.7.1), beyond which rows are dropped
on export. NE's remedy is either splitting the site geographically or the import
tool's consolidate button, and 3.2.3 warns that consolidating *“may be merged
with other polygons of the same attributes within the same dataset”*, which is
the parcel-level audit trail. On a hedgerow-rich site, "split every partial loss
into its own row" and "stay under 248" pull against each other, and the way out
costs the audit trail rather than the totals.

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
8. Blank and literal-`Null` references, refs that disagree across a merge
   group, and refs repeated across parcels that did not merge. The last of
   those cannot arise until the uniqueness constraint is dropped, because it
   fails the upload first
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

Authoritative guidance does exist, and an earlier draft of this section said it
did not. The two-page PDF shipped inside the template folder is only the cover
of *Natural England Joint Publication JP039*; the rules are in its 42-page
companion, **“The Statutory Biodiversity Metric and Small Sites Metric — QGIS
template and GIS import tool: User Guide” (November 2023)**, kept alongside the
template at `bng-template-convert/templates/legacy-ne/`.

So these rules divide into three kinds, and the difference matters when they are
put to a user:

- **Restating NE.** G3 and G7 are NE's own instructions, cited below. They can be
  presented as guidance rather than argued for.
- **Forced by the template's own data.** G4 and G11 follow from the dropdown
  value relations, which permit nothing else.
- **Ours to own.** The rest are inferred, must not be presented as an NE
  requirement, and need ecologist review before publication. **G5 and G8 go
  further than that: they ask for something NE's guidance does not, and in G5's
  case the opposite of what it suggests.**

Not all of it carries equal weight. **G3 and G4 are load-bearing**: they are the
only thing standing between the service and an overstated gain on the linear and
point layers, because those layers have no equivalent of the red-line rule that
makes area completeness enforceable. Everything else is either checkable, or
affects the parcel list rather than the numbers.

**One dependency on policy, and the template has settled half of it.** G4 tells
a user that a re-aligned linear feature is recorded as the old line `Lost` and
the new line `Created`. Whether that is the right *scoring* remains a policy
question — creation and enhancement do not score the same way, so treating a
moved hedgerow as a creation changes the answer even though the plants may be
the same.

What is no longer open is whether the legacy template can express anything else.
It cannot, for hedgerows. `Retention Category` is restricted on `Baseline Hedge
Type`, and `Created` is reachable from exactly one value, `To be created`; a row
carrying a real hedge type is offered only `Lost`, `Retained` or `Enhanced`. So
a moved hedge is two rows whatever policy prefers. **If policy decides a moved
hedgerow is an enhancement, G4 does not simply need rewriting: the legacy format
has nowhere to record it**, and the enhancement route would need a way to carry
the original length that the template does not have.

Watercourses are unaffected either way, and go the other way: 2.5.31–2.5.37
score a realignment as `Enhanced` and keep both alignments as drawn geometry. The
same physical act is therefore a creation for a hedge and an enhancement for a
watercourse, purely because of what the template can hold. That asymmetry is the
sharpest form in which to put the question to policy.

| # | Guidance | If ignored | Can we detect it? |
| --- | --- | --- | --- |
| G1 | Draw an area-habitat polygon over **every** part of the red line — no gaps, no overlaps. | Baseline area understated; the >10% test is wrong. | **Yes, fully.** The file is already *rejected*. |
| G2 | Fill all baseline columns on **every** area row, including parcels being built on. | The row contributes no baseline units, silently inflating net gain. | **Yes.** Reported with the count *and the area share*; above a threshold the verdict is withheld rather than published wrong. |
| **G3** | **Every metre of hedgerow and watercourse, and every tree, that exists today must appear as drawn geometry on some row.** Where part of a feature is removed, **split it into sections** — one row per section, each carrying the original baseline attributes, retention **Lost** for what goes and **Retained**/**Enhanced** for what stays. Never shorten a line to show that part of it is going. **This is NE's own instruction, not ours.** User Guide 6.1.17: *“users should not manually delete sections of linear features that are to be lost — rather select the appropriate options within the attribute table to reflect this outcome.”* And 6.1.16: *“existing features subdivided where there are differences in proposed outcomes (for example partial losses).”* | The most serious failure: the removed length was never in the derived baseline, so the loss is never subtracted and the gain is overstated with no ceiling. | **No.** A file missing a `Lost` row is byte-identical to one describing a site that never had that feature. Mitigated only by an explicit user declaration, and by the report stating row counts, `Lost` counts and total derived length on every project. |
| **G4** | **Never re-draw a Retained or Enhanced line.** If the alignment changes, record the old line as **Lost** and the new line as **Created** — or, for a watercourse, use the meanders layer, which keeps both alignments (G7). **The template permits nothing else for hedgerows.** `Retention Category` is a restricted list keyed on `Baseline Hedge Type` (Appendix A, Table 7-2), and `Hedgerow Retention Options.csv` offers `Created` on exactly one baseline value, `To be created`. A row carrying a real hedge type can only be `Lost`, `Retained` or `Enhanced`, so a moved hedge cannot be one row. Watercourses get the opposite answer for the same act, because 2.5.31–2.5.37 give them a realignment workflow scored as `Enhanced`. That asymmetry is a property of the template, not an ecological principle, and is the form the open policy question should take. | The row's own length is taken as its baseline length. Lengthening understates the gain; shortening overstates it. | **Partly.** A watercourse marked *Enhanced by Realignment* with no meanders child is reported, and so is an orphan child. For hedgerows there is no equivalent signal — the assumption is recorded on the feature and in the report, with its direction stated as unknown. |
| G5 | Where one parcel is divided, **give each part the parent's name** — either repeated (`H2`, `H2`) or suffixed (`H2-1`, `H2-2`) — and identical baseline attributes. **Twice corrected.** An earlier draft asked for the same ref on every part, which is right in principle but fails the upload today; the next draft asked for suffixes only, which is narrower than necessary. Once uniqueness is dropped both forms work, and a repeated ref is the better one: it says the parts are one parcel rather than leaving the service to infer a stem. Published guidance specifies no convention here at all. | The parts still merge on geometry and attributes, so the totals hold, but the parcel is labelled `derived:…` and the list will not reconcile with the survey by name. | **Partially.** Adjoining rows that share attributes but disagree on reference are reported with the merge. Unit totals are unaffected either way, which is why this stays advisory. |
| G6 | Never edit the Area, Length or Count columns by hand. | Nothing in the calculation — but it destroys the only cross-check that detects non-QGIS editing. | **Yes.** In QGIS these always equal the geometry, so a breach heads the report. |
| G7 | For a re-meandered watercourse: set retention **Enhanced** and enhancement type **Enhanced by Realignment**, keep the **old** channel on the Rivers row, and draw the **new** channel in the meanders layer pointing back at it. | The length change is invisible; the enhancement is scored against the wrong length. **Confirmed by NE.** 2.5.32 has the baseline watercourse keeping its own alignment while the realigned channel is drawn separately, and 2.5.35 has the child carrying a `Baseline Parcel Ref` *“completed to match the parcel ref for the baseline polyline”* — the only parent-pointer field NE ever specified, for one habitat type. **Caveat:** 2.5.37 calls that layer *“for illustration only”* and has the user type the new length into the metric by hand, so a user following NE exactly may have drawn it loosely. Reading it as authoritative geometry is better than NE's own tooling, but the report should say the length came from it. | **Yes, both directions** — a realignment row with no child, and an orphan child. |
| G8 | Give every row a reference that means something, and prefer a real one to the literal `Null`. **Not a uniqueness rule.** An earlier draft demanded refs unique within a layer; that reflected a validator constraint which is itself a hangover, not a requirement of the calculation. Published guidance points the other way: 2.5.19 says `Parcel Ref` *“should be left to automatically fill in as ‘Null’ or filled in with the relevant reference”*, and Appendix A repeats *“Edit with free text or leave as ‘Null’, do not leave blank”*. A file of `Null` refs is a perfectly good file whose parcels the service simply cannot name. | Nothing in the units, the reassembly or the reconciliation. An assessor loses the ability to trace a parcel by name, and a re-upload falls back to matching on geometry rather than on the ref. | **Yes**, counted and reported. Note what is NOT true: today a repeated area-habitat ref *rejects the file*, and no other layer is checked at all. Both are artefacts of the constraint rather than intended behaviour. |
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
