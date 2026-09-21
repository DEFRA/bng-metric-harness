# tools

Maintaining the template and checking what comes out of it. Nothing here is
needed to use the template or the plugin.

## Editing the buttons stored inside a QGIS project

The template's four attribute-table buttons are Python scripts stored as XML
attributes in the `.qgz`. Rewriting one through `QgsProject.write()` is the
obvious route and the wrong one: it drops action shortTitles set in XML, and
it rewrites three megabytes of project for the sake of one attribute.

`qgz_actions.py` edits the attribute in place instead. Its escaping is
verified by round-tripping: unescaping and re-escaping every one of the
project's twenty action bodies reproduces the original bytes exactly. Two
things had to be right for that, and both are easy to get wrong. QGIS leaves
`>` unescaped in an attribute, and an action body ends at the first raw double
quote after `action="`, not at whatever attribute happens to come next: some
actions carry an `<actionScope>` child and some do not.

Anything that writes a project leaves a timestamped `.backup-YYYYMMDD-HHMMSS`
beside it first.

## What is here

| File | What |
| --- | --- |
| `qgz_actions.py` | Read and rewrite action bodies in a `.qgz`, byte-safely. The others build on this |
| `rename_actions.py` | Strip the list numbers from the button names and store them in the order a user needs. Idempotent |
| `run_actions_headless.py` | Run a button outside QGIS, standing in for the parts of the interface it uses, so its logic can be tested against a real site |
| `check_metric_lookups.py` | Read a filled metric workbook and check every condition it holds against that workbook's own lookup rows |
| `check_legacy_template.py` | Re-run the recorded findings about Natural England's template against a fresh download of it |

## Running them

```sh
python3 development/tools/rename_actions.py "templates/bng-service/BNG Service Habitat Mapping.qgz"

python3 development/tools/check_metric_lookups.py "Filled metric.xlsm"
```

`run_actions_headless.py` needs QGIS's own Python, because it loads the
project through pyqgis:

```sh
/Applications/QGIS.app/Contents/MacOS/bin/python3 \
    development/tools/run_actions_headless.py \
    "<site>/BNG Service Habitat Mapping.qgz" "Copy baseline" \
    "Hedgerows Post-Intervention" --answer no
```

**A button saves as it goes and there is no undo, so run these against a copy
of a site**, never against one that matters.

## Why a headless runner exists

The buttons are the part of the template most likely to be wrong and the
hardest to test: they talk to the QGIS interface, they write to the file as
they work, and exercising them by hand means clicking through a site of eleven
thousand parcels. `run_actions_headless.py` stands in for the message bar, the
progress dialog and the question box, so a change to a button can be checked
against real data in seconds, and the answer given to any question it asks is
set from the command line.
