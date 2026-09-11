# NSIP-scale test site

A synthetic habitat map at the scale that worries people about the template
decision: a 56 km subsection of a new rail line, 3 184 hectares of land take,
11 554 baseline habitat parcels, and a post-intervention state for every
habitat type. It exists so the conversion between the two templates can be
tested against something the size of a real nationally significant
infrastructure scheme rather than the size of a housing site.

The data is invented. The geography, the habitat mix and the shape of the
intervention are chosen to be plausible for that corridor, and nothing here
describes a real scheme or a real survey.

---

## 1. What is in the folder

| Path | What it is |
| --- | --- |
| `hs2-phase2a-subsection/` | A working copy of the BNG Service template, with the site in it |
| `legacy/` | The same site converted to the legacy Natural England pair |
| `corridor_mesh.py` | The corridor geometry: centre line, width, and the shared mesh |
| `corridor_parcels.py` | Grouping mesh cells into parcels and tracing their outlines |
| `corridor_scenario.py` | Habitats, conditions and the intervention |
| `corridor_linear.py` | Hedgerows, watercourses and trees |
| `corridor_writers.py` | Writing all of it into the template |
| `gpkg_write.py` | GeoPackage geometry encoding |
| `generate.py` | Run this |
| `VERIFICATION.md` | The step-by-step runbook: QGIS, every plugin feature, the service |
| `verify/` | Validation, summary and preview scripts |
| `preview.png` | A 1.8 km window, before and after, for a sanity check by eye |

Nothing here needs QGIS, GDAL or a network connection. A GeoPackage is a
SQLite database, so the standard library is enough.

---

## 2. The site

A subsection of a new rail line between Handsacre in Staffordshire and Crewe,
following British National Grid waypoints along that corridor. The land take
runs 55.8 km and varies between 330 m and 1 040 m wide, widening at eight
construction compounds, for a total of 3 184.04 hectares. That is under the
100 square kilometre limit the service applies to a red line boundary, and it
is entirely inland.

| | Baseline | Post-intervention |
| --- | --- | --- |
| Area habitats | 11 554 | 13 682 |
| Hedgerows | 1 275 | 1 469 |
| Watercourses | 256 | 243 |
| Individual trees | 3 600 | 2 767 |
| Red line boundary | 1 | |

546 629 vertices in total, 32 MB in the staged template and 31 MB across the
converted legacy pair.

266 baseline parcels, 72.3 hectares, are recorded as ancient woodland: ordinary
broadleaved or coniferous woodland carrying the irreplaceable habitat flag, in
blocks rather than scattered. That combination is deliberate. Every habitat on
the always-irreplaceable rule list is High or V.High distinctiveness and so
outside what the service accepts, but ancient woodland is recorded as the
flag on an in-scope habitat, which makes it the one irreplaceable case a
valid file can carry.

The baseline carries 33 area habitat types, 9 hedgerow types and 3 watercourse
types, drifting between pasture, arable, woodland and settlement edge along the
route rather than varying at random. The intervention is a sealed core that
weaves within the land take, earthworks either side of it, a mitigation margin
beyond that, and untouched land at the edges: 1 663 hectares created, 331
hectares enhanced, 1 190 hectares retained.

### What is deliberately absent

**Only Medium, Low and V.Low distinctiveness habitats appear.** That is the
scope the service accepts today, and the scope of the controlled beta. A real
scheme of this length would cross higher-distinctiveness habitat, and a version
of this site carrying some would be worth building once the service accepts it.

**No vertical area habitats.** They have no equivalent in the legacy template,
so they cannot take part in a conversion test.

---

## 3. How the geometry is built

Everything sits on one structured mesh in corridor coordinates: 1 396 cross
sections at 40 m spacing, 18 cells across. Every parcel is a union of mesh
cells, and neighbouring cells share identical vertex chains, so the parcels
tile the site with no overlap and no gap. The red line boundary is the outer
edge of the same mesh.

That is what makes the numbers come out exactly. Every interior boundary is
walked twice, in opposite directions, over the same points, so those
contributions cancel and the summed parcel area equals the red line area by
construction rather than by tolerance. Nothing is unioned, buffered or snapped
anywhere in the build.

Realism comes from three places, none of which disturbs that property: a
splined centre line, a width that varies along the route, and jitter applied to
each mesh node and to two interior points on every mesh edge. Parcel outlines
end up wobbly rather than rectangular, at an average of 19.5 vertices each.

Hedgerows and ditches are drawn along the same mesh edges, which is both
realistic (a hedge is a field boundary) and convenient: the line sits exactly
on a parcel edge and therefore inside the red line. Re-meandered channels and
tree points are placed in corridor coordinates instead, so a feature can move
off its original line with no risk of leaving the site.

### The post-intervention side

Three rules shape it, and all three come from how the staged template
reconciles a child against its parent.

- **Area habitats must balance exactly.** Every child is a union of its
  parent's own mesh cells, and the children of a parcel tile it completely.
- **Hedgerows and trees may fall short of their parent but never exceed it.**
  A hedge the works remove is expressed by its surviving stretches alone, and
  the loss is left as the residual, which is the Statutory Metric's own
  bookkeeping.
- **Watercourses need only be present.** A re-meandered channel leaves its old
  line and gets longer, so child lengths say nothing about what was lost.

---

## 4. Running it

```sh
python3 generate.py
python3 ../new_to_old.py \
    "hs2-phase2a-subsection/Layers/BNG Service Layers.gpkg" -o legacy
```

Generation takes about 7 seconds and conversion about 1 second on a laptop.
Generation is deterministic to the byte: every random choice is a hash of the
feature's own position, and the run starts from a fresh copy of the pristine
template so the file carries no page history. Conversion is deterministic in
its content but not in its bytes, because it writes into whatever file is
already at the output path and SQLite lays the pages out differently.

### Verifying

The staged file, against the service's staged validation:

```sh
STAGED_BACKEND_DIR=/path/to/backend node verify/validate-staged.mjs \
    "hs2-phase2a-subsection/Layers/BNG Service Layers.gpkg"
```

That path needs a backend checkout carrying `validation/geopackage/lineage/`,
which at the time of writing lives on the staged-lineage spike branch rather
than on main. A worktree is the least disruptive way to get one:

```sh
git -C ../../backend worktree add /tmp/staged spike/baseline-pi-lineage
ln -s "$PWD/../../backend/node_modules" /tmp/staged/node_modules
```

It also needs a PostGIS database, because the lineage overlay runs there. The
backend's own compose stack provides one.

The converted pair, against the service's baseline validation:

```sh
node verify/validate-legacy.mjs "legacy/BNG Service Layers - Baseline.gpkg" baseline
node verify/validate-legacy.mjs \
    "legacy/BNG Service Layers - Post-Intervention.gpkg" postIntervention
```

And a description of what the file holds:

```sh
python3 verify/summarise.py
```

`verify/preview.py` draws a window of the site, before and after, into a PNG.
It is the only script here that needs anything beyond the standard library
(matplotlib, which the QGIS Python already ships).

---

## 5. What has been measured

Run on a laptop, against the backend on branch
`BMD-1001-post-intervention-only-derived-baseline` for the legacy pair and on
`spike/baseline-pi-lineage` for the staged file.

| Check | Result |
| --- | --- |
| Staged file, staged validation | **Valid.** 6.5 s. One removal warning, which is the intended loss of hedgerow and tree features under the works |
| Converted baseline, service validation | **Valid.** 6.5 s |
| Converted post-intervention, service validation | **Valid.** 7.5 s |
| Generation | 7 s, byte-identical between runs |
| Conversion to the legacy pair | 1 s, identical row for row between runs |

**The site crosses the service's own validation timeout under load.** One
validation is allowed 10 seconds on a worker thread, after which the worker is
terminated and the upload fails with a validation error. On an idle laptop the
converted post-intervention file takes 7.3 to 8.0 seconds. With other work
running on the same machine it takes 7.8 to 9.3 seconds, and one run during
this exercise exceeded the limit and was killed. The setting's own note records
the slowest validation seen before this as under two seconds, for a 5 000
parcel file.

So the finding is not that a site this size is slow. It is that a site this
size fails intermittently, which is worse, because the same file uploaded twice
gives two different answers. File size is not the constraint: the 100 MB upload
limit is three times the largest file here.

**The reassembly is exact.** The service measures the summed area of the 11 554
baseline parcels as 31 840 368.775235 square metres, and the summed area of the
13 682 post-intervention parcels as 31 840 368.775235 square metres: the same
number to six decimal places, across 3 184 hectares. The service allows half a
square metre.

**The import tool would merge away two thirds of the irreplaceable habitat.**
Converting to the three CSVs the import tool reads produces 13 682 habitat
rows. The tool consolidates rows agreeing on every attribute, and the CSVs
carry no irreplaceable habitat column, so those 13 682 rows collapse to 4 145.
Seventy seven of the merged groups mix flagged and unflagged parcels, absorbing
215 of the 314 irreplaceable rows into rows that present as ordinary habitat.
The largest such group is 92 parcels. The converter warns that it is dropping
the flag; nothing stops it.

That covers claim 1 (nothing is lost), claim 4 (it is repeatable) and claim 5
(it finishes) from the briefing note. **Claims 2 and 3 are not tested here**,
and they are the two that matter most: no value-by-value comparison has been
run, and neither file has been through the biodiversity unit calculation. Those
are the next things to build against this site.
