# Deriving the baseline from the post-intervention file alone

**BMD-1001 · spike · status: analysis complete**

Whether the full BNG calculation can be produced from a single post-intervention
upload in the **unaltered** Natural England QGIS template, what that costs, and
what an ecologist would have to do for it to be right.

Companion to the options paper *Reconciling post-intervention with baseline*.
This document covers Option B only, and answers that paper's open questions
wherever the template or the service settles them.

---

## How to read this

Sections 1 to 3 explain the idea and show that it works, including how divided
parcels are put back together. Section 4 sets out in full how parcel references
should be handled, from a file that names everything to one that names nothing.
Section 5 covers hedgerows and watercourses, where the original length has to
come from somewhere. Sections 6 and 7 set out what is gained and lost against the
two-upload journey, and what the service can and cannot check. Section 8
describes what a user should see. Section 9 is the draft guidance for ecologists,
which is the part most likely to need review.

The paper describes the outcome the service should reach, given what the NE
template can and cannot hold. It is not a record of any particular build.

No engineering knowledge is assumed. Where a fact was established by reading the
service's own code or by running it against the shipped example files, that is
said plainly rather than shown.

---

## 1. The idea in one paragraph

Every habitat row in the NE template holds **baseline and proposed values side by
side, over one shape**. A post-intervention row therefore already states what was
there before as well as what will be there after. What the file loses is the
baseline **parcel list**: where one baseline parcel was divided by the scheme,
the original shape no longer exists anywhere in the file. The derivation
reconstructs that list by grouping rows whose baseline values are identical and
whose shapes adjoin, then rebuilds every baseline figure by measuring the
post-intervention geometry.

---

## 2. Feasibility verdict

| Habitat type | Verdict | Why |
| --- | --- | --- |
| **Area habitats** | **Yes, with guidance** | Every figure the calculation needs is already on the row except size, and size is recoverable exactly. Area habitats must account for the whole red line, and the service already rejects any file that fails that check to within half a square metre, so summing the measured parcels rebuilds the baseline area in full. What remains is whether the baseline **columns** were filled in. A row can cover its share of the site and still leave them blank. That is fully detectable and can be quantified. |
| **Hedgerows** | **Yes, with guidance** | Units need only length, type and condition, all of which are on the row. The length is **exact** wherever the file accounts for every metre that existed: a partly removed hedge split into a Retained row and a Lost row rebuilds to its full surveyed length (§5). The gap is **completeness**, not arithmetic, and it rests entirely on guidance. Nothing ties the hedgerow layer to the red line, so a hedge removed without a row left behind is invisible, and looks identical to one that never existed. |
| **Watercourses** | **Yes, with guidance** | As hedgerows, plus two specifics. Re-meandering is the one case where the post-intervention length can legitimately exceed the baseline, and it is recoverable only through the template's dedicated meanders layer. And a missing encroachment value quietly defaults to a multiplier of 1, which inflates the baseline. That is detectable and reported. |
| **Individual trees** | **Yes, but the weakest completeness case** | Arithmetically the cleanest case of all. A tree's baseline area is a four-band lookup with no geometry, no adjacency and no merging, so it needs nothing the post-intervention row does not already carry. Same completeness gap as hedgerows and watercourses, and a felled tree left as a Lost row counts toward the baseline exactly as it should. **The gap is worse here than the arithmetic suggests.** User Guide 2.4.1 tells users that tree points are *"for illustrative purposes only"* and *"cannot be imported into the GIS import tool or exported to the main metric or SSM"*. In the legacy workflow the layer therefore feeds nothing, no error check has ever touched it, and users have had no reason to complete it carefully. G13 and G14 rest on much weaker ground than their hedgerow and watercourse equivalents, which at least reach the CSV export. |
| **Vertical area habitats, irreplaceable habitats** | **No** | The NE template has no columns for green walls, green roofs, intertidal hard structures as vertical area, or irreplaceable habitat. If a site has any, they are missing from **both** sides of the calculation. That is a limit of the template, not of the derivation, and it applies equally to the current two-upload journey. |

---

## 3. Putting divided parcels back together

Rows are grouped on five baseline values: broad habitat type, habitat type,
condition, strategic significance and location. Groups are then tested on shape.
Two parcels are treated as parts of one original where they share a boundary
longer than a small fixed floor **and** longer than 2% of the smaller parcel's
perimeter.

Three things are deliberately left out of the grouping test.

- **Retention category is not used.** It describes the intervention, which is
  precisely what differs between the parts of a split. In the shipped example
  file *Post-intervention - complete.gpkg*, the ten parts of one divided parcel
  carry *Lost*, *Retained* and *Enhanced* between them.
- **Parcel reference is not used.** The template fills it with the word `Null` on
  untouched rows, so grouping on it would merge every unfilled row into one.
  Agreement between real references raises confidence, and disagreement is
  reported, but neither decides the group. Section 4 sets out how a name is
  chosen once the group has been formed.
- **Baseline distinctiveness is not used.** It follows exactly from habitat type
  across every row of the reference data, so it adds nothing. It is worked out
  again instead, and any mismatch is reported.

### Proof that the premise holds

Run against the shipped pair *Baseline - complete with area refs.gpkg* and
*Post-intervention - complete.gpkg*, the ten post-intervention parts of parcel
`H2` rebuild the baseline parcel **exactly**:

| Parcel | Baseline file | Post-intervention file, parts summed |
| --- | --- | --- |
| H1 | 675.289 m² | 675.289 m² |
| **H2** | **13 607.588 m²** | **13 607.588 m²** (H2-1 to H2-10) |
| H3 | 567.275 m² | 567.275 m² |
| **Site total** | **14 850.152 m²** | **14 850.152 m²** |

Identical to the thousandth of a square metre, not merely close. Area is
conserved across a division because the same ground is being described either
way.

The same run shows why the `Area` column can never be trusted. Baseline `H2`
records 2 460 against a measured 13 607.588, and `H2-1` records 127 against a
measured 7 850.142. Those are wrong by factors of about 5 and 62. The column is a
QGIS convenience that tracks whatever the geometry was when the row was last
touched, and in these files it is simply stale. The service measures the shape
instead.

### Why the 2% threshold carries little risk

The grouping test already pins habitat type and condition, so every member of a
group has the same distinctiveness and condition scores. Baseline units are size
multiplied by distinctiveness multiplied by condition. Splitting a group into
parts and adding the parts back up therefore gives the same answer as leaving it
whole.

**So the threshold cannot change the habitat unit total, cannot change the net
change percentage, and cannot change the 10% verdict.** It changes only the
parcel list an assessor reads. That is why a permissive threshold is the right
default. A merge made in error costs nothing arithmetically, while a split left
in error degrades the list a person has to reconcile against the survey.

**2% is an opening value, not an evidenced one.** There is nothing in the
repository to set it against. Every real upload records its own merge evidence,
including the shared length, both perimeters, both fractions, and whether the
shared edge was a single straight segment, so the threshold can be set from
evidence later.

One ambiguity cannot be removed. No threshold separates "one parcel split down
the middle" from "two parcels that always abutted". Two 10 by 10 squares sharing
a full edge look identical either way. That is handled by naming, not by shape.

---

## 4. Parcel references

Ecologists name their parcels, and expect the list they get back to carry those
names. The template does not make that easy. It fills the reference column with
the word `Null` rather than leaving it empty, published guidance says leaving it
that way is fine (§9, G8), and no convention has ever been set for what happens
to a reference when a parcel is subdivided. So a file may arrive fully named,
partly named, not named at all, or named with the same word three times over, and
every one of those is a legitimate file.

This section sets out what the service should do with each of them.

### A reference is a name, never an identity

Parcels are put back together from shape and baseline values, as §3 describes,
and only then is a reference read. The calculation does not move if every
reference in the file is wrong, absent, or identical. Nothing in the reassembly,
the unit totals, the area reconciliation or the trading rules depends on a name.

That has to be the design, because names cannot be relied on. It also means the
service is free to give a parcel a good name without any risk of changing an
answer.

**Uniqueness is a promise about what comes out, not a rule about what goes in.**
No file is ever refused for repeating a name. Every published list is free of
repeats, because the service makes it so.

**Words that say nothing.** An empty cell, `Null`, `N/A` and `(no selection)` are
all treated as no answer. They are compared ignoring case and surrounding spaces.
Anything else is a **real** name.

### Three fields, not one

| Field | Holds | Ever invented? |
| --- | --- | --- |
| The surveyor's reference | exactly what was typed, or nothing | **Never.** Kept as written, so the file can always be reconciled to its source |
| The published name | what the service shows, exports and reports | Where the file gives none, or gives one that cannot be used as written |
| The parcel's identity | which parcel this is, across re-uploads | It is the identity, and it is never a name |

Keeping the first two apart is what makes everything below safe. The surveyor's
column is evidence and stays exactly as written. The published name is the
service's own, and where the two differ the report shows both.

**A published name is never used to match anything.** Rejoining parcels, linking
a realigned channel to the reach it replaces, and recognising a parcel on
re-upload all work from the surveyor's own reference and from shape. If an
invented name could match, the service would be matching on its own invention and
reporting the result as though the file had said it.

### The resolver, in six steps

Applied to one layer of one map at a time. Habitats, hedgerows, watercourses and
trees have separate reference columns and are resolved separately.

1. **Rejoin the parcels.** Naming comes after reassembly, because until the parts
   of a division are back together there is no parcel to name.
2. **Reserve every real name in the file.** Nothing invented later may take one,
   so an invented name can never collide with a real one somewhere else on the
   site.
3. **Ask what the parts say, ignoring the blanks.** This decides the baseline
   parcel's name, and the next section sets out every case.
4. **Invent a name for any parcel the file did not name**, from its habitat.
5. **Number the parts, and separate any parcels that still share a name.**
6. **Keep what was given.** A name, once published, stays with its parcel.

Step 3 is where nearly all the work happens, and it reduces to one sentence worth
giving to users directly:

> **Naming one part of a division names the whole parcel.**

Blanks inside a group are silence, not disagreement, and silence is ignored. An
ecologist only has to name one part of a division for the parcel to come back
with the right name, which is a far lighter ask than naming every part
consistently.

### Worked outcomes

Every case, with what the post-intervention file says on the left and what the
service publishes on the right.

| # | Post-intervention file | Baseline parcel | Post-intervention rows |
| --- | --- | --- | --- |
| 1 | One row, `H1` | `H1` | `H1` |
| 2 | Two rows, `H1-a` and `H1-b`, rejoined | **`H1`** | `H1-a`, `H1-b` |
| 3 | Ten rows, `H2-1` to `H2-10`, rejoined | `H2` | `H2-1` to `H2-10` |
| 4 | Three rows, all `H3`, rejoined | **`H3`** | **`H3-1`, `H3-2`, `H3-3`** |
| 5 | Three rows, `H4`, blank, blank, rejoined | `H4` | `H4-1`, `H4-2`, `H4-3` |
| 6 | Three rows, `H5`, `H5-1`, blank, rejoined | `H5` | `H5-1`, `H5-2`, `H5-3` |
| 7 | Two rows, `North Field` and `Long Meadow`, rejoined | `GRA001` | `GRA001-1`, `GRA001-2` |
| 8 | Two rows, both `PR-1`, **not** rejoined | `PR-1` and `PR-1 (2)` | `PR-1`, `PR-1 (2)` |
| 9 | Two rows, both blank, rejoined | `GRA001` | `GRA001-1`, `GRA001-2` |
| 10 | One row, blank, retention **Created** | none | `WOO001` |
| 11 | One hedgerow row, `HG1` | `HG1` | `HG1` |

Row 2 is the case the whole scheme has to get right. **A division named `H1-a`
and `H1-b` must rebuild to a baseline parcel called `H1`.** The parts announce
their parent in their own names, and the baseline is where that parent belongs.
The parts keep the names the ecologist gave them, because they are correct and
already distinct.

Row 4 is the same idea reached from the other direction. Three parts all called
`H3` are three statements that this was one parcel called `H3`, so the baseline
takes that name outright. The parts then need telling apart, so they are numbered.

Rows 5 and 6 show why blanks and mixtures do not need a convention. In row 5 one
named part is enough. In row 6 the parts disagree only in form, since `H5` and
`H5-1` both point at `H5`, so `H5` wins. **A part never keeps the parcel's bare
name**, or the published list would hold two different things called `H5`.

Row 7 is a genuine disagreement, and it is not resolved by choosing a favourite.
Two unrelated names mean the file offers no name for the rejoined parcel, so one
is made, and the report records that the parts were called `North Field` and
`Long Meadow` so a person can settle it.

Row 8 is two different parcels that happen to share a name. They do not adjoin
and do not share baseline values, so they were never going to be rejoined. Both
keep the ecologist's name and the second is marked.

Row 10 has no baseline parcel at all, because nothing was there before. Its name
comes from the habitat being created rather than from one that existed.

Row 11 stands for all three linear and point layers. Hedgerows, watercourses and
trees are one row each and are never rejoined, so their names pass straight
through, with steps 4 and 5 applying if a name is missing or repeated.

**When the parts keep their own names, and when they are renumbered.** Rows 2 and
3 keep what the ecologist typed; rows 4, 5 and 6 do not. One rule covers both:

> The parts keep the names they were given when **every** part has a distinct
> one. Otherwise every part is numbered, including the parts that were already
> named.

Renumbering the whole set rather than filling the gaps is deliberate. Numbering
only the unnamed parts of row 5 would give `H4`, `H4-1`, `H4-2`, which leaves one
part carrying the parcel's own name and reads as though the parcel had been
divided into itself plus two others. A set of names is easier to trust when it
was decided by one rule than when it is half the ecologist's and half the
service's.

### What a suffix means

**`-1`, `-2`, `-3`: a part of the parcel named by the stem.** Nothing else uses
this form, so a reader can always tell a part from a parcel at a glance.

**` (2)`, ` (3)`: another parcel that happens to carry the same name.** The
first keeps the bare name. The bracket is deliberately unlike a suffix, because
these are not parts of anything.

The service reads more generously than it writes. A part suffix supplied by an
ecologist is accepted in any of the forms people actually use, letters or
numbers, separated by a hyphen, underscore, dot, slash or space, so `H1-a`,
`H1_2`, `H1.3` and `H1 4` all announce `H1` as the parent. When the service has
to supply a suffix itself it always uses the one canonical form.

### Names made from the habitat

A parcel the file does not name takes a three-letter code for its broad habitat
and a number.

| Broad habitat or layer | Code | Example |
| --- | --- | --- |
| Grassland | GRA | `GRA001` |
| Woodland and forest | WOO | `WOO001` |
| Heathland and shrub | HEA | `HEA001` |
| Cropland | CRO | `CRO001` |
| Wetland | WET | `WET001` |
| Urban | URB | `URB001` |
| Sparsely vegetated land | SPA | `SPA001` |
| Lakes | LAK | `LAK001` |
| Hedgerows | HED | `HED001` |
| Watercourses | WAT | `WAT001` |
| Individual trees | TRE | `TRE001` |

The habitat is the **baseline** habitat, because the name belongs to the parcel
as it was. A created row has no baseline habitat, so it takes the code of the
habitat being created.

Three details matter more than they look.

**The number is fixed width.** `GRA001` rather than `GRA1`, so the names sort
correctly in a spreadsheet, in an export and in the metric, and not only on
screens that know to pad them.

**There is no separator before the number.** That leaves the hyphen free to mean
one thing and one thing only, so the parts of `GRA001` are `GRA001-1` and
`GRA001-2` with no ambiguity about where the parcel name ends.

**The numbers are given out in shape order**, meaning sorted on a fingerprint of
each parcel's outline. Two uploads of the same file, or of the same file with its
rows in a different order, produce the same names.

### Continuity when the file is uploaded again

Re-uploading a corrected post-intervention file is normal, and an assessor who
has already read the parcel list must not find it renamed underneath them.

**A parcel is recognised by the ecologist's own reference where there is one, and
by its shape where there is not.** Neither depends on a name the service
invented. An unedited parcel therefore comes back as the same parcel however the
file was saved.

**A recognised parcel keeps the name it was published under.** That includes
invented names, which are stored with the parcel rather than worked out afresh.
Editing a habitat type never renames a parcel, and adding a fortieth parcel never
renumbers the first thirty-nine.

**A name the ecologist adds later wins, and the change is reported.** If a parcel
published as `GRA001` arrives with `Long Meadow` typed into its reference, it
becomes `Long Meadow`. The report says which parcel changed and what it was
called before, so the two lists can be lined up.

**A letter or number given to break a clash stays put.** Where `PR-1` and
`PR-1 (2)` already exist, a third parcel called `PR-1` becomes `PR-1 (3)`. The
first two are untouched.

### What the resolver guarantees

1. Every published parcel has a name.
2. No two parcels in one layer of one map share a published name.
3. The ecologist's own reference column is never overwritten.
4. A parcel keeps its published name across re-uploads of the same site.
5. A name says where a parcel sits: a hyphen and a number means part of the
   parcel named before it.
6. Every invented name, every added suffix and every name that changed is stated
   in the report, so nothing about the list is silent.

---

## 5. Hedgerows and watercourses: where the original length comes from

**The template cannot carry it.** The `Length` and `Area` columns are QGIS
expressions that recalculate every time a feature is edited. They track the
current shape and can never hold an earlier value. The example files prove the
consequence: in the split example file, one part of a divided parcel carries the
*whole parent parcel's* area on a row that is one tenth of it. The service
measures the geometry and never reads these columns.

So for an enhanced hedgerow or watercourse, the baseline length is taken from the
row's own post-intervention shape, with the meanders layer as the way out where a
watercourse was realigned.

### Which way that errs, and it errs both ways

The calculation caps the baseline length at the post-intervention length
whenever the line did not grow. So:

- for any feature whose alignment did not change, the derived figure is
  **numerically identical** to the two-upload result, verified on every enhanced
  line in the example files;
- where the line was **lengthened**, the derived baseline is understated, so the
  reported gain is understated. Nobody can inflate the 10% test by extending a
  line;
- where the line was **shortened, or partly removed, the error runs the other
  way**. The lost length was never in the derived baseline to be lost, so the
  loss simply disappears.

That last case is the serious one and it is easy to miss. Measured on the shipped
pair *Post-intervention - retained hedgerow.gpkg*: the two-upload journey reports
a hedgerow net change of **−1.368 units (−56.44%)**, and the derived baseline
reports **0 (0%)**. A real loss of more than half the hedgerow units vanishes
entirely.

So no single direction can be claimed for an assumed length, and the service does
not claim one. The report records the effect as unknown and states both
directions out loud. This is the same limitation as §6's unbounded case, seen
from the arithmetic rather than from the parcel list: **what the file does not
contain, the derivation cannot miss.**

### The linear baseline is recoverable, by discipline rather than by a check

The error above is not inherent to deriving from one file. It is the cost of a
**breach** of guidance, and the template already contains the mechanism that
prevents it.

A hedge is never shortened to show that part of it is going. It is **split**, and
the removed section gets its own row with retention **Lost**, drawn over the
ground it occupied. `Lost` is already in the template's retention list, so this
asks for discipline rather than a new convention, and it needs no matching
between rows.

Measured end to end from a GeoPackage, on one 200 m hedge of which 120 m is kept:

| How the file records it | Derived baseline |
| --- | --- |
| 120 m `Retained` **plus 80 m `Lost`** | **200 m**, the whole surveyed hedge |
| 120 m `Retained`, removed section deleted | 120 m, and the loss is invisible |

The first row is exact. Nothing is inferred, no length is assumed, and the
fallback to the row's own length is never reached, because every retained and
enhanced line keeps its own alignment.

That is why the derivation reads the layers **before** Lost rows are filtered
out. A Lost row is not noise to be discarded. It is the only evidence that a
removed feature ever existed.

**One thing this cannot do.** The two files above differ by one row, and nothing
inside the second distinguishes it from a site whose hedge was only ever 120 m
long. Both are structurally valid and both pass every check. So the guidance is
load-bearing in a way no engineering can replace, which is the subject of §7.

### Why a separate baseline layer is not the answer

A natural proposal is to ask users to record baseline and post-intervention lines
as separate rows, paired by reference, the way the map already *looks*. The
project ships *Hedgerow Baseline EDIT ME* and *Hedgerows Proposed EDIT ME* as
distinct layers a user can show and hide.

Those layers are not what they appear to be. The project contains no layer
filters at all, so all three hedgerow layers are unfiltered views of the *same
rows in the same table*, differing only in styling and in which form fields are
shown. A hedgerow drawn once appears in all of them. They are three lenses on one
row, not three rows.

Asking for genuinely separate rows then runs into two blockers.

- **The template cannot say "this row records the baseline only."** It would have
  to be inferred from baseline filled and proposed blank, but the hedgerow
  retention column defaults to the word `Null`, so a deliberate baseline-only row
  is indistinguishable from one the surveyor has not finished.
- **It reintroduces matching by reference.** Pairing rows by parcel reference is
  exactly the cross-row dependency §3.3 of the options paper argues against, and
  a file that ignores the convention looks identical to one that follows it.

The Lost approach above achieves the same result within the meanings the template
already has, and needs neither.

---

## 6. Trade-offs against the two-upload journey

### Exactly as good

- **Individual trees.** Baseline area is a band lookup already worked out today.
- **Area habitat unit totals.** Units scale with area, area is conserved across a
  split, and the red-line check forces any accepted file to cover the site.
  However parcels group, the total is identical.
- **Enhanced lines that were not lengthened**, and all retained and created
  lines.

### Worse, but bounded and in a known direction

- **Enhanced lines that were lengthened.** Understates the gain, never overstates
  it. The meanders layer removes even this where it is used.

### Worse, and unbounded

- **Omitted hedgerows, watercourses and trees.** Nothing ties those layers to the
  red line. A feature removed *without a row left behind* is invisible: the
  baseline is understated, the net gain overstated, and **there is no ceiling on
  the error**. This is the strongest argument for keeping the two-upload journey
  available rather than retiring it.
- **Rows with blank baseline values.** Shape coverage is guaranteed by the accept
  check; value coverage is not. A row can cover its share of the site and say
  nothing about what was there.
- **The parcel list is an assumption, not a record.** Totals survive that. An
  assessor's reconciliation against the original survey does not.

### A tension inside the guidance itself

G3 and G4 both increase the number of rows: a partial loss becomes two rows, and
a moved line becomes two. The legacy route has hard ceilings of **248 rows** per
metric tab (User Guide 3.1.5) and **20** for the small sites metric (1.7.1),
beyond which rows are dropped on export. NE's remedy is either splitting the site
geographically or using the import tool's consolidate button, and 3.2.3 warns
that consolidating *"may be merged with other polygons of the same attributes
within the same dataset"*, which is the parcel-level audit trail. On a
hedgerow-rich site, "split every partial loss into its own row" and "stay under
248" pull against each other, and the way out costs the audit trail rather than
the totals.

---

## 7. What the service can check, and what it must take on trust

The verdict is withheld rather than published wherever the report has raised a
warning that pushes the gain **upwards**. Anything the service knows might
flatter the applicant stops a Met or Not-met answer being given, while anything
that can only understate the gain does not.

**Checkable, and each becomes a finding in the report carrying the direction it
pushes the net gain:**

1. Blank baseline values, with the count *and* the share of area or length
2. Conditions that cannot be assessed
3. Values outside the template's own dropdowns, per layer
4. Distinctiveness disagreeing with the habitat type it should follow from
5. `Area` or `Length` disagreeing with the measured shape, which is positive
   proof the file was edited outside QGIS
6. Retained area rows whose proposed habitat type differs from the baseline
7. Every merge, with the names involved and both shared-boundary fractions
8. Blank and `Null` references, names that disagree across a merged parcel, and
   names repeated across parcels that did not merge
9. Meanders links that fail, in either direction
10. Rows producing no units at all, which would otherwise vanish from the totals
11. Red-line coverage and parcel overlaps, the **only** structural completeness
    guarantee, and it covers area habitats alone

**Must be taken on trust:**

1. That every hedgerow, watercourse and tree present before development is in the
   file, including removed ones
2. That each line's baseline length equals its post-intervention length, unless
   the meanders layer was used
3. That two adjoining parcels with identical baseline values were one parcel, not
   two
4. That vertical-area and irreplaceable habitats are genuinely absent
5. That the dropdown values describe the site accurately

Item 1 cannot be turned into a check by any amount of engineering. "There were no
hedges" and "the surveyor did not draw them" are identical files. The only honest
instrument is an **explicit declaration in the journey**, recorded as something
the user attests to rather than dressed up as a service check.

---

## 8. What the user should see

A derived baseline is a reconstruction, and the journey has to say so without
burying the figures it produces.

**The baseline tile says the figures were derived, in three places.** The heading
reads *On-site baseline (derived)*, a tag beside it repeats the word, and a link
offers the explanation of how the figures were reached. One marker is missed; one
marker plus a tag plus a route to the reasoning is not.

**A post-intervention upload finishes on the project summary**, the same place a
baseline upload finishes. That is the page carrying the derived tile, the net
change and the verdict, so it is the page that has something to say. The habitat
list keeps its job as the editing surface, and every habitat detail page backs
out to it.

**Every page reads the same baseline the headline does.** A summary that shows
0.00 baseline units beside a positive net change worked out from a baseline it is
not displaying is worse than showing nothing: the two figures on screen
contradict each other and there is no way for a reader to tell which is wrong.

**Where coverage is too thin to stand behind, the figures are still shown and the
verdict is not.** The numbers are the best the file supports and withholding them
helps nobody. The Met or Not met answer is replaced by **Cannot be determined**,
because publishing a verdict from a baseline the service knows it could not fully
account for is the one thing it must not do.

**The task list still offers the baseline upload.** No baseline file was
uploaded, so a row saying so is accurate, and it is the way in for a user who
does have a baseline export and wants the two compared. Comparing a derived
baseline against an uploaded one is the only independent evidence available that
nothing was left out of the post-intervention file, and it needs no name matching
of any kind. A project with a derived baseline opens on its summary rather than
being routed through that row.

---

## 9. Draft user guidance

Authoritative guidance does exist, and is easy to miss. The two-page PDF shipped
inside the template folder is only the cover of
*Natural England Joint Publication JP039*. The rules are in its 42-page
companion, **"The Statutory Biodiversity Metric and Small Sites Metric: QGIS
template and GIS import tool: User Guide" (November 2023)**, kept alongside the
template in this repository.

The rules below divide into three kinds, and the difference matters when they are
put to a user.

- **Restating NE.** G3 and G7 are NE's own instructions, cited below. They can be
  presented as guidance rather than argued for.
- **Forced by the template.** G4 and G11 follow from the dropdowns, which permit
  nothing else.
- **Ours to own.** The rest are inferred, must not be presented as an NE
  requirement, and need ecologist review before publication. **G5 and G8 go
  further: they ask for something NE's guidance does not, and in G5's case the
  opposite of what it suggests.**

Not all of it carries equal weight. **G3 and G4 are load-bearing.** They are the
only thing standing between the service and an overstated gain on the hedgerow,
watercourse and tree layers, because those layers have no equivalent of the
red-line rule that makes area completeness enforceable. Everything else is either
checkable, or affects the parcel list rather than the numbers.

**One dependency on policy, and the template has settled half of it.** G4 tells a
user that a re-aligned line is recorded as the old line Lost and the new line
Created. Whether that is the right *scoring* remains a policy question, because
creation and enhancement do not score the same way, so treating a moved hedgerow
as a creation changes the answer even though the plants may be the same.

What is no longer open is whether the legacy template can express anything else.
It cannot, for hedgerows. Retention category is restricted on baseline hedge
type, and Created is reachable from exactly one value, *To be created*. A row
carrying a real hedge type is offered only Lost, Retained or Enhanced. So a moved
hedge is two rows whatever policy prefers. **If policy decides a moved hedgerow
is an enhancement, G4 does not simply need rewriting: the legacy format has
nowhere to record it**, and the enhancement route would need a way to carry the
original length that the template does not have.

Watercourses are unaffected, and go the other way. Guidance 2.5.31 to 2.5.37
score a realignment as Enhanced and keep both alignments as drawn shapes. The
same physical act is therefore a creation for a hedge and an enhancement for a
watercourse, purely because of what the template can hold. That asymmetry is the
sharpest form in which to put the question to policy.

| # | Guidance | If ignored | Can the service detect it? |
| --- | --- | --- | --- |
| G1 | Draw an area-habitat polygon over **every** part of the red line. No gaps, no overlaps. | Baseline area understated, so the 10% test is wrong. | **Yes, fully.** The file is already rejected. |
| G2 | Fill all baseline columns on **every** area row, including parcels being built on. | The row contributes no baseline units, quietly inflating net gain. | **Yes.** Reported with the count and the share of area. Above a threshold the verdict is withheld rather than published wrong. |
| **G3** | **Every metre of hedgerow and watercourse, and every tree, that exists today must appear as a drawn shape on some row.** Where part of a feature is removed, **split it into sections**, one row per section, each carrying the original baseline values, retention **Lost** for what goes and **Retained** or **Enhanced** for what stays. Never shorten a line to show that part of it is going. **This is NE's own instruction.** User Guide 6.1.17: *"users should not manually delete sections of linear features that are to be lost, rather select the appropriate options within the attribute table to reflect this outcome."* And 6.1.16: *"existing features subdivided where there are differences in proposed outcomes (for example partial losses)."* | The most serious failure. The removed length was never in the derived baseline, so the loss is never subtracted and the gain is overstated with no ceiling. | **No.** A file missing a Lost row is identical to one describing a site that never had that feature. Mitigated only by an explicit user declaration, and by the report stating row counts, Lost counts and total derived length on every project. |
| **G4** | **Never re-draw a Retained or Enhanced line.** If the alignment changes, record the old line as **Lost** and the new line as **Created**, or for a watercourse use the meanders layer, which keeps both alignments (G7). **The template permits nothing else for hedgerows.** Retention category is a restricted list keyed on baseline hedge type, and Created is offered on exactly one baseline value, *To be created*. Watercourses get the opposite answer for the same act, because 2.5.31 to 2.5.37 give them a realignment workflow scored as Enhanced. That asymmetry is a property of the template, not an ecological principle. | The row's own length is taken as its baseline length. Lengthening understates the gain; shortening overstates it. | **Partly.** A watercourse marked *Enhanced by Realignment* with no meanders row is reported, and so is a meanders row that links to nothing. For hedgerows there is no equivalent signal. The assumption is recorded on the row and in the report, with its direction stated as unknown. |
| G5 | Where one parcel is divided, **give the parts the parent's name**, either repeated (`H2`, `H2`) or numbered (`H2-1`, `H2-2`), with identical baseline values. Either form rebuilds to a baseline parcel called `H2` (§4). A repeated name is marginally the better of the two, because it states outright that the parts are one parcel. **Naming one part is enough**, so this is a light ask. Published guidance sets no convention here at all. | The parts still merge on shape and values, so the totals hold, but the file offers no agreed name and the parcel is named from its habitat instead, so the list will not reconcile with the survey by name. | **Partly.** Adjoining rows that share values but disagree on name are reported with the merge. Unit totals are unaffected either way, which is why this stays advisory. |
| G6 | Never edit the Area, Length or Count columns by hand. | Nothing in the calculation, but it destroys the only cross-check that detects editing outside QGIS. | **Yes.** In QGIS these always match the shape, so a breach heads the report. |
| G7 | For a re-meandered watercourse: set retention **Enhanced** and enhancement type **Enhanced by Realignment**, keep the **old** channel on the Rivers row, and draw the **new** channel in the meanders layer pointing back at it. | The length change is invisible and the enhancement is scored against the wrong length. **Confirmed by NE.** 2.5.32 has the baseline watercourse keeping its own alignment while the realigned channel is drawn separately, and 2.5.35 has the new channel carrying a parent reference *"completed to match the parcel ref for the baseline polyline"*, the only parent-pointer NE ever specified, for one habitat type. **Caveat:** 2.5.37 calls that layer *"for illustration only"* and has the user type the new length into the metric by hand, so a user following NE exactly may have drawn it loosely. Reading it as authoritative is better than NE's own tooling, but the report should say the length came from it. | **Yes, both directions.** A realignment row with no new channel, and a new channel linking to nothing. |
| G8 | Give every row a name that means something, and prefer a real one to the word `Null`. **This is not a uniqueness rule**, and no file is refused for repeating a name. Published guidance is explicit that a blank is acceptable: 2.5.19 says the parcel reference *"should be left to automatically fill in as 'Null' or filled in with the relevant reference"*, and Appendix A repeats *"Edit with free text or leave as 'Null', do not leave blank"*. A file of `Null` names is a perfectly good file, and its parcels are named from their habitats instead (§4). | Nothing in the units, the reassembly or the reconciliation. An assessor loses the ability to trace a parcel by the name in their own survey, and a re-upload is recognised by shape rather than by name. | **Yes**, counted and reported. |
| G9 | Choose on-site or off-site explicitly on every row. | Off-site parcels merge into on-site baseline parcels. | **Yes**, including the template's own invalid `On site` default on two layers. |
| G10 | Use the dropdowns. Do not type into controlled columns, and do not edit the file outside QGIS. | Arbitrary text enters columns the calculation looks up by exact match. | **Yes, per column.** The template's only file-level constraint is its primary key. There are no other checks inside the file at all. |
| G11 | When a parcel is **Retained**, set the proposed habitat type to the same habitat as the baseline. | A retained parcel quietly becomes a different habitat. | **Yes.** Area habitats are the only layer where retained can change habitat type, because the template pins only the broad type there. |
| G12 | Leave distinctiveness to the dropdown. Never override it. | Distinctiveness stops matching the habitat, and it multiplies units directly. | **Yes**, by working it out again. |
| G13 | For a newly planted tree set category **Newly Planted**; for an existing tree, **Existing**. | A new tree is counted as a baseline tree, inflating the baseline. | **Yes**, but indirectly. The service keys on the baseline tree size band, because the template defaults the category inconsistently across its six tree layers. |
| G14 | Every point is one tree. If several trees share a location, draw one point per tree. | Trees undercounted on both sides. | **Partly.** A count other than 1 is reported, but QGIS resets it on the next edit, so it cannot be relied on. |
