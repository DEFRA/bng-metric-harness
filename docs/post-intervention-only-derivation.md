# Deriving the baseline from the post-intervention file alone

**BMD-1001 · spike · status: analysis complete; the derivation is built and sits behind a feature flag**

Whether the full BNG calculation can be produced from a single post-intervention
upload in the **unaltered** Natural England QGIS template, what that costs, and
what an ecologist would have to do for it to be right.

Companion to the options paper *Reconciling post-intervention with baseline*.
This document covers Option B only, and answers that paper's open questions
wherever the template or the service settles them.

---

## How to read this

Sections 1 to 3 explain the idea and show that it works, including how divided
parcels are put back together. Section 4 covers parcel references in full: how
they are read, why the rule requiring them to be unique has been removed, and how
a parcel should be named when the file does not name it. Section 5 covers
hedgerows and watercourses, where the original length has to come from somewhere.
Sections 6 and 7 set out what is gained and lost against the current two-upload
journey, and what the service can and cannot check. Sections 8 and 8a record
defects found along the way and what a user now sees on screen. Section 9 is the
draft guidance for ecologists, which is the part most likely to need review.

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
| **Watercourses** | **Yes, with guidance** | As hedgerows, plus two specifics. Re-meandering is the one case where the post-intervention length can legitimately exceed the baseline, and it is recoverable only through the template's dedicated meanders layer, which could not be read at all until this spike (§8). And a missing encroachment value quietly defaults to a multiplier of 1, which inflates the baseline. That is detectable and reported. |
| **Individual trees** | **Yes, but the weakest completeness case** | Arithmetically the cleanest case of all. A tree's baseline area is a four-band lookup with no geometry, no adjacency and no merging, and it is already worked out correctly on every post-intervention upload today and then thrown away. Same completeness gap as hedgerows and watercourses, and a felled tree left as a Lost row counts toward the baseline exactly as it should. **The gap is worse here than the arithmetic suggests.** User Guide 2.4.1 tells users that tree points are *"for illustrative purposes only"* and *"cannot be imported into the GIS import tool or exported to the main metric or SSM"*. In the legacy workflow the layer therefore feeds nothing, no error check has ever touched it, and users have had no reason to complete it carefully. G13 and G14 rest on much weaker ground than their hedgerow and watercourse equivalents, which at least reach the CSV export. |
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
  reported, but neither decides the group. Agreement can now actually arrive: the
  rule that used to reject a file for repeating a reference has been removed.
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

## 4. How parcel references are handled

**A reference is a name, never an identity.** Parcels are put back together from
shape and baseline values, and only then is a reference read. The calculation
does not move if every reference in the file is wrong, absent, or identical.

That has to be the design, because references cannot be relied on. The template
fills the column with the word `Null` rather than leaving it empty, published
guidance says leaving it that way is fine (§9, G8), and no convention has ever
been set for what happens to a reference when a parcel is subdivided.

**Words that say nothing.** An empty cell, `Null`, `N/A` and `(no selection)` are
all treated as no answer. They are compared ignoring case and surrounding spaces,
and dropped before any name is chosen. The rest of this section calls anything
else a **real** reference.

### Three jobs, only one of which a reference should do

| Job | What it used to key on | What it should key on |
| --- | --- | --- |
| **Grouping**, which rows were one baseline parcel | shape and baseline values | unchanged, this is right |
| **Identity**, which stored parcel a row *is* across a re-upload | the reference | shape, with the reference as a hint |
| **Naming**, what an assessor calls the parcel | the reference | unchanged, this is right |

Only the middle row was wrong, and it is the reason a uniqueness rule was ever
needed. The service keeps a parcel's internal identifier across a re-upload when
its reference matches on both sides, so that a corrected file reads as an update
rather than as everything being deleted and re-created. The reference was chosen
for that job because a check already forced it to be unique. The check was the
leftover, not the requirement, and it has been removed.

### Uniqueness was never a real rule

The check rejected any repeated area-habitat reference and failed the whole file.
It did not distinguish baseline from post-intervention uploads, so it applied to
both, and it ignored a genuinely empty cell but **not** the word `Null`. Run
directly against it before removal:

```
REJECTED  Null, Null, Null      what the template writes by default
REJECTED  PR-1, PR-1, PR-2
REJECTED  H2, H2, H2            the parts of one divided parcel
accepted  H2-1, H2-2, H2-3
accepted  (three empty cells)
```

So a file left exactly as the template wrote it failed as soon as it held two
area habitats, and the one division convention that names the parent honestly
failed too. Neither outcome is defensible, and neither was required by anything
downstream: **nothing in the reassembly, the units, the area reconciliation or
the trading rules reads a reference at all.**

**The check is gone.** The example file built to trip it,
*Baseline - duplicate habitat ref.gpkg*, now passes with no errors. So does
*Baseline - complete but null area refs.gpkg*, whose three rows all carry the
word `Null`, and whose place among the valid files had been an open question for
exactly this reason.

### What each state of the column does now

| In the file | Before | Now |
| --- | --- | --- |
| Distinct real references, one row each | Accepted, each parcel keeps its name | Unchanged |
| All `Null`, untouched | **Rejected** | Accepted. No name; identity from shape; counted in the report |
| Parts of a split sharing the parent's name (`H2`, `H2`) | **Rejected** | Accepted, and treated as **evidence**. Rows that agree on values, adjoin, *and* share a name are a stronger case for merging than shape alone |
| Suffixed parts (`H2-1` to `H2-10`) | Accepted, parent name worked out | Unchanged, and the strongest case of all |
| Two unrelated parcels both called `PR-1` | **Rejected** | Accepted. They do not adjoin and do not share values, so they never merge. The clash is reported and changes nothing |
| Partly filled: `H2` on one part, `Null` on another | Accepted | Unchanged. The blank is ignored and the real name labels the parcel |
| Unrelated names on adjoining parts | Accepted, combined name | Unchanged, and the disagreement is reported |
| Repeated names on hedgerows, watercourses, trees | Accepted, never checked | Accepted, and the watercourse join no longer depends on them |

The third row is the prize. A shared name used to be fatal. It is now the one
piece of supporting evidence the file offers for a merge the service would
otherwise have to justify from shape alone.

Where one name ends up on more than one reconstructed parcel, the report says so.
It is recorded as information rather than a warning, because it genuinely changes
nothing, and it exists so that a clash stays visible now that nothing else in the
service mentions one.

### Identity across a re-upload, without unique references

The reference stops being the key for carrying a parcel's identity forward and
becomes the first of three tiers.

1. **The reference**, where it is real and unambiguous on both sides. Cheap,
   exact, and right for the well-kept files that have one. **Built.**
2. **The shape**, otherwise. The template already defines a fingerprint for a
   shape that ignores meaningless differences, so an unedited parcel re-uploads
   to the same fingerprint whatever its name says. **Not built here.** The code
   exists, on the earlier lineage spike branch, and matches the QGIS template's
   own copy action exactly. Bringing it across is the prerequisite for this tier
   and for most of the naming strategies below.
3. **A fresh identifier**, where neither resolves. Today's fallback. **Built.**

Tier 2 is what would make identity independent of the name altogether. A file of
nothing but `Null` references would still carry identity forward, because the
shapes would be the identity. It fails only where a parcel was both re-drawn and
unnamed, which no scheme could resolve.

**Its absence blocks nothing, and never did.** The service has always refused an
ambiguous reference and fallen back to a fresh identifier. Habitats were the only
layer the removed check ever covered, so hedgerows, watercourses and trees have
arrived with repeated names since the beginning and been handled this way.
Dropping the check widens an existing fallback rather than changing what it does.
What is lost without tier 2 is continuity for the downstream reporting database
across a re-upload of an unnamed file. That is a convenience rather than a matter
of correctness. It stays on the list.

### What removing the rule required

Less than it first appeared. Removal is safe for the derivation, which reads no
references, and one of the two places that looked like a blocker turned out never
to run at all.

**The hedgerow and watercourse length lookup was already inactive here.** It is
built from an uploaded baseline's own rows, so a project with no uploaded
baseline hands it nothing and every enhanced line falls straight through to the
rules in §5. It cannot be confused by a repeated name because it never has a row
to be confused about. It still wants a guard for the two-upload journey, where a
repeated name means the last row quietly wins, but that is a defect on a path
this document does not describe.

**The meanders link was the real one, and no column on the baseline row can
replace it.** The Rivers layer carries 29 columns and exactly one length, which
QGIS keeps in step with the row's own shape. Per 2.5.32 that shape is the **old**
channel, so the column is the baseline length. The realigned length exists
nowhere on that row. It exists only on the meanders layer, whose entire content
is a parent reference and a length.

Guidance 2.5.37 is sometimes read as pointing at a column on the baseline row:

> …this will need to be manually filled out in the *Length Enhanced* column of
> the chosen metric, using the value in the attributes table in the *enhanced by
> realignment* column.

The template does not support that reading. No Rivers column is named or labelled
anything of the kind, and the three "Realigned Proposed" layers are views of the
meanders table. The instruction is to read the length from the attribute table of
the Enhancement by Realignment layer, which is the meanders layer's own length
column. Calling that layer illustrative means only that it does not export to
Excel automatically. It is still the sole record of the new alignment.

The derivation does not need that column, because it measures the shape it
already reads. What it needs is the **link** between a realigned channel and the
Rivers row it replaces, and in the legacy template that link is expressed only as
a reference.

So the meanders link now follows the same three tiers as identity, and this part
**is built**.

1. **The parent reference**, where it names exactly one watercourse marked
   *Enhanced by Realignment*.
2. **The shape**, where it does not. A realigned channel is a re-drawing of one
   specific reach and is drawn alongside it, so nearness identifies the parent
   the name could not. Every such link is reported as inferred and named in the
   row's audit note.
3. **Neither**, which is reported as an unlinked meanders row, unchanged.

Two things had to change underneath it. Children are now attached to the
watercourse row's own internal identifier rather than to its name, because two
rows sharing a name would otherwise each claim the full length of the shared new
channel and the same metres would be counted twice. That is exactly the failure
the uniqueness rule was standing in front of. And the nearness test is expressed
entirely in ratios rather than in metres: a candidate qualifies within half its
own extent and has to be twice as near as the next best. A GeoPackage may arrive
in national grid coordinates or in latitude and longitude, so any fixed distance
would be wrong by a factor of about a hundred thousand on half the example files.

**The shape tier matters far beyond repeated names.** The parent reference on the
meanders layer is plain free text with no dropdown, and the template's default
for it is the word `Null`. So before this change, every file that left the column
alone linked nothing at all, and its realigned watercourses quietly took their
own old channel as their new one.

That removes the last thing the uniqueness rule was protecting. Two watercourse
rows sharing a name stop being a rejection and become a case the shape resolves.

**A connection missing between two working parts.** The meanders links have been
worked out correctly since the derivation landed, and then thrown away before
anything could use them. Neither they nor the derivation's own on/off switch
reached the code that works out hedgerow and watercourse lengths, so the whole
derived length path could not run at all, whatever the switch said. Both are now
connected, with a test on the connection rather than only on the result.

Conversion to the legacy format keeps removing duplicate names regardless. The
legacy import tool really does reject repeated habitat references. That is an
external constraint on that route and not evidence for one here.

### Giving a parcel a name when the file has none

Everything above is about not *rejecting* a name. This is the other half: what
the service should *publish* as one. Users like references, usually supply them,
and reasonably expect the list they get back to be nameable and sortable.

The two halves only reconcile if uniqueness changes sides. It stops being a rule
enforced on what comes **in**, which is the check just removed, and becomes a
promise about what goes **out**. The service accepts whatever the file says and
takes responsibility for producing a name that is unique within its own map.

**That needs three fields where there is one today.**

| Field | Holds | Ever invented? | Used for matching? |
| --- | --- | --- | --- |
| The reference | exactly what the surveyor typed, or nothing | **Never.** Kept as written, so the file can always be reconciled to its source | Yes, as a hint |
| The published name | what the service shows and exports, unique within one layer of one map | Where needed, by the strategies below | **Never** |
| The internal identifier | identity | Already exists | It *is* the identity |

The middle row is the new one, and the rule that makes it safe is the last
column: **an invented name must never take part in matching.** Carrying identity
forward, linking meanders, and corroborating a merge all read the surveyor's own
reference and the shape. If an invented name could match, the service would be
matching on its own invention and reporting the result as though the file had
said it.

Uniqueness is promised **within one layer of one map**, not across everything.
Habitats, hedgerows, watercourses and trees already have separate reference
columns, and a baseline parcel `H2` and its post-intervention parts sharing that
name is the link home rather than a clash.

#### The strategies

| # | Strategy | Applies when | Example | What keeps it stable |
| --- | --- | --- | --- | --- |
| 1 | **Take what is given** | A real reference on a parcel nothing else shares | `PR-1` stays `PR-1` | The surveyor's own input |
| 2 | **Agree on the shared name** | A rebuilt parcel whose parts all say the same thing | `H2`, `H2`, `H2` becomes `H2` | The same |
| 3 | **Take the parent from the parts** | A rebuilt parcel whose parts are numbered from one name | `H2-1` to `H2-10` becomes `H2` | The parent name is worked out from the whole group, not from row order |
| 4 | **Keep both names** | A rebuilt parcel whose parts carry unrelated names | `North Field` plus `Long Meadow` becomes a combined name | Names sorted before combining |
| 5 | **Add a letter** | One name on parcels that did **not** merge | `PR-1`, `PR-1` becomes `PR-1a`, `PR-1b` | Letters given out in shape order, and never taken back from a parcel that still exists |
| 6 | **Name it after the habitat** | Nothing real to work from | a grassland parcel becomes `GRA-001` | Given once and stored, never worked out again |
| 7 | **Name it after the layer** | As 6, if habitat codes are not wanted | `A-001`, `HG-001`, `WC-001`, `TR-001` | Unaffected by any value changing |
| 8 | **Name it after the shape** | Nothing above resolves and a name is still required | `A-3f9c2a` | The shape fingerprint itself |
| 9 | **No name** | Nothing above, and none is wanted | blank | Today's behaviour. The parcel is identified by its shape |

#### The recommended approach, in plain English

No single strategy is the answer. They are steps in one order of preference,
applied to each parcel in turn, and a real file will use several of them at once.
A site with forty parcels might name thirty-two from what the surveyor typed,
work out the parent name for two split parcels, add a letter to two that clashed,
and invent names for the four left blank. That is the normal case, not an
awkward one.

**First, put the parcels back together. Then name them.** Naming has to come
second, because until the parts of a split have been rejoined there is no parcel
to name.

**Second, set aside every name the surveyor actually typed.** Those are spoken
for. Nothing invented later may take one of them, so an invented `GRA-001` can
never collide with a real `GRA-001` somewhere else on the site.

**Third, ask what the parts of each parcel say, ignoring the blanks.** This is
the rule that does most of the work, and it is the answer to split parcels that
were only partly named:

> **Naming one part of a split names the whole parcel.**

A parcel rebuilt from three parts labelled `H2`, blank and blank is called `H2`.
So is one labelled `H2-1`, blank, `H2-3`. Blanks inside a group are not
disagreement, they are silence, and silence is ignored. A user therefore only has
to name one part of a division for the parcel to come back with the right name,
which is a far lighter ask than naming every part consistently.

With the blanks dropped, what remains decides the name:

- **Nothing left.** The parcel has no name from the file, so one is invented at
  the fourth step.
- **One name.** That is the parcel's name. This covers both the fully consistent
  split, `H2`, `H2`, `H2`, and the partly filled one above.
- **Several names, all numbered from one parent.** `H2-1` to `H2-10` gives `H2`,
  and the service records that it worked the name out rather than reading it.
- **Several names, one of which is the parent of the others.** `H2` beside `H2-1`
  should give `H2`. **This case is currently wrong.** Run against the service as
  it stands, `H2`, `H2-1`, blank produces the combined name `derived:H2+H2-1`,
  and `H2`, `H2-1`, `H2-2` produces `derived:H2+H2-1+H2-2`. Both should be `H2`.
  The rule needs one addition: a name that is the stem of every other name in the
  group wins outright. This is the single most likely mixed convention in the
  wild, because it is what happens when a user names the original parcel and then
  numbers the pieces they cut from it.
- **Several unrelated names.** `North Field` beside `Long Meadow` is a genuine
  disagreement and should not be resolved by guessing. Both names are kept,
  combined, and the disagreement is reported so a person can settle it. This is
  deliberately the ugliest outcome in the list, because it should prompt a fix.

**Fourth, invent a name for anything still unnamed.** Prefer the habitat-based
form, `GRA-001` for grassland, because it tells a reader something and groups
sensibly in a sorted list. Where a habitat vocabulary is unwanted, or where the
habitat itself may be edited later, the plain layer form `A-001` is the safer
choice. Number them in **shape order** rather than row order, so that
re-uploading the same file, or the same file with its rows shuffled, produces the
same names. Shape order means sorting on the fingerprint of each parcel's
outline, the same one described under identity above, so it depends on the ground
rather than on how the file happened to be saved.
Use a fixed width, `001` rather than `1`, so the names sort correctly everywhere,
not just on the screens that already pad them.

**Fifth, resolve any clash that is left.** If two genuinely different parcels
have ended up with the same name, add a letter: `PR-1a`, `PR-1b`. Letters go in
shape order for the same reason, and once a letter is attached to a parcel it
stays with that parcel for as long as the parcel exists. Adding a third `PR-1` on
a later upload must not renumber the first two under an assessor who has already
read them.

**Sixth, keep it.** A name, once given, is stored with the parcel and carried
forward. It is not worked out again on the next upload. Otherwise editing a
habitat type would silently rename a parcel, which is precisely the trust a
reference exists to provide.

**And throughout, never overwrite what the surveyor typed.** The published name
may differ from the reference in the file, and where it does, both are shown. The
surveyor's own column is evidence and stays exactly as written.

#### Fitting the intervention categories

A post-intervention row takes its name from the baseline parcel it belongs to.
The question is whether the name should also say what is being done to it.

| Situation | Baseline parcel | Post-intervention rows |
| --- | --- | --- |
| Kept whole and improved | `H2` | `H2` |
| Split, part kept and part improved | `H2` | `H2-1`, `H2-2` |
| Split three ways across categories | `H2` | `H2-1`, `H2-2`, `H2-3` |
| New habitat on ground that had none | none | `C-001` |

**The recommendation is to keep the category out of the name.** It is tempting to
write `H2/R1` for the retained part and `H2/E1` for the enhanced part, and it
does make a list easier to scan. It also breaks the one thing a reference is for.
The surveyor's field notes say `H2`, the report would say `H2/E1`, and the two no
longer reconcile. Retention is already its own column and belongs there. A plain
number is enough to tell the parts of a split apart, and the shared stem is what
carries the link home.

Two facts constrain this and are easy to get wrong.

**Retention describes the intervention, not the parcel.** That is why it is kept
out of the grouping test. In the shipped example file the ten parts of one
divided parcel carry *Lost*, *Retained* and *Enhanced* between them, so a single
parcel has no single category to put in its name.

**A created habitat has no parent.** It did not come from a baseline parcel, so
there is no name for it to inherit and it has to be given one of its own, from a
separate series. That is the one place where the naming does have to know about
the categories, and it is a created-or-not question rather than a three-way one.

#### What must not happen

- **No invented name is ever written back into the surveyor's column.**
- **No strategy re-introduces a rejection.** Every one of them has an answer for
  every input, and "no name" is the floor.
- **No invented name takes part in matching**, per the rule above.
- **No name changes retroactively.** A parcel's name does not move under an
  assessor because a value was edited elsewhere.

### Choosing the name for a rebuilt parcel, as built today

The rules in force are the first four strategies above, applied to the real
references across a group's parts:

| Distinct real names in the group | Name the parcel carries | Marked as worked out? |
| --- | --- | --- |
| Exactly one | That name | No, it is the parcel's own |
| Several, all numbered from one parent (`H2-1` to `H2-10`) | The parent, `H2` | **Yes** |
| Several, unrelated (`North Field`, `Long Meadow`) | Both, combined | No, it claims nothing |
| None | blank | No |

The parent rule accepts a hyphen, underscore, dot, slash or space before a purely
numeric tail, and every part has to agree. `H2-1` beside `H3-1` gives no parent,
and neither does `H2-north`, because that is a name rather than a piece number.
Names are sorted before being combined, so the result depends on the group rather
than on the order the rows were read.

Two additions are outstanding, both described above: a group whose parts all
carry the same name should be recorded as the surveyor's own rather than as
worked out, and a name that is the parent of the others in its group should win
outright.

Whatever is chosen, the report lists every contributing name and records whether
the service picked it. The parcel keeps the lowest identifier among its parts, so
re-uploading the same file rebuilds to the same identity.

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

The calculation already caps the baseline length at the post-intervention length
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

## 8. Three defects found in the template, the checks and the plumbing

- **A trailing space in a column name.** The meanders layer's advance-years
  column ends in a space, the only column in the entire template with stray
  whitespace. The service's column comparison ignored case but not spaces, so
  **until this spike, no file containing a populated meanders table could be
  uploaded at all.** The one clean route out of the re-meandering problem was
  unreachable. Fixed.
- **The meanders layer was never read.** It was missing from the service's list
  of known layers entirely, so even a well-formed file would have had it ignored.
- **The meanders links were worked out and then thrown away.** With the two
  above fixed, they were produced correctly and then dropped before anything
  could use them. Neither they nor the derivation's own on/off switch reached the
  code that works out hedgerow and watercourse lengths, so the entire derived
  length path could not run at all, no matter what the switch said. Found by
  asking what a repeated reference would break in the meanders link, and
  discovering the link had never run. Both are now connected, with a test on the
  connection rather than only on the result.

---

## 8a. What the user actually sees

The derivation is only worth having if the journey reaches it, and two things
stood between the two.

**The upload finished on the wrong page.** Baseline uploads have finished on the
project summary since those pages were built. Post-intervention uploads still
fell through to the habitat list, because only the baseline upload carried an
instruction about where to go next. That was harmless while every journey began
with a baseline upload that had already taken the user to the summary. It was
fatal here: with a post-intervention file alone, nothing else ever routes there,
so the whole design was unreachable for the entire journey. The habitat list
keeps its job as the editing surface, and every habitat detail page still backs
out to it.

**The summary pages could not see a derived baseline.** They read the uploaded
baseline directly, in six places, rather than asking for whichever baseline the
project has. Because the check controlling access had already been updated, the
pages rendered and then contradicted themselves: a confident **0.00 units** under
"On-site baseline", beside a **+25.20%** net change worked out from the derived
baseline the tile was failing to show. A blank page would have been safer than a
wrong one. All six now read the same document the headline does.

Where a derived baseline is in play the tile says so three times over. The
heading reads *On-site baseline (derived)*, a grey **Derived** tag sits beside
it, and *How we worked this out* links to an explanation. Where coverage is
insufficient the figures are still shown, because they are the best the file
supports, but the Met or Not met verdict is replaced by **Cannot be determined**
rather than published from a baseline the service knows it could not fully
account for.

**One thing deliberately left alone.** The task list still shows "On-site
baseline habitats, not yet started" for a post-intervention-only project, and
still links that row to the upload page. That is accurate, because no baseline
file was uploaded, and the row is the way in to the optional baseline upload that
corroboration depends on. The project list no longer routes users through it, so
a derived project opens straight on the summary.

---

## 9. Draft user guidance

Authoritative guidance does exist, and an earlier draft of this section said it
did not. The two-page PDF shipped inside the template folder is only the cover of
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
| G5 | Where one parcel is divided, **give each part the parent's name**, either repeated (`H2`, `H2`) or numbered (`H2-1`, `H2-2`), with identical baseline values. **Twice corrected.** An earlier draft asked for the same name on every part, which is right in principle but used to fail the upload. The next draft asked for numbering only, which is narrower than necessary. Uniqueness has now been dropped, so both work, and a repeated name is the better one: it says the parts are one parcel rather than leaving the service to work it out. Naming **one** part is enough. Published guidance sets no convention here at all. | The parts still merge on shape and values, so the totals hold, but the parcel gets a combined name and the list will not reconcile with the survey by name. | **Partly.** Adjoining rows that share values but disagree on name are reported with the merge. Unit totals are unaffected either way, which is why this stays advisory. |
| G6 | Never edit the Area, Length or Count columns by hand. | Nothing in the calculation, but it destroys the only cross-check that detects editing outside QGIS. | **Yes.** In QGIS these always match the shape, so a breach heads the report. |
| G7 | For a re-meandered watercourse: set retention **Enhanced** and enhancement type **Enhanced by Realignment**, keep the **old** channel on the Rivers row, and draw the **new** channel in the meanders layer pointing back at it. | The length change is invisible and the enhancement is scored against the wrong length. **Confirmed by NE.** 2.5.32 has the baseline watercourse keeping its own alignment while the realigned channel is drawn separately, and 2.5.35 has the new channel carrying a parent reference *"completed to match the parcel ref for the baseline polyline"*, the only parent-pointer NE ever specified, for one habitat type. **Caveat:** 2.5.37 calls that layer *"for illustration only"* and has the user type the new length into the metric by hand, so a user following NE exactly may have drawn it loosely. Reading it as authoritative is better than NE's own tooling, but the report should say the length came from it. | **Yes, both directions.** A realignment row with no new channel, and a new channel linking to nothing. |
| G8 | Give every row a name that means something, and prefer a real one to the word `Null`. **This is not a uniqueness rule.** An earlier draft demanded names unique within a layer, which reflected a validator constraint that was itself a leftover. Published guidance points the other way: 2.5.19 says the parcel reference *"should be left to automatically fill in as 'Null' or filled in with the relevant reference"*, and Appendix A repeats *"Edit with free text or leave as 'Null', do not leave blank"*. A file of `Null` names is a perfectly good file whose parcels the service simply cannot name. | Nothing in the units, the reassembly or the reconciliation. An assessor loses the ability to trace a parcel by name, and a re-upload falls back to matching on shape. | **Yes**, counted and reported. A repeated area-habitat name used to reject the file while no other layer was checked at all. Both were artefacts of the constraint rather than intended behaviour, and the check has been removed. |
| G9 | Choose on-site or off-site explicitly on every row. | Off-site parcels merge into on-site baseline parcels. | **Yes**, including the template's own invalid `On site` default on two layers. |
| G10 | Use the dropdowns. Do not type into controlled columns, and do not edit the file outside QGIS. | Arbitrary text enters columns the calculation looks up by exact match. | **Yes, per column.** The template's only file-level constraint is its primary key. There are no other checks inside the file at all. |
| G11 | When a parcel is **Retained**, set the proposed habitat type to the same habitat as the baseline. | A retained parcel quietly becomes a different habitat. | **Yes.** Area habitats are the only layer where retained can change habitat type, because the template pins only the broad type there. |
| G12 | Leave distinctiveness to the dropdown. Never override it. | Distinctiveness stops matching the habitat, and it multiplies units directly. | **Yes**, by working it out again. |
| G13 | For a newly planted tree set category **Newly Planted**; for an existing tree, **Existing**. | A new tree is counted as a baseline tree, inflating the baseline. | **Yes**, but indirectly. The service keys on the baseline tree size band, because the template defaults the category inconsistently across its six tree layers. |
| G14 | Every point is one tree. If several trees share a location, draw one point per tree. | Trees undercounted on both sides. | **Partly.** A count other than 1 is reported, but QGIS resets it on the next edit, so it cannot be relied on. |

---

## 10. Separately: two pre-existing defects in the tree path

Found while mapping, **present in the shipped two-upload journey**, and
deliberately **not fixed here**, because fixing them would move existing results
and needs its own sign-off.

- A tree's top-level area is overwritten with its *proposed* notional area, so an
  enhanced tree whose baseline and proposed size bands differ is scored with the
  proposed band on **both** sides of the calculation.
- Tree advance and delay years never reach the calculation at all, because the
  Urban Trees layer spells both columns differently from every other layer.

Both make tree net gain optimistic. The new derivation does not repeat either,
and rows affected by the first are named in the report.
