# bng-template-convert

The BNG Service QGIS habitat mapping template, the QGIS plugin that converts a
site out of it, and a generated example site at the scale of a Nationally
Significant Infrastructure Project.

Pure Python, standard library only. No GDAL, no QGIS imports in the conversion
code, no network. The plugin needs QGIS; nothing else here does.

---

## What is where

| Folder | What it holds |
| --- | --- |
| `templates/bng-service/` | **The template.** An empty QGIS project, its reference lists, and `HOW TO USE THIS TEMPLATE.md`, the surveyor's guide |
| `templates/legacy-ne/` | Natural England's template as it ships, for converting into and out of |
| `templates/legacy-ne-vertical-area/` | The fork of it that carries vertical area habitats |
| `plugin/` | **The plugin.** Source, build script, built zip, and `plugin/README.md`, which is the installation and usage guide |
| `reference/` | The Statutory Metric workbook, the Excel GIS import tool, and the published user guide. Every reference list in the template is checked against these |
| `scale-test-nsip/` | The generated example site, plus `VERIFICATION.md`, the record of what was measured against it |
| `development/` | Everything needed to maintain the above and nothing needed to use it: the example-site generator and the template maintenance tools |

**Three things are sent out, and each has its own document.** The template goes
with `HOW TO USE THIS TEMPLATE.md`, the plugin goes with `plugin/README.md`,
and the example site goes with the same template guide inside it. This file is
for whoever maintains them.

---

## The plugin

### Building it

```
cd plugin
python3 build_plugin.py          ->  plugin/dist/bng_template_convert.zip
```

The package folder is the only source; there are no copies to keep in step.
`plugin/README.md` is zipped in alongside the code, so a plugin passed on by
itself still carries its own instructions.

### Installing it

In QGIS: **Plugins** → **Manage and Install Plugins...** → **Install from ZIP**
→ select `bng_template_convert.zip` → **Install Plugin**. Accept the untrusted
source warning. The tools then appear under **Plugins** → **BNG Template
Convert** and in the **Processing Toolbox**.

**`plugin/README.md` is the full guide**, including the thing users get wrong
most often: exporting to the Statutory Metric and converting into the template
both need clean, empty copies of the file being written into.

### Running the conversions without QGIS

The four modules in `plugin/bng_template_convert/` run standalone, which is how
they are tested:

```
cd plugin/bng_template_convert

python3 new_to_old.py  INPUT.gpkg -o OUT_DIR
        [--format gpkg|csv|both] [--consolidate] [--carry-lineage] [--dry-run]

python3 old_to_new.py  --baseline BASE.gpkg [--post-intervention PI.gpkg]
        -o OUT_DIR [--into TEMPLATE.gpkg] [--dry-run]

python3 to_metric.py   INPUT.gpkg --metric METRIC.xlsm|.xlsx -o OUT
        [--consolidate]
```

---

## What conversion does not carry

Going out to the legacy template loses things the legacy format has no room
for. The converter warns about every one of them:

- **Vertical area habitats cannot be carried at all.** The legacy template has
  no layer for them, so their units are missing from a legacy calculation.
- **Irreplaceable habitat flags are dropped.** No legacy column exists. They
  are listed separately in `Irreplaceable habitats.csv` instead.
- **Lineage keys are dropped** unless lineage is recorded in comments, which is
  the default.
- **Split features are flagged.** Where one baseline hedgerow, watercourse or
  tree became several post-intervention features, the converted rows repeat the
  parent's reference, because legacy assumes one row per reference. The legacy
  calculation may differ.
- **Loss rows reuse the parent's shape.** The legacy format cannot record a
  removal by absence, so the conversion writes an explicit loss row copied from
  the baseline feature it describes. The length or count removed is exact;
  which stretch was removed is not recorded in the new template at all.

Coming back the other way, the loss rows are dropped again, because the new
template records a removal by leaving the feature out.

**Numbered list values are a convention, not a fault.** The template stores
several drop-down values with the Metric's own list number in front, as
`4. Fairly Poor` or `2. Retained`. The legacy GeoPackages keep that numbering,
because the legacy template stores it too. The Statutory Metric workbook and
the Excel import tool hold only the plain words, so the conversion strips the
number on the way into those. Hedgerows are the exception that shows the
pattern: their lists carry no numbers.

---

## The example site

`scale-test-nsip/hs2-phase2a-subsection/` is a generated road corridor at NSIP
scale: 34,847 features across 11 layers, 11,554 of them baseline area habitats.
It is a complete, openable copy of the template with data in it.

**It is generated, not committed.** It comes to roughly 100 MB, and the
generator rebuilds it deterministically to the byte in about seven seconds:

```
cd development/scale-test-generator
python3 generate.py                  # the whole corridor
python3 generate.py --fraction 0.12  # one section, small enough for one metric
```

Every run refreshes the project file, the reference lists and the surveyor's
guide from `templates/bng-service/`, so **the example and the empty template
cannot drift apart**: the template is always the source.

`scale-test-nsip/VERIFICATION.md` is the runbook for exercising the template,
every plugin tool and the service against it, and records what each step
actually measured.

---

## Maintenance tools

In `development/tools/`:

| Tool | What it does |
| --- | --- |
| `qgz_actions.py` | Reads and rewrites the buttons stored in a `.qgz`, by surgical XML edit rather than a full project rewrite |
| `rename_actions.py` | Renames the template's buttons and puts them in the order a user needs |
| `run_actions_headless.py` | Runs a button outside QGIS, standing in for the interface, so its logic can be tested |
| `check_metric_lookups.py` | Checks a filled metric workbook's conditions against that workbook's own lookups, which catches a value the Metric cannot score |
| `check_legacy_template.py` | Re-runs the findings about the legacy template against a fresh download of it |

In `development/scale-test-generator/verify/`: the claim checks run against the
example site, including that nothing is altered by conversion and that the
answer does not move across a round trip.

---

## Notes for maintainers

- **Edit the modules in `plugin/bng_template_convert/`.** They are the only
  copy. `build_plugin.py` zips them as they are.
- **The template's buttons live inside the `.qgz`**, as Python stored in the
  project XML. Change them through `development/tools/`, which keeps every
  other byte of the project untouched; writing the project out through QGIS
  instead drops button titles and rewrites megabytes for the sake of a few
  attributes.
- **Never edit the example site by hand.** Change the template and regenerate.
- **Areas are hectares** in the template, which is the unit the Statutory
  Metric works in. The legacy template uses whole square metres, and the
  conversion handles that.
