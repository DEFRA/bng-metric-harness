# qgis-template

The BNG Service QGIS habitat mapping template and a QGIS plugin that converts
sites into and out of it. Also a generated example site at the scale of a
Nationally Significant Infrastructure Project (NSIP), and a generator for
small sites.

The conversion code uses only the Python standard library. Only the plugin
needs QGIS.

## What is where

| Folder | What it holds |
| --- | --- |
| `templates/bng-service/` | **The template.** An empty QGIS project, its reference lists, and `HOW TO USE THIS TEMPLATE.md`, the surveyor's guide |
| `templates/legacy-ne/` | The Natural England template as it ships |
| `plugin/` | **The plugin.** Source, `build_plugin.py`, and `plugin/README.md`, the installation and usage guide |
| `reference/` | The Statutory Metric workbooks, the Excel GIS import tool and the user guide. Every reference list in the template is checked against these |
| `scale-test-nsip/` | The example site: generator, claim checks, `README.md`, `VERIFICATION.md` and the generated output |
| `site-generator/` | **The site generator.** Builds a small synthetic site from inputs such as the number of parcels, the area and the location. See its `README.md` |
| `development/tools/` | Tools that maintain the template. Nothing here is needed to use it |

**This file is for maintainers.** Users get `HOW TO USE THIS TEMPLATE.md`
with the template and the example site, and `plugin/README.md` with the
plugin.

## The plugin

**Edit the code only in `plugin/bng_template_convert/`.** It is the only
copy. The build zips it with `plugin/README.md`, so the plugin carries its
guide.

```sh
cd plugin && python3 build_plugin.py   # -> plugin/dist/bng_template_convert.zip
```

To install, in QGIS select **Plugins** > **Manage and Install Plugins...** >
**Install from ZIP**, then select the zip and **Install Plugin**. Accept the
untrusted source warning. The tools show under **Plugins** > **BNG Template
Convert** and in the **Processing Toolbox**.

**An export to the Metric and a conversion into the template each need an
empty copy of the target file.** Users most often get this wrong.

### Running the conversions without QGIS

The modules also run from the command line:

```sh
cd plugin/bng_template_convert

python3 new_to_old.py INPUT.gpkg -o OUT_DIR
        [--format gpkg|csv|both] [--consolidate] [--merge-irreplaceable]
        [--carry-lineage] [--dry-run]

python3 old_to_new.py --baseline BASE.gpkg [--post-intervention PI.gpkg]
        -o OUT_DIR [--into TEMPLATE.gpkg [--force]] [--dry-run]

python3 to_metric.py INPUT.gpkg --metric METRIC.xlsm|.xlsx -o OUT
        [--consolidate] [--allow-occupied]
```

## What conversion to legacy loses

The converter gives a warning for each of these:

- **Vertical area habitats are not carried.** Legacy has no layer for them,
  so a legacy calculation leaves out their units.
- **Irreplaceable habitat flags are dropped.** Legacy has no column for them,
  so the converter lists them in `Irreplaceable habitats.csv`.
- **Lineage keys are dropped**, unless lineage is recorded in comments. The
  plugin records it by default. The command line needs `--carry-lineage`.
- **Split features are flagged.** When a baseline hedgerow, watercourse or
  tree becomes several features, each converted row repeats the parent
  reference. Legacy expects one row for each reference, so its result can
  differ.
- **Loss rows copy the parent shape.** Legacy cannot record a removal by
  absence, so the conversion writes a loss row with the baseline shape. The
  length or count removed is exact. The stretch removed is not known.

Conversion back from legacy drops the loss rows, because the template records a
removal by leaving the feature out.

**Some drop-down values start with the Metric list number**, as
`4. Fairly Poor`. Both templates store that form. The Metric workbook and the
import tool hold only the words, so the conversion removes the number for
them. Hedgerow lists have no numbers.

**Template areas are in hectares**, as in the Metric. Legacy areas are whole
square metres. The conversion changes the unit in both directions.

## The example site

`scale-test-nsip/hs2-phase2a-subsection/` is a generated rail corridor at NSIP
scale: 34,847 features across 11 layers, of which 11,554 are baseline area
habitats. It is a full copy of the template with data in it.

**The site is generated, not committed.** It is approximately 100 MB. The
generator rebuilds it to the same bytes in approximately seven seconds. Run
these from this folder:

```sh
python3 scale-test-nsip/generator/generate.py                  # whole corridor
python3 scale-test-nsip/generator/generate.py --fraction 0.12  # one section
```

The 12% section fits in one Metric workbook and goes to
`scale-test-nsip/hs2-phase2a-subsection-12pc/`.

**The template is always the source.** Each run copies the project file, the
reference lists and the surveyor's guide from `templates/bng-service/`.

**Every value in the site is one that a drop-down offers.** The generator does
not use the drop-downs, so each run ends with a check of every value against
the filtered list that QGIS shows for that row. The run fails on a value that
is not in the list. To check any site folder:

```sh
python3 scale-test-nsip/generator/dropdown_check.py <site folder>
```

`scale-test-nsip/VERIFICATION.md` is the runbook for the template, each
plugin tool and the service, with the measured results. The checks it uses are
in `scale-test-nsip/verify/`.

**Never edit the site by hand.** Change the template or the generator, and
generate again.

## Maintenance tools

**The template buttons are Python stored in the `.qgz` project XML.** Edit
them only with the tools in `development/tools/`, which change no other byte.
A project saved from QGIS loses the button short titles.
`development/tools/README.md` describes each tool.
