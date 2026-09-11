# bng-template-convert

Convert habitat mapping between the **legacy Natural England template** and the
**BNG Service template**, in both directions.

```
new template   1 file,  Baseline + Post-Intervention tables per habitat type
                 |  new_to_old.py            ^  old_to_new.py
                 v                           |
old template   2 files, one table per habitat type, uploaded separately
```

| Direction | Use it when |
|---|---|
| **to legacy** (`new_to_old.py`) | You mapped in the new template but must submit through the legacy route. |
| **from legacy** (`old_to_new.py`) | You have legacy files and want to work in the new template. |

Both run either **inside QGIS** as a plugin — file pickers, no typing, no
command line — or as plain scripts. Most people want the plugin: see
[Using it inside QGIS](#using-it-inside-qgis-recommended).

**No dependencies.** A GeoPackage is a SQLite database and geometry is copied
byte-for-byte, so both scripts need only Python 3.8+ — no GDAL, no QGIS, no
network. Neither ever modifies its input files.

```
gpkg_common.py           shared GeoPackage plumbing + the canonical geometry checksum
new_to_old.py            new template  ->  legacy pair
old_to_new.py            legacy pair   ->  new template
to_metric.py             new template  ->  a filled Statutory Metric workbook
bng_template_convert/    the QGIS plugin (wraps the two above)
build_plugin.py          packages the plugin into dist/bng_template_convert.zip
templates/               reference copies of both templates (see templates/README.md)
tools/                   editing the Python actions stored inside a .qgz
reference/               the metric, the GIS import tool and the NE guidance
scale-test-nsip/         a generated NSIP-scale site, and how to verify against it
```

The templates themselves are in [`templates/`](templates/), so the code and the
formats it targets stay together. Copy a folder elsewhere before working in it.

---

## Before you start, either way

**Save your edits.** Edits that are saved are safe to convert even with QGIS
still open: they are committed to the GeoPackage's write-ahead log, which the
converters read. Edits still sitting unsaved in the map exist only in QGIS's
memory and would be silently missed — the plugin checks for those and stops;
from the command line, save (or close QGIS) first.

Both scripts take `--dry-run`, which reports exactly what would happen and
writes nothing. Use it first, and read the warnings before you upload anything.

---

# Using it inside QGIS (recommended)

Most people should never see a command line. The same two converters ship as a
QGIS plugin, where they appear as ordinary tools with file pickers.

## Install (once)

1. Build the installer — or get `bng_template_convert.zip` from whoever
   distributes it:
   ```sh
   python3 build_plugin.py
   ```
   which writes `dist/bng_template_convert.zip`.
2. In QGIS: **Plugins → Manage and Install Plugins… → Install from ZIP**, choose
   that file, click **Install Plugin**.

That is the whole install. Nothing else to set up — the plugin uses only what
QGIS already ships with.

Passing a ZIP around is fine for a pilot, but it means every update has to be
re-sent and re-installed by hand. To make the plugin appear in the normal
plugins list and update itself, publish a plugin repository — **not set up
yet**; the steps are in
[Later: one-click install and updates](#later-one-click-install-and-updates-plugin-repository).

## Use

The two tools appear in **two** places, whichever you find first:

- **Plugins → BNG Template Convert →** *Convert to legacy template…* /
  *Convert from legacy template…*
- The **Processing Toolbox** (`Ctrl+Alt+T`), under **BNG Template Convert**.

Each opens a normal dialog: choose the file(s), choose where the result goes,
press **Run**. The log pane then shows what was written, what was changed, and —
in orange — anything that needs checking.

### Convert to legacy template

| Field | What to put in it |
|---|---|
| BNG Service GeoPackage | Your site's `Layers/BNG Service Layers.gpkg` |
| Folder to put the two legacy files in | Any empty folder |
| What to produce | Both, or one of the two (see below) |
| Record lineage in comments | Leave ticked |

**What to produce** picks the destination, because the two legacy routes want
different files:

| Choice | You get | For |
|---|---|---|
| Legacy GeoPackages | `Net Gain Habitat Mapping Layers - Baseline.gpkg` and `… - Post-intervention.gpkg` | Uploading to the older Biodiversity Metric service, baseline first, or opening in the legacy QGIS template |
| GIS import tool CSVs | `GIS import tool CSVs/` holding `Habitats.csv`, `Hedgerows.csv`, `Rivers.csv` | Feeding the Excel **GIS import tool**, which fills in the Statutory Biodiversity Metric or the SSM |
| Both | All of the above | |

The CSVs are the same rows as the post-intervention GeoPackage, in the same
column order, written the way a `Save As CSV` of the legacy Master layer would
be. Load each one into its matching tab of the import tool with **Import GIS CSV
Data**, then choose **On Site** or **Off Site** there before exporting to the
metric.

**Individual trees are not in the CSVs.** The import tool cannot read tree points
at all (User Guide 2.4.1); they have to be typed into the metric by hand. The
tool says so, with the count, whenever a site has any. Trees are still written to
the GeoPackages.

### Export to the Statutory Metric (Excel)

Fills a copy of the Statutory Biodiversity Metric workbook straight from your
habitats, with no GIS import tool in between.

| Field | What to put in it |
|---|---|
| BNG Service GeoPackage | Your site's `Layers/BNG Service Layers.gpkg` |
| Blank Statutory Metric workbook | A blank copy of the metric. There is one in `reference/` |
| Filled metric workbook to write | Any new `.xlsm` path |
| Merge rows with matching values | Leave off unless you run out of rows |

Your metric file is never modified; a filled copy is written. If the workbook
already holds habitats the tool stops rather than overwrite them. Open the
result in Excel and let it recalculate. Macros and sheet protection carry over
untouched.

**What it fills:** the on-site tabs for area habitats, hedgerows and
watercourses. Each post-intervention parcel lands on the baseline tab carrying
its parent's baseline values and its own size, with that size placed in
*retained* or *enhanced*; whatever is left of a baseline feature is lost. The
creation and enhancement tabs are filled to match.

**What it does not fill, and you must enter by hand:** individual trees, whose
size the metric derives from a band lookup; the off-site tabs (D, E and F),
which carry extra allocation columns and a different layout; and irreplaceable
habitats.

**How many rows will fit.** Each sheet of the metric holds **248 rows**, and
the export says so plainly when a site needs more, naming the sheet and the
number it needed. Merging rows buys a large factor, but a nationally
significant project exceeds 248 even merged: the NSIP-scale test site in
`scale-test-nsip/` needs 1 619 baseline rows after merging, against a capacity
of 248. Such a site has to be split into geographic sections and entered as
several metrics, which is what the published guidance says to do.
`scale-test-nsip/generate.py --fraction` builds one such section.

**Merging rows** does what the import tool's *consolidate* button does: rows
agreeing on everything but size become one row with the sizes added. Totals do
not change, because units scale with size. Use it if a site has more than the
248 rows a metric tab holds. Enhanced rows are never merged, because the
enhancement tab is positional against the baseline tab and merging two parcels
heading for different habitats would apply the targets to the wrong parcels.

### Convert from legacy template

| Field | What to put in it |
|---|---|
| Legacy baseline GeoPackage | The baseline file |
| Legacy post-intervention GeoPackage | The post-intervention file (or leave blank) |
| Existing template GeoPackage to fill | The `Layers/BNG Service Layers.gpkg` inside **your copy** of the BNG Service Template folder |
| …or write a new GeoPackage here | Leave blank if you filled in the row above |

The normal route is to copy the whole **BNG Service Template** folder for your
site first, point the tool at the copy's `Layers/BNG Service Layers.gpkg`, and
then open that copy's project — your habitats are there with the template's
styling, drop-downs and actions.

## You do not need to close QGIS

You only need to **save your edits**. Committed edits live in the GeoPackage's
write-ahead log, and the converters read it, so the tool sees work you saved
seconds ago. Anything still unsaved exists only in QGIS's memory, so the plugin
checks for it and stops with a list of the layers to save. Verified: a tree
added and saved with a `-wal` file present was carried through correctly.

The plugin also refuses to write into a GeoPackage that is open in the current
project, which would risk corrupting it — run the conversion from a different
(or empty) project and open the template project afterwards.

## Differences from the command line

- *Record lineage in comments* defaults to **on** in the plugin and **off** on
  the command line. The dialog is the guided route, and someone using it is the
  least likely to be able to reconstruct lineage later if it is lost.
- Everything else behaves identically — the plugin calls the same functions.


## Later: one-click install and updates (plugin repository)

**Status: not set up.** Today the plugin is distributed as a ZIP. Publishing a
QGIS *plugin repository* — a single `plugins.xml` file plus the ZIP, both served
over HTTPS — replaces that with: users add one URL once, then the plugin appears
in the normal **Manage and Install Plugins** list, and every later release shows
up as an ordinary **Upgrade** prompt. Nothing about the plugin itself has to
change.

### 1. Pick somewhere to host two files

Any plain HTTPS web location works, as long as both URLs are **direct file
downloads that need no sign-in** — QGIS fetches them itself and cannot complete
a login page. GitHub Releases plus GitHub Pages, an S3 bucket, or any internal
web server are all fine. A SharePoint or Google Drive *share link* is usually
**not**, because it returns an HTML page rather than the file.

### 2. Release the plugin

1. Bump `version=` in `bng_template_convert/metadata.txt`. QGIS decides whether
   to offer an upgrade by comparing this with the installed version, so it must
   increase on every release.
2. `python3 build_plugin.py`
3. Upload `dist/bng_template_convert.zip` to the hosting location.

### 3. Write `plugins.xml`

Keep the fields in step with `metadata.txt`. Only `version`,
`qgis_minimum_version`, `file_name` and `download_url` really matter; the rest
is what users see in the plugin list.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plugins>
  <pyqgis_plugin name="BNG Template Convert" version="1.0.0">
    <description>Convert habitat mapping between the legacy Natural England template and the BNG Service template.</description>
    <about>Moves a habitat map between the two BNG QGIS templates without anyone needing a command line.</about>
    <version>1.0.0</version>
    <qgis_minimum_version>3.22</qgis_minimum_version>
    <author_name>Defra BNG Metric Service</author_name>
    <file_name>bng_template_convert.zip</file_name>
    <download_url>https://example.internal/qgis/bng_template_convert.zip</download_url>
    <experimental>False</experimental>
    <deprecated>False</deprecated>
    <tags>bng,biodiversity,geopackage,defra</tags>
  </pyqgis_plugin>
</plugins>
```

Upload it alongside the ZIP, e.g. `https://example.internal/qgis/plugins.xml`.

### 4. Tell users the URL, once

In QGIS: **Plugins → Manage and Install Plugins… → Settings → Add…**, give it a
name (e.g. *Defra BNG*) and paste the `plugins.xml` URL. The plugin then appears
under **All** / **Not installed**, installs with one click, and upgrades appear
automatically from then on.

This is worth putting in the user guide once, next to the template download —
it is the only step users ever need to do by hand.

### Gotchas

- **Bump the version, always.** Same version number, no upgrade offered, however
  many times the ZIP is replaced.
- **QGIS caches the listing.** After publishing, *Settings → Reload repository*
  (or restarting QGIS) is sometimes needed before a new version shows.
- **`qgis_minimum_version` hides the plugin** from anyone on an older QGIS
  rather than warning them — keep it at the oldest version you actually support.
- **Check both URLs in a private browser window.** If either prompts for a
  sign-in, QGIS will fail with an unhelpful download error.
- **`<file_name>` must match the actual ZIP name**, and the ZIP must contain the
  `bng_template_convert/` folder at its root — which `build_plugin.py` ensures.
- The official plugins.qgis.org repository is an option instead of self-hosting,
  but it means public listing and its approval process; a private repository
  avoids both.


---

# Using it from the command line

## new → old

### 1. Preview

```sh
python3 new_to_old.py "path/to/BNG Service Layers.gpkg" --dry-run
```

Optionally run the template's **"2. Tidy PI refs after splitting"** action first,
so split parcels have distinct references. If you skip it, the converter assigns
the suffixes itself and reports each rename — the legacy service rejects a
repeated Parcel Ref on the habitats layer, so they cannot stay as they are.

### 2. Convert

```sh
python3 new_to_old.py "path/to/BNG Service Layers.gpkg" -o converted/
```

Produces `Net Gain Habitat Mapping Layers - Baseline.gpkg` and
`Net Gain Habitat Mapping Layers - Post-intervention.gpkg`.

### Opening the result in the legacy QGIS template

The two files are named after the legacy template's own layer file on
purpose, because they are drop-in replacements for it.

Its project looks for its data at `./Layers/Net Gain Habitat Mapping
Layers.gpkg`, by that exact name, so each stage needs a template folder of its
own:

1. Copy the whole `templates/legacy-ne/` folder twice, once for the baseline
   and once for the post-intervention state.
2. Into each copy's `Layers/` folder, put the matching file and rename it to
   `Net Gain Habitat Mapping Layers.gpkg`, replacing the empty one.
3. Open `Net Gain Habitat Mapping.qgz` in that folder.

Proven at scale: a converted site of 11 554 baseline parcels opens in the
legacy template and draws correctly.

Add **`--format csv`** for the Excel GIS import tool's three CSVs instead, or
**`--format both`** for all five files. The CSV names carry no site prefix on
purpose: the import tool works out which module a file holds by looking for
`hab`, `hed` or `riv` in its name, so a site called "Riverside" would otherwise
make the habitats file ambiguous.

Add **`--carry-lineage`** to record each feature's parent reference in the legacy
`Comment` column. The legacy service ignores it, but `old_to_new.py` reads it
back — which is the difference between a round trip that restores the lineage
exactly and one that has to re-guess it. On the test site it took lineage
recovery from **3 of 9** features to **9 of 9**.

### 3. Check, then upload

Open the legacy template project and add the converted layers
(`Layer > Add Layer > Add Vector Layer`). Then upload the baseline file first,
the post-intervention file second.

### What it does

| | |
|---|---|
| **Splits one file into two** | Baseline tables become the baseline file; Post-Intervention tables become the PI file. |
| **Renames layers** | `Watercourses` → `Rivers`, `Trees` → `Urban Trees`, and the stage suffixes are dropped. |
| **Fans out site details** | The new template stores them once on the Red Line Boundary; legacy repeats them on every row. |
| **Maps references by type** | Area habitats keep their **own** ref (legacy rejects duplicates there). Hedgerows, watercourses and trees take their **parent's** ref, because legacy resolves an `Enhanced` feature back to its baseline by matching that ref. |
| **Recreates "Lost" rows** | The new template records removal by leaving a feature out; legacy needs an explicit row. Any baseline length or tree count not carried forward becomes a `Lost` row. Watercourses follow the presence rule: a stretch with no successor is wholly lost. |
| **Promotes polygons** | The legacy habitats layer is registered `MULTIPOLYGON`, so polygons are wrapped as single-part multipolygons. Coordinates unchanged. |
| **Computes the red line area** | Legacy has an `Area` column the new template does not carry. |
| **Rounds sizes** | Legacy `Area`, `Length` and `Count` are integer columns. The service measures geometry itself, so this does not affect the calculation. |
| **Writes the import tool's CSVs** | On request, the same post-intervention rows are also written as `Habitats.csv`, `Hedgerows.csv` and `Rivers.csv` for the Excel GIS import tool. Trees are excluded because the tool cannot read them. |
| **Converts area units** | The new template records `Area` in **hectares**; legacy `Area` is whole **square metres**. Both directions convert (`hectares_to_sq_metres` / `sq_metres_to_hectares` in `gpkg_common.py`). `Length` is metres on both sides and is passed through. |

### What is lost

- **Vertical area habitats cannot be carried over at all.** The legacy template
  has no layer for them, so their units are simply missing from the legacy
  calculation. The converter warns loudly.
- **Irreplaceable habitat flags are dropped** — no legacy column exists.
- **Lineage keys are dropped** (`feature_uuid`, `parent_uuid`,
  `parent_checksum`) unless you pass `--carry-lineage`.
- **Split features are flagged.** Where one baseline hedgerow, watercourse or
  tree became several post-intervention features, the converted rows repeat the
  parent's reference, because legacy assumes one row per reference. The legacy
  calculation may differ. Every case is listed; review them.
- **Synthesised `Lost` rows reuse the parent's geometry.** The `Length` or
  `Count` is the true amount removed, but *which stretch* was removed is not
  recorded anywhere in the new template.

---

## old → new

This is the harder direction, because the legacy format never recorded which
baseline feature a post-intervention feature came from. The script stamps only
what it can prove and leaves the rest for the service to work out, rather than
guessing quietly.

### 1. Preview

```sh
python3 old_to_new.py --baseline "Baseline.gpkg" \
                      --post-intervention "Post-Intervention.gpkg" --dry-run
```

`--post-intervention` is optional — omit it to convert a baseline on its own.

### 2. Convert

Either produce a standalone file:

```sh
python3 old_to_new.py --baseline "Baseline.gpkg" \
                      --post-intervention "Post-Intervention.gpkg" -o converted/
```

…or write straight into a copy of the template, which is usually what you want:

```sh
cp -R "BNG Service Template" "My Site"
python3 old_to_new.py --baseline "Baseline.gpkg" \
                      --post-intervention "Post-Intervention.gpkg" \
                      --into "My Site/Layers/BNG Service Layers.gpkg"
```

Then open `My Site/BNG Service Habitat Mapping.qgz` and your data is there with
the template's styling, dropdowns and actions. `--into` refuses a target that
already holds features unless you pass `--force`, and it keeps the template's
spatial indexes correct as it writes.

### 3. Finish the job in QGIS

The converter tells you how many parent links it could prove. Before uploading:

1. **Check the parent links.** Any feature the script could not match by
   reference is left without a recorded parent; the service infers one from
   geometry overlap and warns you. Those warnings are the ones to read.
2. **Fill in Irreplaceable Habitat** — the legacy template has no such column,
   so it arrives blank on every habitat feature.
3. **Add any vertical area habitats** (green walls, intertidal hard
   structures). Legacy could not record them, so those layers arrive empty.
4. **Re-check any row converted from the legacy meanders layer** (see below).

### How lineage is rebuilt

In order of confidence:

1. **Breadcrumbs** — if the legacy files came from `new_to_old.py
   --carry-lineage`, the parent reference is read straight back out of the
   `Comment` column. Exact restoration.
2. **Matching references** — a post-intervention row whose reference matches a
   baseline row is linked to it, and gets a `parent_uuid` and a
   `parent_checksum` of that baseline geometry. This is the legacy convention
   and is right most of the time.
3. **Everything else is left unstamped, on purpose.** The service resolves those
   by *area-weighted* geometry intersection in PostGIS and raises a "parent
   inferred" warning. Guessing here in Python would mean a cruder test (a bare
   "intersects" wrongly attributes nearly every parcel cut from a neighbour) and
   — worse — a silent one.

### Other conversions it makes

| Legacy | New template | Why |
|---|---|---|
| Area habitat `Lost` | `Created` | The row stays: area habitats must account for every square metre inside the red line, and the Statutory Metric treats built-over ground as creating the new surface. |
| Hedgerow / watercourse / tree `Lost` | row dropped | The new template records removal by absence; the service compares baseline against what carried forward. |
| Repeated post-intervention refs | distinct `PI Ref`, shared `Parent Ref` | Legacy's only way of saying "part became X, part became Y". |
| Site details on every row | one Red Line Boundary record | First non-empty value for each field wins. |
| `Water course enhancement through meanders` | Watercourses PI, `Enhancement Type = Meanders`, Retained as `Enhanced` | The new template folds re-meandering into the watercourse. **This is an interpretation** — the script warns, and the rows should be checked. |
| Multi-part habitat polygons | kept, with a warning | The new template expects one polygon per feature; split them with *Edit > Multipart to singleparts*. |

---

## Verification performed

Tested against a real staged file from the new template (red line, 2 baseline
and 6 post-intervention area habitats, hedgerow, watercourse, trees, and a
vertical area habitat).

**new → old**

- Both outputs pass the service's own legacy validation gate (`validateGpkg`) —
  schema, column types, geometry registration, SRS.
- Every vertex identical between input and output (max delta `0 m`).
- Area conserved exactly: 8.9470 ha baseline, 8.9470 ha post-intervention.
- Post-intervention habitat references unique after de-duplication.
- Every layer opens in QGIS 3.42 at EPSG:27700 with the expected geometry type.

**old → new**

- Output schema is **identical to the shipped template's own GeoPackage** —
  all 11 feature tables, every column name and type, every geometry
  registration.
- Full round trip (`new_to_old --carry-lineage` → `old_to_new`) restores
  geometry with max delta `0 m` and **9 of 9** parent links, with every
  `parent_uuid` resolving and every `parent_checksum` verifying against the
  baseline geometry it names. Without breadcrumbs the same round trip recovers
  3 of 9 and honestly reports the rest as inferred.
- `--into` a fresh copy of the real template GeoPackage populates the template's
  own rtree spatial indexes and feature counts, and refuses a non-empty target
  without `--force`.
- Both output modes open in QGIS 3.42 at EPSG:27700.

**QGIS plugin**

- Built as a `.zip`, installed into a clean QGIS profile exactly as *Install
  from ZIP* does, and both algorithms registered and ran through the Processing
  framework end to end.
- The unsaved-edits guard blocks a conversion when a layer has an open edit
  buffer, and names the layers to save.
- After saving, a feature added seconds earlier — with a `-wal` file present —
  was carried through correctly (2 trees became 3). This is what makes it safe
  to run without closing QGIS.
- Writing into a GeoPackage that is open in the current project is refused.
- Filling a real copy of the template GeoPackage populated its own rtree spatial
  indexes.
- Tested on QGIS 3.42.1.

**Shared**

- The canonical geometry checksum in `gpkg_common.py` reproduces all eight
  cross-language test vectors used by the backend and the QGIS template,
  including the collinear-vertex and duplicate-vertex cases and the real-world
  `6a09c6a283a60978` stamp.

Not covered: the staged-side validator on the backend's
`spike/baseline-pi-lineage` branch was not run, because that repo has since
moved to other work. Staged output is verified by schema equality with the
shipped template plus stamp verification, not by executing that validator.

## Options

```
python3 new_to_old.py INPUT.gpkg [-o OUT_DIR] [--dry-run] [--carry-lineage]
                      [--format {gpkg,csv,both}]

  -o, --out-dir     where to write the output (default: current directory)
  --dry-run         report what would be produced; write nothing
  --carry-lineage   record parent references in the legacy Comment column
  --format          gpkg: the legacy pair (default)
                    csv:  the three GIS import tool CSVs
                    both: all five files

python3 old_to_new.py --baseline BASE.gpkg [--post-intervention PI.gpkg]
                      [-o OUT_DIR] [--into TARGET.gpkg] [--force] [--dry-run]

  --baseline            legacy baseline .gpkg (required)
  --post-intervention   legacy post-intervention .gpkg (optional)
  -o, --out-dir         where to write the staged file (default: current dir)
  --into                write into an existing template GeoPackage instead
  --force               allow --into when the target already holds features
  --dry-run             report what would be produced; write nothing

python3 to_metric.py INPUT.gpkg --metric METRIC.xlsm -o OUT.xlsm
                     [--consolidate] [--allow-occupied]
                     # no CSVs and no import tool: this writes the workbook

  --metric              a blank copy of the Statutory Metric workbook
  -o, --out             where to write the filled copy
  --consolidate         merge rows agreeing on everything but size
  --allow-occupied      write even if the metric already holds habitats
```

Exit code is `0` on success, `1` on error.

## Notes for maintainers

- The legacy schema in `new_to_old.py` mirrors the service's own reference
  (`gpkg-template.schema.json`); the new-template schema in `old_to_new.py`
  mirrors `Layers/BNG Service Layers.gpkg`. Both are validated on upload —
  column names, declared SQLite types and the registered geometry type. Geometry
  *column names* are not checked.
- One known quirk: the shipped NE template spells the meanders layer's
  `Habitat created in advance/years` column with a **trailing space**, which the
  service's reference schema does not. `new_to_old.py` follows the reference;
  `old_to_new.py` reads either spelling.
- **Both spellings of the renamed staged tables are accepted.** The QGIS
  template is renaming `Habitats *` to `Area Habitats *` and `Trees *` to
  `Individual Trees *`. `new_to_old.py` resolves each habitat type against the
  tables the input actually has (`STAGED_TABLES`, newest name first) and warns
  by name when a type has neither, so a renamed file can never convert to a
  silently empty output. `old_to_new.py` still *writes* the old names, because
  that is what the shipped template carries, but `--into` resolves each layer
  to whichever spelling the target template has (`STAGED_TABLE_ALIASES`), so
  filling a renamed template works too. All matching is by exact name —
  `Habitats Baseline` is a substring of `Vertical Area Habitats Baseline`, and
  nothing here may match on substrings.
- The checksum in `gpkg_common.py` is one third of a cross-language contract
  with the backend's `geometry-checksum.js` and the Python embedded in the QGIS
  template's copy actions. If you change it, change all three, and re-run the
  shared vectors.
- Removal rules mirror the service's reconciliation policy — shortfall for
  hedgerows and trees, presence for watercourses, and nothing for area habitats,
  whose totals must balance.
