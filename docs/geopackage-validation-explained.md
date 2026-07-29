# GeoPackage validation explained

**What this describes.** Every rule the BNG Metric service applies to a baseline GeoPackage when you upload it — what causes a file to be rejected, and what to change to make it pass.

**This document is generated, not hand-written.** Editing it directly will be undone by the next run. To change it, change the generator: run `/geopackage-validation-explainer` in the `bng-metric-harness` repository.

**It reflects these commits, all on `main`:** backend `8da3743`, frontend `27e3154`, bng-library `c3f6968`. Generated 29 July 2026.

**Related.** This document explains what makes a file *acceptable*. For how biodiversity units are then *calculated* from an accepted file, see [rules-engine-explained.md](rules-engine-explained.md).

---

## 1. In one paragraph

When you upload a GeoPackage, the service checks it in two passes. The first pass asks whether the file is structurally what the service expects: a real GeoPackage, containing the layers and columns of the Natural England template, drawn in British National Grid. If anything there is wrong, the upload stops immediately and nothing else is looked at. Only if that pass is completely clean does the second pass run, which examines the mapping itself — whether the shapes are valid, whether the parcels fill the red line boundary without gaps or overlaps, and whether the habitat data is within the scope of the service. A failure at any point means nothing is saved and you must correct the file and upload it again.

## 2. The two things "invalid" can mean

This distinction governs everything else, and it is the thing readers most often get wrong.

**The upload is rejected.** Nothing is saved, you are sent to an error page, and you must fix the file and upload again. Every rule in this document is of this kind.

**The upload is accepted but a feature scores nothing.** The file is perfectly fine *as a file*. One habitat inside it could not be scored — because its habitat type or condition was not recognised, or because the improvement proposed for it is not possible between those two conditions. That feature is marked **Incomplete** and contributes zero biodiversity units. The rest of the file proceeds normally.

Only the first kind produces an error message. The second happens silently.

**A successful upload is therefore not confirmation that every feature was understood.** If your unit totals look lower than you expect, check for features marked Incomplete before assuming the calculation is wrong. Nothing in this document will help with those, because nothing in the upload checks for them.

## 3. Before anything else — is it a GeoPackage at all?

Three checks run before the service looks at your mapping at all. Each one stops the upload immediately, so you will see one of these and nothing else.

**The file cannot be opened.** You uploaded something that is not a GeoPackage — a shapefile, a zip, a spreadsheet, a QGIS project file — or the file is truncated or corrupted, typically from an interrupted copy or a download that did not finish. *Fix:* upload the actual `.gpkg` file. If it genuinely is one, copy it again from source and check the file size looks plausible.

**The file opens but is not badged as a GeoPackage.** Most often a SpatiaLite or plain database that was given a `.gpkg` name. The badge is inside the file, so renaming the extension does not help. *Fix:* re-export properly as a GeoPackage from QGIS.

**The GeoPackage's internal housekeeping tables are missing.** The file was assembled by a non-standard tool, hand-edited, or damaged. This is broken at the format level and there is nothing you can meaningfully repair. *Fix:* re-export from QGIS, or start again from the Natural England template.

## 4. Does it match the Natural England template?

The service does not accept any well-formed GeoPackage. It compares your upload against a fixed template and rejects anything that differs. This is stricter than it looks — a renamed column or a leftover layer fails even though the map is drawn perfectly.

**This is where most of the rules live and where you are told least.** Almost every rule in this section produces the same generic message: *"The layer names and column names do not match what is required by Natural England."* It does not say which layer or which column. Worse, the specific technical detail is only listed when there is more than one problem — so a file with exactly one schema fault gets the least useful message of all. Expect to work by elimination here, and read section 8 before you start.

### The layers

Two layers are **required**: `Habitats` and `Red Line Boundary`. Four are **optional**: `Hedgerows`, `Rivers`, `Urban Trees`, and `Water course enhancement through meanders`.

Names are matched ignoring capitalisation, but everything else must match exactly, including the spaces. `Red_Line_Boundary` and `Area Habitats` both count as missing.

**No other mapping layer is permitted.** A constraints layer, a site plan, or a working copy called `Habitats_v2` will each reject the upload. Renaming a template layer produces two errors at once — the template layer is now missing, and your renamed one is an intruder. The check looks only at vector mapping layers, so an embedded raster or tile basemap slips past it.

*Fix:* delete extra layers from the package before uploading, and restore the template names exactly.

### The coordinate reference system

Every layer must be in **British National Grid, EPSG:27700**. Latitude and longitude (EPSG:4326) and Web Mercator are both rejected.

*Fix:* reproject the layer in QGIS and re-save. **Be careful: relabelling a layer's coordinate system is not the same as reprojecting it.** If you drew in latitude and longitude and simply change the label to 27700, this check passes and the file is then rejected much later for being outside England — a far more confusing message to diagnose.

A related failure is when the file records a layer's coordinate system in two places and the two disagree. QGIS displays such a layer without complaint. There is no fix from the map canvas; re-export the layer into a fresh copy of the template, which rewrites both records consistently.

### The columns

Every column the template defines must be present, with the same name and the same kind of value. Text where a number is expected is a failure. Column *length* is never checked, so a text field of any size is fine.

Two things here surprise almost everyone:

**Extra columns are allowed.** You may add your own working fields to a template layer and the service ignores them. The instinct to tidy up by deleting unused columns is exactly what breaks the file. Two cautions: an added column that itself holds shapes is *not* ignored and will reject the layer; and beyond names and types, the template also fixes which column is the row identifier and which columns must always carry a value, so changing either of those settings fails even when the name and type are right.

**Some column names differ between layers in ways that look like typos but are not.** `Habitats` and `Urban Trees` use `Comment`; `Hedgerows` and `Rivers` use `Comments`. Anyone standardising these will break the file.

*Fix:* rather than patching names one at a time, paste your features into a fresh copy of the Natural England template. This is faster and it fixes the column types, the row identifier and the geometry declarations at the same time.

### The declared shape types

Each layer declares what kind of shape it holds, and this must match the template exactly regardless of what you actually drew. `Habitats` must be declared **MultiPolygon**. `Red Line Boundary` must be declared **Polygon**. Hedgerows and Rivers must be **LineString**, and Urban Trees **Point**.

Note that the two required layers want opposite things, and QGIS presents both as "polygon layers". Building your own Red Line Boundary layer and choosing MultiPolygon from the dropdown — a completely reasonable choice — rejects the file before anyone looks at your drawing.

**The strongest single piece of advice in this document: start from the Natural England template GeoPackage and add your features to it. Do not build the layers yourself.**

## 5. Is the mapping usable?

These checks look at the shapes themselves.

### The red line boundary

**Exactly one boundary is required.** Zero is a failure; two or more is a failure. What is counted is the number of *rows*, not the number of separate pieces of land — so a site made of three detached areas stored as a single multi-part feature is one boundary and passes.

*Fix for "too many":* select the boundary features and use **Edit → Merge Selected Features**. This changes nothing you can see on the map; it only changes the row count.

*Fix for "none":* if the attribute table has rows but the map shows nothing, those rows have no shape attached — delete them and redraw with the polygon tool.

### Habitat parcels, hedgerows and watercourses

Habitat parcels must be areas; hedgerows and watercourses must be lines.

A subtlety worth understanding. If *every* shape in the Habitats layer is the wrong type, you are told there are no habitat parcels at all — which reads as though the layer were empty, even though QGIS is clearly showing features. Hedgerows and watercourses word the same situation differently, saying the layer has features but no usable lines. In practice you will see neither sentence: every wrong-shape rule falls back to the generic message about layer and column names, so the nature of the fault has to be worked out from the layer rather than read off the screen.

*Fix:* use **Processing → Extract by Geometry Type** to isolate the correct features, and move the others to the layer they belong in.

### Optional layers, empty layers, and empty rows

This is the most counter-intuitive rule in the document.

An optional layer that is **absent** is fine. An optional layer that is **present and completely empty** is also fine — shipping the full Natural England template with unused layers left empty is the normal, expected thing to do.

But an optional layer containing **rows with nothing drawn** is rejected. The service first asks whether the layer has any rows at all, and skips it only when the answer is none. Rows with nothing drawn still count towards that total, so the layer is examined, no line is found in it, and the file fails. On the map canvas an empty layer and a layer of empty rows look identical.

*Fix:* delete the empty rows. An empty layer passes; a layer of empty rows does not.

### Invalid shapes

A shape can be recognisable as a polygon and still not be a legal one. The commonest case is **self-intersection**, usually a "bowtie" — the corners were clicked in the wrong order, so the outline crosses over itself.

This matters because a polygon is stored as an ordered list of corners and "inside" means the area they enclose. Where the outline crosses itself, there is no consistent answer to whether a given point is inside the site. Area calculations misbehave for the same reason: the two lobes can partially cancel, so a bowtie can report less area than the ground it appears to cover. Since the whole calculation depends on measured areas and on what lies inside the red line, an ambiguous shape has to be rejected rather than guessed at.

Other causes are a vertex dragged past its neighbour so the outline doubles back, an excluded area digitised so that it pokes outside its parent parcel, and duplicate corners from a double-click while digitising.

*Fix:* run **Vector → Geometry Tools → Check Validity** on the layer. It reports the same faults at the same coordinates the service uses, so you can zoom straight to the problem. For habitat parcels, **Processing → Fix Geometries** repairs them mechanically — but check the result afterwards, because repairing a bowtie changes its area. For the red line boundary, prefer fixing it by hand with the vertex tool: the boundary is legally meaningful, and an automatic repair can split it into pieces, which then fails the "exactly one boundary" rule.

The error names every offending parcel by its Parcel Ref, up to fifty of them. For the red line boundary only the first fault is reported.

### Unreadable shapes

Different from invalid, and worth separating. *Invalid* means the shape was read perfectly and is nonsense. *Unreadable* means no shape could be read at all — the stored data is truncated or corrupt. An invalid file opens normally in QGIS and looks wrong; an unreadable one usually shows blank or missing features there too.

*Fix:* do not try to repair these individually. Re-export the layer from its original source into a fresh GeoPackage, and check the uploaded file size matches the original — a short file is the classic sign of a truncated transfer.

## 6. Does the mapping hang together?

These checks examine how your shapes relate to each other. **Your habitat parcels are expected to tile the red line boundary exactly** — covering all of it, none of it twice, and nothing outside it.

Every tolerance below is in real metres on the ground.

| Check | Tolerance | What passes |
| --- | --- | --- |
| Parcels overlapping each other | 0.5 m² | Parcels that merely touch along a shared edge; any overlap up to half a square metre |
| A parcel outside the boundary | 0.5 m² | A parcel escaping by up to half a square metre |
| Gaps inside the boundary | none, up to a 1 m² ceiling | Only a gap of effectively zero area |
| Parcels spilling outside, measured together | 0.5 m² | Escaping material up to half a square metre |
| Hedgerows outside the boundary | 0.1 m of total length | A hedgerow ending exactly on the boundary, or poking out up to 10 cm |
| Watercourses outside the boundary | 0.1 m of total length | As hedgerows |
| Trees outside the boundary | 0.1 m | A tree inside, exactly on, or up to 10 cm outside the boundary |
| Green infrastructure outside the boundary | 0.5 m² | Escaping by up to half a square metre |
| Habitat areas versus boundary area | 0.5 m² | A difference of up to half a square metre either way |
| Boundary area | 100 km² | Any site up to 100 km² |

### Gaps between parcels — the commonest rejection of all

If two parcels were drawn independently rather than snapped together, their shared edge may run a millimetre or two apart along its whole length. That leaves a hairline gap of perhaps 0.2 m². It is invisible at any zoom level you would normally use, and it will reject your file.

**Note the tolerance in the table above: gaps inside the boundary get no forgiveness.** Every other check here allows half a square metre. This one has no allowance beyond the millimetre at which the service stops distinguishing between shapes at all — so a sub-millimetre misalignment is absorbed, and anything coarser is not. A user who learns "the service tolerates 0.5 m²" from an overlap message will be baffled when a 0.2 m² gap fails.

There is also a ceiling of one square metre, above which a gap is no longer treated as a hairline at all. It is taken to be legitimately uncovered land, and surfaces as your habitat areas not summing to your boundary area. Between roughly half a square metre and one square metre you get **both** messages for the same single gap. Above a square metre you get only the area-sum one, which describes the same fault in quite different words.

*How to find one:* you cannot find it by looking. Use the **Topology Checker** plugin with the rule *must not have gaps*, or reproduce the check directly — **Dissolve** the Habitats layer, then run **Difference** with the Red Line Boundary as input and the dissolved habitats as overlay. Anything in the output is a gap.

*Fix:* the real fix is upstream. Before drawing, turn on **Project → Snapping Options** with snapping set to vertex and segment across all layers, plus Topological Editing and Avoid Overlap. Then parcels snap to each other and to the boundary as you draw. For a file you already have, **v.clean** in the Processing toolbox with the `snap` tool and a small threshold closes hairline gaps mechanically.

### Parcels overlapping

The same piece of ground claimed by two parcels. Parcels that merely touch along a shared edge are the normal, correct case and always pass.

*Fix:* the **Topology Checker** plugin with the rule *must not overlap* draws the offending intersections so you can see them. The message names both parcels by their Parcel Ref, so you can select them by attribute. If the overlap is structural rather than a digitising slip, decide which parcel owns the land and use **Difference** to cut it out of the other.

### Things outside the boundary

Parcels, hedgerows, watercourses, trees and green infrastructure are each checked for escaping beyond the red line. For hedgerows and watercourses the tolerance is a **total, not a per-excursion allowance** — a hedgerow wandering 4 cm outside at three separate places totals 12 cm and fails, even though no single excursion is visible. Trees are measured differently despite sharing the same number: their 10 cm is a straight-line distance from the boundary, which behaves the way you would expect.

*Fix:* snap to the Red Line Boundary layer specifically, with segment snapping enabled so vertices can land anywhere along the boundary rather than only on its corners. For a bulk fix, **Clip** the layer to the boundary — but recompute any Area or Length attributes afterwards, since clipping changes them.

For trees the tolerance is generous, so a failure usually means the tree really is outside the site rather than that it needs snapping. Check also that the tree was recorded at the trunk rather than the canopy edge.

### Habitat areas not matching the boundary area

This compares the total area of your habitat parcels against the total area of your red line boundary. The tolerance is a fixed half a square metre in either direction — not a percentage — so **large sites are proportionally much harder to pass than small ones**. A fifty-hectare site still gets only half a square metre of slack.

This error is a symptom rather than a cause; fix the geometry first. If your habitat total is *smaller*, you have a gap. If it is *larger*, you have overlaps or parcels spilling outside. Both numbers are printed so you can tell which, though currently beneath a placeholder heading — see section 8. Do not try to fix it by editing the Area column: the check measures the shapes, not the attribute.

One caution on reading it. The two totals are plain sums of each feature's area, so faults in opposite directions can cancel out. A file with a one square metre gap *and* a one square metre overlap balances, and this check stays silent even though both faults are real. It will not let anything through — the gap and the overlap each have their own check — but a clean area sum is not evidence that the parcels tile correctly.

The check is skipped entirely when either layer is empty, so you get a clearer "no boundary" or "no habitat parcels" message instead.

### The boundary outside England

The boundary is compared against a reference outline of England published by the ONS.

*Fix:* check first whether your file is really in the coordinate system it claims. A boundary in the wrong system lands in the sea and this is the check that catches it. Confirm the coordinates look like British National Grid eastings and northings — six digits — rather than degrees.

**A caution.** The reference outline is the coarsest boundary product the ONS publishes, and its coastline is simplified by a considerable margin. The tolerance is half a square metre. So a genuinely English site on the coast, an estuary, or the Welsh or Scottish border can be rejected as being outside England, and no amount of tolerance will help. If this happens for a real English site, it is a limitation of the reference data and not something to fix in your file — raise it with the service team.

### The boundary being too large

The cap is 100 km², or 10,000 hectares. This is far larger than any plausible development site, so in practice it catches a coordinate system error rather than a genuinely enormous site — a boundary drawn in degrees and read as metres, or a stray vertex far from the rest of the site.

*Fix:* check the layer's coordinate system first. If the site really is that large, look for a rogue vertex using the vertex editor.

## 7. Is the habitat data acceptable?

Three checks look at the attribute table rather than the shapes. They are deliberately shown ahead of the geometry errors, because they are about policy and data quality rather than drawing.

### Habitats that are out of scope for this service

Habitats in the **High** or **Very High** distinctiveness bands cannot be processed by this service. This is not an error in your file — the habitat may be recorded perfectly correctly. It is a limit on what the service currently does, because those bands carry the strictest trading rules in the statutory metric and the bespoke compensation they require is not yet implemented.

The scope of this is larger than most people expect. It applies to area habitats, hedgerows **and** watercourses. Around half of all area habitat types are out of scope. Four of the thirteen hedgerow types are. And of the five watercourse types, only ditches, canals and culverts are in scope — **an ordinary river or stream is always out of scope**.

*Fix:* there are two honest answers. If the habitat really is High or Very High, this service cannot help with that site yet and you should use the statutory metric spreadsheet instead. If the habitat has been mis-typed — for example choosing a species-rich hedgerow variant the survey does not support — correct the habitat type for the features named in the error and upload again.

This rule also applies to habitats you propose to *create*, so you cannot propose creating a High distinctiveness habitat either.

### Two parcels sharing a reference

Two or more rows in the Habitats layer carrying the same Parcel Ref. Blank references are ignored — that is treated as a separate concern.

The reference is how the service talks to you about a parcel: every other error message identifies features by it, and your later post-intervention file is matched back to the baseline using it. Two parcels sharing a reference means the service cannot tell you which one has a problem, nor reliably pair them up later.

*Fix:* sort the attribute table by Parcel Ref and give each parcel a unique value. Note that matching is exact — `PR-1` and `pr-1`, or a reference with a trailing space, count as different and will not be reported, but they may also fail to pair as you expect later. Keep them consistent.

### Advance and delay years both set on one feature

*Advance years* means the habitat is created **before** the development impact, so you get credit for the head start. *Delay years* means creation starts **after** the impact, so you are penalised for the gap. They are opposite directions on the same timeline, and one feature cannot have both.

The statutory metric says so directly: *"Both advance and delayed creation cannot be used on the same habitat. Select either the advance creation or the delayed creation but not both."*

The reason this is rejected rather than tidied up is worth stating. Left alone, the two values do not merely round oddly — the timing calculation nets them against each other while the difficulty calculation honours only the advance, so a parcel whose timing has not really changed can score several times the units it should.

*Fix:* decide which one applies and set the other to zero. If you were trying to express phased creation — part early, part late — that is not one row with both values; split it into two rows, each with a single value.

This applies to area habitats, hedgerows and watercourses. Urban trees are deliberately excluded, because the service does not read the advance and delay columns on that layer at all, and rejecting a file over a value that is ignored would be unfair.

### When the problem is not your file

Three failures are not about your data at all. They are service-side problems, and the tell is that they never name anything you can see in QGIS — no layer, no parcel reference, no column.

One occurs when the database that measures your habitats briefly fails, after your file has already passed every check. Another is the catch-all for an unexpected fault anywhere in the validation run. A third covers a problem with the record the service builds internally from your file.

*Fix:* retry the upload once. Do not start editing your GeoPackage — nothing in these messages says your data is wrong. If it fails again, contact support with the time of the attempt, because the service logs a reference that support can trace. There is one exception: if the message mentions the filename or file size, that one *is* yours — the name must be under 255 characters, end in `.gpkg`, avoid unusual characters, and the file must be under 100 MB.

## 8. What to do when a file is rejected

**Expect two rounds, not one.** The structural checks in sections 3 and 4 stop the upload before the mapping is ever examined. So a file with both a renamed column and overlapping parcels reports only the column. Fix it, upload again, and only then do you learn about the parcels. This is not new breakage; it is the second pass running for the first time.

**Fixing one thing can reveal several others.** Within the structural pass, some failures hide others by design — a layer with two shape columns reports one error and suppresses everything else about that layer. Four or five upload cycles for a badly-formed file is normal.

**The message you see may not match the fault.** Of the 50 rules in this document, only 13 have a message written specifically for them. Five more show a placeholder headed "PLACEHOLDER (AWAITING UCD)" with the raw technical message beneath it. The remaining 32 fall back to a generic message about layer and column names — so a file with, say, a corrupt hedgerow shape is told to rename its columns. Use the rule index in section 10 to find which rule actually fired.

**One known wrong message.** The message shown for a gap between parcels says *"This parcel is a sliver (a thin strip of land). Draw the parcel again."* There is no such parcel — the fault is a gap *between* parcels, and looking for a thin parcel in your attribute table will not find anything. Follow the guidance in section 6 instead.

**When the message is generic, re-export from the template.** It resolves most structural faults at once and is faster than diagnosing by elimination.

## 9. What this document does not cover

**How units are calculated.** Once a file is accepted, see [rules-engine-explained.md](rules-engine-explained.md).

**Features that score zero.** Habitat and condition combinations the service does not recognise are not upload rules; they surface later as Incomplete features. See section 2.

**The post-intervention GeoPackage.** This document covers the baseline upload only. The out-of-scope habitat rule is known to apply to proposed habitats too, but the post-intervention file has not been traced here.

**Anything the service does not check.** Notably, the Area and Length columns are never compared against the shapes they describe. You can clip your parcels, leave the old areas in the attribute table, and nothing will object.

## 10. Rule index

This table is for maintainers, not for a reader trying to fix a file. It maps every rule in the service's error registry to the section above that explains it, records what the user actually sees on screen, and names the test fixture that exercises it. A rule with no fixture and a generic message is the most important row in the table, not the least: it marks a rule nothing tests and nobody is told about.

| Error code | Explained in | What the user sees | Test fixture |
| --- | --- | --- | --- |
| GPKG_INVALID_FILE | Before anything else — is it a GeoPackage at all? | generic message | none |
| GPKG_NOT_A_GEOPACKAGE | Before anything else — is it a GeoPackage at all? | generic message | none |
| GPKG_MISSING_SYSTEM_TABLE | Before anything else — is it a GeoPackage at all? | generic message | none |
| GPKG_MISSING_LAYER | Does it match the Natural England template? | generic message | none |
| GPKG_UNEXPECTED_FEATURE_LAYER | Does it match the Natural England template? | generic message | none |
| GPKG_BASELINE_CONTENTS_DATA_TYPE | Does it match the Natural England template? | generic message | none |
| GPKG_BASELINE_SRS_ID | Does it match the Natural England template? | generic message | none |
| GPKG_BASELINE_GPKG_SRS_INCONSISTENT | Does it match the Natural England template? | generic message | none |
| GPKG_BASELINE_INVALID_GEOMETRY_COLUMN_NAME | Does it match the Natural England template? | generic message | none |
| GPKG_BASELINE_MULTIPLE_GEOMETRY_COLUMNS | Does it match the Natural England template? | generic message | none |
| GPKG_BASELINE_GEOMETRY_TYPE_NAME | Does it match the Natural England template? | generic message | none |
| GPKG_BASELINE_MISSING_COLUMN | Does it match the Natural England template? | generic message | none |
| GPKG_BASELINE_COLUMN_SQLITE_TYPE | Does it match the Natural England template? | generic message | none |
| GPKG_BASELINE_COLUMN_NOT_NULL | Does it match the Natural England template? | generic message | none |
| GPKG_BASELINE_COLUMN_PRIMARY_KEY | Does it match the Natural England template? | generic message | none |
| GPKG_BASELINE_GEOMETRY_REGISTRATION_MISSING | Does it match the Natural England template? | generic message | none |
| GPKG_HABITATS_NO_GEOMETRY_COLUMN | Does it match the Natural England template? | generic message | none |
| GPKG_RLB_NO_GEOMETRY_COLUMN | Does it match the Natural England template? | generic message | none |
| GPKG_RLB_UNREADABLE_GEOMETRY | Is the mapping usable? | generic message | none |
| GPKG_RLB_NO_POLYGON | Is the mapping usable? | bespoke message | none |
| GPKG_RLB_TOO_MANY_POLYGONS | Is the mapping usable? | bespoke message | none |
| GPKG_HABITATS_UNREADABLE_GEOMETRY | Is the mapping usable? | generic message | none |
| GPKG_HABITATS_WRONG_GEOMETRY_TYPE | Is the mapping usable? | generic message | none |
| GPKG_HEDGEROWS_UNREADABLE_GEOMETRY | Is the mapping usable? | generic message | none |
| GPKG_HEDGEROWS_NO_LINESTRING_GEOMETRY | Is the mapping usable? | generic message | none |
| GPKG_HEDGEROWS_WRONG_GEOMETRY_TYPE | Is the mapping usable? | generic message | none |
| GPKG_RIVERS_UNREADABLE_GEOMETRY | Is the mapping usable? | generic message | none |
| GPKG_RIVERS_NO_LINESTRING_GEOMETRY | Is the mapping usable? | generic message | none |
| GPKG_RIVERS_WRONG_GEOMETRY_TYPE | Is the mapping usable? | generic message | none |
| NO_REDLINE | Is the mapping usable? | bespoke message | none |
| NO_HABITAT_AREAS | Is the mapping usable? | bespoke message | no-habitats |
| REDLINE_INVALID_GEOMETRY | Is the mapping usable? | bespoke message | self-intersecting-redline |
| AREA_PARCELS_INVALID_GEOMETRY | Is the mapping usable? | bespoke message | bowtie-parcel |
| PARCEL_OVERLAPS | Does the mapping hang together? | bespoke message | overlapping-parcels |
| SLIVERS_INSIDE_REDLINE | Does the mapping hang together? | bespoke message | sliver |
| SLIVERS_OUTSIDE_REDLINE | Does the mapping hang together? | bespoke message | none |
| AREA_PARCELS_OUTSIDE_REDLINE | Does the mapping hang together? | bespoke message | parcel-outside-redline |
| HEDGEROWS_OUTSIDE_REDLINE | Does the mapping hang together? | bespoke message | hedgerow-outside |
| WATERCOURSES_OUTSIDE_REDLINE | Does the mapping hang together? | bespoke message | watercourse-outside |
| IGGIS_OUTSIDE_REDLINE | Does the mapping hang together? | placeholder | iggi-outside |
| TREES_OUTSIDE_REDLINE | Does the mapping hang together? | placeholder | tree-outside |
| AREA_SUM_MISMATCH | Does the mapping hang together? | placeholder | area-sum-mismatch |
| REDLINE_OUTSIDE_ENGLAND | Does the mapping hang together? | placeholder | redline-not-in-england |
| REDLINE_AREA_TOO_LARGE | Does the mapping hang together? | placeholder | redline-too-large |
| HABITAT_DISTINCTIVENESS_NOT_IN_SCOPE | Is the habitat data acceptable? | bespoke message | distinctiveness-out-of-scope |
| DUPLICATE_HABITAT_REF | Is the habitat data acceptable? | generic message | duplicate-habitat-ref |
| ADVANCE_AND_DELAY_BOTH_SET | Is the habitat data acceptable? | generic message | advance-delay-both-set |
| SIZING_FAILED | When the problem is not your file | generic message | none |
| INVALID_FILE_METADATA | When the problem is not your file | generic message | none |
| VALIDATION_FAILED | When the problem is not your file | generic message | none |

### Coverage summary

| Measure | Count |
| --- | --- |
| Rules that can reject an upload | 50 |
| With a message written for them | 13 |
| Showing a placeholder message | 5 |
| Falling back to a generic message | 32 |
| Exercised by a test fixture | 16 |

### Known gaps recorded by this run

These were found while tracing and are not user-facing rules. They are recorded so they are not rediscovered each time.

- Four rules appear to be unreachable in practice. The green infrastructure containment check cannot run, because that layer is not in the template and would be rejected as an unexpected layer first. One layer-type check cannot fail, because the only layers examined are already of the required type.
- The `Water course enhancement through meanders` layer is permitted by the template but is never read, so no spatial check is applied to anything in it.
- Advance and delay values on the Urban Trees layer are not merely unvalidated but silently discarded, because the column names on that layer differ from the ones the service reads. A consultant recording a five-year head start for urban trees receives no credit and no warning.
- 34 of the 50 rules have no test fixture. All the structural and column rules are in that group.

## 11. Where this lives in the code

| Repository | Commit | Supplies |
| --- | --- | --- |
| bng-metric-backend | 8da3743 | The rules themselves, and the message each one raises |
| bng-metric-frontend | 27e3154 | What the user is shown for each rule |
| bng-library | c3f6968 | The fixtures that exercise the rules |

Generated 29 July 2026 by the `geopackage-validation-explainer` skill in `bng-metric-harness`.
