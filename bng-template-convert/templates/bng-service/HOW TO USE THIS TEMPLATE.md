# Building a BNG prototype in QGIS — step by step

Written for someone who has not used QGIS before. Follow it top to bottom and
you will end up with one GeoPackage containing a baseline, a post-intervention
layer derived from it, and a created habitat that straddles two baseline
parcels.

Menu wording is QGIS 3.42 on macOS. On Windows the menus are the same; `Cmd` is
`Ctrl`.

---

## What you are building

```
Red Line Boundary          the site boundary
      |
<type> Baseline            what is there now      PR-1, PR-2
      |   (copy)
<type> Post-Intervention   what it becomes        PR-1, PR-2, PI-POND
```

The important idea: **you draw the baseline once, then copy it**. Everything in
the post-intervention layer starts as an exact copy, so nothing drifts, and each
copied parcel remembers which baseline parcel it came from.

There are **five habitat types**, each with the same baseline / post-intervention
pair, and all in the same GeoPackage:

| Layer pair | Drawn as | Size field | Unit | Filled in by |
| --- | --- | --- | --- | --- |
| **Habitats** | area (polygon) | `Area (ha)` | hectares | QGIS, automatically |
| **Vertical Area Habitats** | line | `Area (ha)` | hectares | **you** — see below |
| **Hedgerows** | line | `Length (m)` | metres | QGIS, automatically |
| **Watercourses** | line | `Length (m)` | metres | QGIS, automatically |
| **Individual Trees** | point | `Count` | trees | **you** |

Areas are in **hectares**, the unit the Statutory Metric works in; lengths are in
metres. The unit is in each column heading so there is nothing to remember. The
measure tool reports hectares too. One hectare is 10,000 square metres, so a
100 m by 100 m parcel reads `1`.

Two need explaining:

- **Vertical Area Habitats** are green walls and intertidal hard structures. They
  are vertical surfaces, so you draw the line they follow on the ground, but the
  area that counts is the *face* of the wall. QGIS cannot work that out from a
  line on a flat map, so you type it in.
- **Individual Trees** are single points, so there is no shape to measure. `Count` is how
  many trees that point represents.

Everything below uses **Habitats** as the worked example. The other four work
identically — same buttons, same copy action — except where flagged in Part 9.

---

## Part 1 — Open the project and set up

### 1.1 Open it

**First, on Windows: put the folder somewhere local, not in OneDrive.** Your
map lives in a database file that QGIS writes to as you work. A folder that
syncs to the cloud can take a copy halfway through a save, or hold the file
while it uploads, and either can damage a day's mapping. Somewhere like
`C:\BNG\` is right. A short path helps for a second reason: Windows refuses
file names longer than 260 characters altogether, and this folder uses up 87
of them on its own.

Double-click **`BNG Service Habitat Mapping.qgz`**. QGIS opens with an empty map
and a **Layers** panel down the left, organised into groups:

- **Red Line Boundary** at the top
- one group per habitat type, each holding its **Post-Intervention** layer
  above its **Baseline** — toggle the top one off to reveal the baseline
  underneath. The line and point types sit above the Habitats (area) group so
  hedges, watercourses, walls and trees are never buried under the polygons.
- a collapsed **Reference data** group at the bottom — the lookup tables that
  drive the dropdowns. Leave it collapsed; never edit anything inside it.

### 1.2 Turn on the toolbars you need

**View → Toolbars**, and make sure these are ticked:

- **Digitizing** — drawing and editing
- **Advanced Digitizing** — splitting and carving
- **Snapping** — making shapes meet exactly

Three new rows of buttons appear. You will use maybe eight of them.

### 1.3 Where the template buttons live

This template adds four of its own buttons. Each **Post-Intervention** layer
carries `1. Copy baseline to post-intervention`, `2. Tidy PI refs after
splitting` (Parts 4 and 6) and `4. Refresh from baseline`. Each **Baseline**
layer carries `3. Rename a ref (updates post-intervention)` — the safe way to
rename a parcel after copying, because it renames the baseline ref *and* every
post-intervention row that points at it (including split suffixes like
`PR-1a`) in one go.

**`4. Refresh from baseline`** is for when you change the baseline *after* you
have already copied it across. Run it on the Post-Intervention layer and it
will, for every row that came from a baseline feature:

- refresh the read-only `Baseline …` values, which are a copy taken when the
  row was created and would otherwise be out of date. This happens whether or
  not the shape moved, so an edit that only changed a condition or a habitat
  type still reaches your row;
- follow the baseline's new shape where it can do so without guessing. An
  untouched copy simply takes the new shape. If the baseline feature was moved
  bodily, the same move is applied to your row, keeping any adjustment you made
  yourself. If an area parcel was reshaped, rows cut from it are trimmed back
  inside it;
- where the shape cannot be resolved without guessing, refresh the values only,
  leave your shape alone, and name the row so you can look at it;
- where the baseline feature has been **deleted**, clear the `Baseline …`
  values and the link, leaving your shape and your proposed values untouched.
  The shape is **still drawn**, so decide whether that row is now genuinely
  `Created` or should be deleted;
- where a baseline feature has **no row here at all**, create one, copied
  across exactly as `1. Copy baseline to post-intervention` would have done it.
  This is what carries a parcel you deleted and re-drew as two;
- check that each area parent is still fully covered by the rows cut from it,
  and report any parent whose rows no longer add up, in either direction;
- give a **split baseline feature** its own hidden id. QGIS copies every
  attribute when it splits a feature, so both halves come out sharing one id
  and neither can be told from the other. The half that continues the original
  parcel keeps the id, the rest become new parcels, and it says which. This is
  the one case where the button edits the **Baseline** layer as well.

Only the locked `Baseline …` columns and `Parent Ref` are ever overwritten.
Everything you own — your shapes, your `Proposed …` values, `Retention
Category`, `Irreplaceable Habitat` — is left alone.

It reports what it did and, like the other three buttons, **saves as it goes**.
There is no undo, so work on a copy of the GeoPackage the first time you use it
on real data. Anything it could not resolve keeps its drift warning on upload,
which is deliberate: the warning is what tells you a shape still needs
attention.

They are **not** in the right-click menu of the Layers panel. QGIS has no such
menu. They live in the **attribute table**:

1. In the Layers panel, right-click the layer → **Open Attribute Table**
   (or select the layer and press `F6`).
2. On the attribute table's own toolbar — the row of buttons across the top of
   that window, not the main QGIS toolbar — look at the **far right-hand end**.
3. The last button there is **Actions** (hover to see the tooltip). Click it and
   the template buttons for that layer drop down.

If you do not see an **Actions** button, you have the attribute table of a
layer that has none open (for example a reference table) — QGIS hides the
button entirely there. Post-Intervention layers show buttons 1, 2 and 4;
Baseline layers show button 3.

> These buttons are little Python scripts stored inside the project. QGIS shows
> them under **Layer Properties → Actions** if you ever want to read one, but
> that dialog is for *editing* them — you cannot run them from there.

### 1.4 Turn on tracing — how to follow an existing edge

Snapping locks a *point* onto an existing corner or edge. **Tracing** is the one
that makes a whole run of your new line follow an existing edge exactly.

Press **`T`**, or click **Enable Tracing** on the **Snapping** toolbar.

Then, while drawing, click once where you want to join the existing edge and
click again further along it — QGIS fills in every intermediate corner of that
edge for you, so your line lies exactly on top of it.

This is what you want whenever a new habitat runs along the boundary of an
existing parcel. Without it you get a straight chord between your two clicks,
which cuts the corner and drifts off the real edge — and if the edge bends
outward, your chord ends up *outside* the parcel, which is what causes
`could not add ring: the inserted Ring is not contained in a feature`.

> Tracing needs snapping switched on for the layer being traced (next section).
> It switches itself off if too many features are on screen — zoom in.

### 1.5 Turn on snapping — do not skip this

Snapping makes a new corner jump to an existing corner or edge when you get
close. Without it your parcels will have hairline gaps and slivers between them,
and the areas will not add up.

1. **Project → Snapping Options…**
2. Click the **magnet** icon at the left of the bar that appears, so it is
   highlighted. Snapping is now on.
3. Set the mode dropdown to **All Layers**.
4. Set the type dropdown to **Vertex and Segment** (some builds call this
   "Vertex and Edge").
5. Set the tolerance to about **10 pixels**.
6. Tick **Topological Editing** (the icon of two joined polygons). Now if you
   move a corner shared by two parcels, both move together.
7. Tick **Avoid Overlap** for the two habitat layers if the option is shown.
   New shapes will then be trimmed so they cannot sit on top of an existing one.

Leave this bar visible; you will glance at it often.

---

## Part 2 — Draw the red line boundary

The red line is the site boundary. Everything else must sit inside it.

1. In the **Layers** panel, click once on **Red Line Boundary** to select it.
2. Click the **yellow pencil** (Toggle Editing) in the Digitizing toolbar. The
   layer is now editable.
3. Click **Add Polygon Feature** (the icon of a polygon with a small yellow
   star).
4. On the map, **left-click** each corner of your site. For a first prototype
   just draw a rough rectangle — the numbers do not matter.
5. **Right-click** to finish the shape.
6. A form pops up. This is where **all the site-wide details** live — they are
   filled in once, here, and nowhere else:

   | Field | What to do |
   | --- | --- |
   | Site Name | Type one. |
   | Location | Where the site is. |
   | Survey Date | When the site was surveyed. |
   | Survey Details | Anything worth recording about the survey itself. |
   | Mapped by | Your name. |
   | Company | Your organisation. |
   | Base Map | What you drew over, e.g. aerial photography. |

   For a first prototype the Site Name alone is enough. Click **OK**.
7. Click the **pencil** again to stop editing, and **Save** when asked.

The boundary draws as an **unfilled red outline** — no fill. That is deliberate:
you are about to draw habitats inside it, and you need to see them through it.

None of the site-wide fields appear again on the habitat forms. Those carry only
a per-parcel **Comment** — if you spot a field like Survey Date missing from a
habitat form, it is not missing, it lives here on the red line boundary.

> **If nothing draws:** you almost certainly have the wrong layer selected in the
> Layers panel. QGIS always draws into the highlighted layer.

---

## Part 3 — Draw the baseline habitats

This is the "what is there now" survey. The aim is to **cover the whole site with
no gaps and no overlaps**.

1. Click **Area Habitats Baseline** in the Layers panel.
2. Click the **pencil** to start editing.
3. Click **Add Polygon Feature**.
4. Draw your first parcel. **Start your corners on the red line** — snapping will
   pull them exactly onto it. Right-click to finish.
5. Fill in the form:

   | Field | What to do |
   | --- | --- |
   | Parcel Ref | Type a label, e.g. `PR-1`. Make each one different. |
   | Baseline Broad Habitat Type | Pick from the list, e.g. `Grassland` |
   | Baseline Habitat Type | Now only shows habitats in that broad type, e.g. `Modified grassland` |
   | Baseline Distinctiveness | Pick the matching value |
   | Baseline Condition | Only shows bands valid for that habitat |
   | Baseline Strategic Significance | Pick one |
   | Irreplaceable Habitat | Usually `No`. Some habitats only allow one answer. |
   | Area | **Leave it.** Filled in automatically and locked. |
   | Comment | Optional — notes about this parcel. The site-wide details (survey date, mapped by, …) live on the red line boundary (Part 2), not here. |

6. Click **OK**. The parcel immediately takes on Natural England's standard
   UKHab colour and pattern for its habitat type. That is expected — and
   useful: a parcel whose colour looks wrong at a glance probably has the
   wrong habitat type set.
7. Draw a second parcel **next to the first**. When you click near the shared
   edge, snapping locks onto it, so there is no gap between them. Give it
   `PR-2` and a different habitat.
8. Keep going until the whole red line area is covered.
9. Click the **pencil** to stop editing, and **Save**.

### Checking you have no gaps

Right-click **Area Habitats Baseline → Open Attribute Table**. Add up the `Area`
column and compare it to your red line area. If it is short, you have a gap.

---

## Part 4 — Copy the baseline across

Now the useful bit.

1. In the Layers panel, right-click **Area Habitats Post-Intervention → Open
   Attribute Table**. It will be empty — that is expected.
2. On that window's toolbar, at the **far right-hand end**, click **Actions**
   (see Part 1.3).
3. Choose **`1. Copy baseline to post-intervention`**.

A green bar appears across the top of the **main QGIS window** (not the
attribute table) saying how many parcels were copied.

It is safe to run again later. Only baseline parcels that have no row here yet
are copied; anything already across is left exactly as you left it, and the
message says how many were skipped. Re-running it is the other way to pick up
parcels added to the baseline after this step.

Every baseline parcel is copied over, and each copy is stamped with:

- **PI Ref** — same as the baseline ref to start with
- **Parent Ref** — which baseline parcel it came from. **Never edit this by
  hand** — and the form will not let you: the field is locked.
- **Retention Category** — `Retained`, meaning "nothing changes here yet". In
  the form and table it sits next to the Proposed columns, because it describes
  what happens to the parcel, not what was there.
- all the baseline values, **Irreplaceable Habitat** included, plus proposed
  values pre-set to match
- two **hidden machine keys** the service uses to link each row to its
  baseline parcel and to notice if the baseline changes afterwards. You never
  see or touch these — they are why renaming a ref is always safe.

The Baseline columns on every Post-Intervention layer are **greyed out**. They
are stamped by this copy button and are read-only — the "before" picture is
never typed in by hand, so you cannot change it here even by accident.

The attribute table you already have open now shows one row per baseline parcel.

> If it warns that rows already exist, delete them first: open the attribute
> table, click the pencil, select all rows, click the **delete** button, save.

---

## Part 5 — Make changes

Now you edit the **post-intervention layer only**. The baseline stays frozen —
that is the whole point of the split.

Select **Area Habitats Post-Intervention** and click the **pencil** to start editing.

### 5a. Change a whole parcel — enhancement

The simplest change: a parcel stays where it is but is improved.

1. Click the **Identify** tool (blue circle with an `i`), then click the parcel.
   Or open the attribute table and find its row.
2. Set **Retention Category** to `Enhanced`. Look for it **next to the Proposed
   fields**, not among the greyed-out Baseline ones.
3. Set **Proposed Habitat Type** and **Proposed Condition** to what it becomes.
4. Leave the geometry alone.

### 5b. Split a parcel in two — part changes, part does not

Use this when only half a parcel is being worked on.

1. Click **Split Features** on the Advanced Digitizing toolbar (an icon showing
   a shape with a line through it).
2. Draw a line **starting outside the parcel**, across it, and **ending outside**
   it. Left-click for each point, **right-click to finish**.
3. The parcel becomes two rows. Both keep the same `Parent Ref` — correct, since
   both halves came from the same baseline parcel.
4. Edit each half separately: one can stay `Retained`, the other become
   `Enhanced`.

> The split line must cross right over the parcel and out the other side. A line
> stopping inside does nothing.

### 5c. Carve a new habitat out of the middle — creation

This is the pond case: a new habitat taking ground from what was there before.

**If the new habitat sits wholly inside one parcel, touching no edge:**

1. Click **Fill Ring** on the Advanced Digitizing toolbar.
2. Draw the pond shape inside the parcel. Right-click to finish.
3. QGIS punches a hole in the parcel **and** creates a new feature filling it —
   exactly, with no gap.
4. Fill the form for the new feature:
   - **PI Ref**: something new, e.g. `PI-POND`
   - **Parent Ref**: locked and blank — leave it
   - **Retention Category**: `Created`
   - **Proposed Broad Habitat Type** / **Habitat Type** / **Condition**: the new pond
   - the Baseline fields are greyed out and blank — correct, since a habitat
     drawn fresh has no "before"

**If the new habitat touches an edge of the parcel — use Split, not Fill Ring:**

Fill Ring is only for holes in the middle. A ring that runs along the parcel
edge produces a polygon whose hole touches its own outline, which is an
**invalid** geometry ("self-intersection") — so do not force it, even if QGIS
lets you. Use **Split Features** instead:

1. Click **Split Features** on the Advanced Digitizing toolbar.
2. Start the cut line **outside** the parcel, bring it in across the edge, trace
   the inland outline of the pond, and take it back out across the edge.
3. Right-click to finish. The parcel becomes two features, each with a copy of
   the parent's attributes.
4. Click the pond piece, set **Retention Category** to `Created` and the
   Proposed fields to the new pond. Its `Parent Ref` keeps the parent's ref —
   correct, since that parcel is where the ground came from (and the field is
   locked anyway).
5. Leave the other piece as it was — it is still the surviving baseline habitat.

> If nothing happens, your cut line began or ended **inside** the parcel. Both
> ends have to be outside it, or exactly on the edge.

**If the new habitat straddles two parcels:**

Do **not** try Fill Ring here. Each half of the pond is bounded by the boundary
*between* the two parcels, so every ring you draw runs along a parcel edge —
which is the one thing Fill Ring cannot do. You do not need to draw the halves
separately either. Cut the whole pond in one pass:

1. Click **Deselect Features from All Layers** first (or `Ctrl+Shift+A`).
   **This matters** — if anything is selected, Split only cuts the selected
   features, and you will get "nothing happened" with no explanation.
2. Click **Split Features** on the Advanced Digitizing toolbar.
3. Draw the pond outline **all the way round**, across both parcels, finishing
   back where you started. Right-click to finish.
4. Both parcels are cut in the same operation. You now have four features: two
   pond halves and the two remainders.
5. Click the **Select** tool, hold **Shift**, click **both pond halves**.
6. Click **Merge Selected Features** on the Advanced Digitizing toolbar.
7. In the dialog, click **Take attributes from selected feature** on whichever
   row you prefer, then **OK**. You now have one pond feature.
8. Fill in its form as above — **Retention Category** `Created`, Proposed
   fields set to the pond. The stamped `Parent Ref` stays; leave it be.

> Why not draw the pond straight over the top as a new feature? Because it would
> overlap the two parcels rather than take ground from them, and the areas would
> come to more than the site. Splitting removes and replaces in one move, so the
> totals stay exactly right — the two halves add back up to the parcels they
> came from, to the last decimal place.

### 5d. Ground that is built on

If a parcel is developed over, set its **Retention Category** to `Created` and
its Proposed habitat to the developed surface it becomes — e.g. `Developed
land; sealed surface`. There is no "Lost" category — the options are only
`Created`, `Retained` and `Enhanced`. This matches the Statutory Metric, which
records built-over ground as *creating* the new surface, not as losing the old
one.

Keep the row — do not delete it. Ground inside the red line cannot vanish, and
the row is how the calculation knows it was accounted for.

**This keep-the-row rule is for area habitats only.** A hedgerow, watercourse,
tree or green wall that is removed has no replacement surface — for those you
**delete the copied row**, and its absence is the record of the removal (each
type's section in Part 9 says exactly how). The service will list everything it
is treating as removed when the file is checked, so a slip of the delete key
gets caught.

When you are done, click the **pencil** and **Save**.

---

## Part 6 — Tidy the references

Splitting leaves two rows sharing one `PI Ref`. Fix it in one click:

1. Open the attribute table for **Area Habitats Post-Intervention**.
2. **Actions** at the far right-hand end of its toolbar (see Part 1.3) →
   **`2. Tidy PI refs after splitting`**.

Duplicates become `PR-1a`, `PR-1b`, and so on, ordered left to right across the
map so the labels are the same every time you run it.

---

## Part 7 — Check the numbers

Open the attribute table for both layers and compare the `Area` totals.

| Check | Expected |
| --- | --- |
| **Habitats** baseline total vs post-intervention total | the same — ground cannot vanish |
| Hedgerow / watercourse / wall / tree totals | post-intervention may be **smaller**; the difference is what you removed, and the service lists it back to you as "treated as removed" |
| Every post-intervention row | has a Retention Category |
| Created rows | have proposed values. For **area habitats**, `Parent Ref` is blank only where the shape was drawn fresh (Fill Ring); a Created row that came out of a split or the copy button — a carved pond, built-on ground — keeps the `Parent Ref` of the parcel the ground came from. For the other types a Created row is always genuinely new, with a blank `Parent Ref` |
| Enhanced rows | have both baseline and proposed values |
| Retained rows | proposed matches baseline (a shortened hedge stays Retained at its new length) |

If the totals differ you have a gap or an overlap. The usual cause is snapping
having been off for part of the session.

---

## Part 8 — Export

Everything is already in one GeoPackage —
`Layers/BNG Service Layers.gpkg`. Editing saves straight into it, so there is no
export step. That file is what goes to the backend.

To send it on, copy that single `.gpkg` file. It contains all three tables.

---

## Part 9 — The other four habitat types

Same workflow throughout: draw the baseline, run the copy action on the
post-intervention layer, edit only the post-intervention layer, tidy the refs.
The differences are these.

### Brand-new habitats — drawn straight onto Post-Intervention

The biggest difference first. For these four types, a habitat can be genuinely
**new** — a planted hedge, a channel dug where there was none, newly planted
trees, a newly built wall. A brand-new habitat has no "before", so nothing is
copied and nothing is carved: you draw it **directly on the Post-Intervention
layer** and the baseline never hears about it.

1. Select the type's **Post-Intervention** layer and click the **pencil**.
2. **Add Line Feature** (**Add Point Feature** for trees) and draw it.
3. Give it a **PI Ref** of its own.
4. Set **Retention Category** to `Created`.
5. Fill in the **Proposed** fields. The greyed-out Baseline fields stay
   blank — correct: a habitat drawn fresh has no "before".
6. Leave **Parent Ref** blank — it is locked anyway. The hidden machine keys
   (Part 4) stay empty of their own accord: a brand-new feature has no parent
   and nothing links it to the baseline.

For a new wall, type the `Area` in yourself as usual; for a new tree point,
the `Count`.

The service takes these rows at face value. They pass its checks even when the
matching Baseline layer is completely empty — a site with no hedges today can
still gain new ones — they raise no warnings, they never appear in the
"treated as removed" list, and they are never matched to a baseline feature by
overlap, so a new hedge snapped along an old one stays independent of it. (The
reverse still fails: `Retained` or `Enhanced` rows over an empty baseline
layer are rejected, because a copy must have something to be a copy of.) For
the calculation to treat a Created row as complete, fill every Proposed field
the type asks for — a hedge needs Proposed Hedge Type and Proposed Condition;
a tree needs Proposed Tree Size, Proposed Rural or Urban Tree and Proposed
Condition; a watercourse also needs both proposed encroachment fields.

**Area habitats are the exception — never draw them from scratch.** Every
square metre inside the red line has to reconcile against the baseline: ground
cannot appear from nowhere. New area habitat is always carved out of the
copied parcels with Split or Fill Ring (Part 5c), so its ground demonstrably
comes from a parcel that was there before.

> Earlier copies of this template made from-scratch drawing impossible in
> practice: on a brand-new row, Retention Category and the Proposed dropdowns
> filtered against the blank Baseline columns and came up empty. They now
> populate on a fresh feature, and a new tree's `Category` fills itself in as
> `Newly Planted` (copies stamped from the baseline get `Existing`). If your
> dropdowns are empty on a new feature, you are working from an old copy of
> the template.

### Vertical Area Habitats — green walls and intertidal hard structures

Drawn as a **line** along the base of the wall or structure.

- **Add Line Feature** instead of Add Polygon Feature. Left-click along the
  route, right-click to finish.
- **You must type the `Area (ha)`** — the face area of the wall in **hectares**,
  i.e. roughly its length times its height, divided by 10,000. It is not
  calculated and not locked, because a line on a map cannot tell QGIS how tall a
  wall is. A 200 m wall 2 m high is 400 square metres, so `0.04`.
- Everything else — habitat type, condition, distinctiveness, irreplaceable —
  behaves as for area habitats, **except removal**: a demolished wall has no
  replacement surface, so **delete its copied row**. The absence is the record.
- A genuinely **new** wall is drawn straight onto the post-intervention layer —
  see *Brand-new habitats* above. The `Area (ha)` rule applies there too: type
  the face area in yourself, in hectares.

### Hedgerows

Drawn as a **line**. `Length` fills in automatically and is locked.

- Use **Split Features** where only part of a hedge is affected. Both halves keep
  the same `Parent Ref`, which is correct.
- If a length of hedge is **removed**, split it off and **delete that piece's
  row**. Lost length is worked out as the difference between the baseline hedge
  and whatever post-intervention pieces remain — exactly how the Statutory
  Metric's own sheets do it. The service reports the missing length back to you
  as "treated as removed", so check that list matches what you meant.
- A hedge that is merely **shortened** with no change in condition stays
  `Retained` — just redraw or split it to the shorter length.
- A genuinely **new** hedge is a fresh line drawn straight onto the
  post-intervention layer, with **Retention Category** `Created` and a blank
  `Parent Ref` — see *Brand-new habitats* above.

### Watercourses

Drawn as a **line**. `Length` fills in automatically and is locked.

This is the one type where the post-intervention shape may **leave the baseline
completely** — re-meandering a straightened channel moves it and makes it longer.
That is expected and correct.

- Draw the new channel wherever it goes. Do not try to keep it on the old line.
- The `Baseline Length` field holds the *original* length, stamped when you ran
  the copy action. **Do not edit it.** It is how the calculation knows how much
  channel you started with, and it must not change when you move the geometry.
- Set **Retention Category** to `Enhanced` and fill in **Enhancement Type**.
- A stretch that is **lost entirely** (culverted, infilled): **delete its
  copied row**. Because a re-meandered channel legitimately leaves the old
  line, the service cannot measure partial watercourse loss from the map — a
  baseline stretch either continues (it has a post-intervention row) or is
  removed (it has none). If only *part* of a stretch is lost, draw that
  baseline watercourse as **two separate baseline features** at survey time,
  so each part can be kept or deleted on its own.
- A genuinely **new** stretch — a channel dug where there was none — is drawn
  straight onto the post-intervention layer: see *Brand-new habitats* above.

### Individual Trees

Drawn as **points**. There is no shape, so there is nothing to split.

- **Add Point Feature**, then click once where the tree is.
- **`Count`** is how many trees that point stands for. Type it in — usually `1`.
- A surviving tree is `Retained`; a newly planted one is `Created`.
- For a newly planted tree: add a point (its **Parent Ref** stays blank), set
  **Retention Category** to `Created`, and fill only the Proposed fields — see
  *Brand-new habitats* above. The `Category` field fills itself in as
  `Newly Planted`; leave it.
- For a **felled** tree: **delete its copied row**. The service reports it as
  removed when the file is checked. If a point stands for several trees and
  only some are felled, keep the row as `Retained` and lower its `Count`.
- If something is planted where a felled tree stood, that is a separate new
  point — `Created`, blank `Parent Ref`. The two events are independent, as
  they are in the Statutory Metric.

### A note on which layers you actually need

You only need to fill in the types present on your site. If there are no
watercourses, leave both watercourse layers empty — empty tables are fine.

---

## Quick reference

| I want to… | Tool | Where |
| --- | --- | --- |
| Start/stop editing | Toggle Editing (pencil) | Digitizing |
| Draw a new shape | Add Polygon / Line / Point Feature | Digitizing |
| Move a corner | Vertex Tool | Digitizing |
| Cut a parcel in two | Split Features | Advanced Digitizing |
| Carve a shape out and fill it | Fill Ring | Advanced Digitizing |
| Join two shapes into one | Merge Selected Features | Advanced Digitizing |
| Make shapes meet exactly | Enable Snapping (magnet) | Snapping |
| Follow an existing edge | Enable Tracing (`T`) | Snapping |
| See a feature's values | Identify | Attributes |
| Run a template button | Actions | far right of the **attribute table** toolbar |
| Undo | `Cmd+Z` | works while editing |

## If something goes wrong

**The dropdowns are empty.** The lookup tables in the **Reference data** group
did not load. Check the
`CSV References` folder is still beside the `.qgz` file.

**Something went wrong saving, on Windows.** Check where the folder lives. In
OneDrive, or anywhere else that syncs, the sync can take the file while QGIS
is writing to it. Move the whole folder somewhere local and open it again.

**I cannot draw.** Either the layer is not selected in the Layers panel, or you
have not clicked the pencil.

**I cannot find `Copy baseline to post-intervention`.** It is not in the Layers
panel right-click menu — QGIS never puts them there. Open the layer's
**attribute table** and use the **Actions** button at the far right of that
window's toolbar (Part 1.3). The copy and tidy buttons are on the
*Post-Intervention* layers; the rename button is on the *Baseline* layers.

**I renamed a baseline ref by typing and post-intervention did not follow.**
It never will — typing edits one cell in one table. Undo it, then use
**`3. Rename a ref`** on the Baseline layer's Actions button (Part 1.3),
which renames the baseline row and every post-intervention `Parent Ref` and
`PI Ref` that points at it, keeping split suffixes like `PR-1a` intact.

**My shapes have slivers between them.** Snapping was off. Undo, turn it on
(Part 1.5), and redraw.

**Split did nothing.** Two possible causes. Either your line did not cross the
whole parcel — it has to start and finish outside it, or exactly on its edge —
**or you had features selected**. If anything is selected, QGIS splits *only*
the selected features and silently reports nothing happened. Press
`Ctrl+Shift+A` to deselect everything and try again.

**Fill Ring works one minute and not the next, and I changed nothing.** You are
almost certainly drawing against a parcel edge. QGIS requires the ring to be
strictly inside the parcel, and it is exact about it — a vertex one-trillionth
of a metre outside fails. Whether a snapped point lands exactly on the edge or a
hair outside is luck, so it is intermittent by nature. Worse, on the times it
*succeeds* you get an invalid self-intersecting polygon. If the new habitat
reaches a parcel edge at all, use Split (Part 5c), not Fill Ring.

**"Fill ring: could not add ring: the inserted Ring is not contained in a
feature".** Despite the wording, this is not about *touching* the edge — it
means part of your ring went **outside** the parcel. Usually you clicked two
points on the boundary and the straight line between them cut a corner off.
Turn on tracing (Part 1.4) so your line follows the real edge. If the new
habitat is meant to reach the parcel edge at all, stop using Fill Ring and split
instead (Part 5c).

**I edited the baseline by mistake.** Undo with `Cmd+Z` before saving. The whole
point of two layers is that the baseline should not change after Part 3.

**The service warns that the baseline changed after the copies were made — but
I never touched the baseline.** This warning compares each baseline shape
against the hidden stamp its copy took in Part 4, and it used to have a false
trigger. With **Topological Editing** on (Part 1.5), splitting a parcel
quietly adds corners to every shape sharing the edge — points sitting on a
straight run that change nothing you can see — and the stamp counted those as
a change. It no longer does: vertices that add no shape are ignored, so the
warning now fires only when a baseline geometry was **really** reshaped. One
leftover: copies stamped **before** that fix, from shapes that already carried
such invisible corners, can still warn once. A fresh copy clears it — delete
the copied rows and re-run **`1. Copy baseline to post-intervention`**
(Part 4), which stamps the baseline as it is now. That throws away your
Part 5 edits, so weigh redoing them against living with a warning you know is
stale.
