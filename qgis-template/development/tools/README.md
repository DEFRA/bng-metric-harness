# tools

Tools that maintain the template and check what it produces. Nothing here is
needed to use the template or the plugin.

| File | What it does |
| --- | --- |
| `qgz_actions.py` | Reads and writes the button code in a `.qgz` without a change to any other byte. The other tools use it |
| `rename_actions.py` | Removes the list numbers from the button names and puts the buttons in the order a user needs. Safe to run again |
| `run_actions_headless.py` | Runs a button outside QGIS against a real site, so that its logic can be tested |
| `reset_stale_dropdowns.py` | Gives each filtered drop-down a rule that clears its value when an earlier choice makes the value invalid. Without the rule, QGIS keeps the old value in brackets. Safe to run again |
| `check_metric_lookups.py` | Checks each condition in a filled Metric workbook against the lookup rows of the same workbook |
| `check_legacy_template.py` | Checks the recorded findings about the Natural England template against `templates/legacy-ne/`. Put a fresh download there to check them again |

## Editing the buttons

**The four attribute-table buttons are Python stored as XML attributes in the
`.qgz`.** Do not save the project through QGIS to change them. QGIS drops the
button short titles and rewrites 3 MB of project.

`qgz_actions.py` changes the attribute in place. A round trip of all 20
action bodies gives the original bytes. Two rules are necessary for this:

- QGIS does not escape `>` in an attribute.
- An action body ends at the first raw double quote after `action="`. Only
  some actions have an `<actionScope>` child.

Each tool that writes a project first saves a copy beside it, named
`.backup-YYYYMMDD-HHMMSS`. Git ignores these copies.

## Running the tools

Run these from the `qgis-template` folder:

```sh
python3 development/tools/rename_actions.py "templates/bng-service/BNG Service Habitat Mapping.qgz"
python3 development/tools/reset_stale_dropdowns.py "templates/bng-service/BNG Service Habitat Mapping.qgz"
python3 development/tools/check_metric_lookups.py "Filled metric.xlsm"
python3 development/tools/check_legacy_template.py
```

`run_actions_headless.py` needs the Python that comes with QGIS, because it
loads the project through PyQGIS. Its arguments are the project, the start of
the button name, and the layer:

```sh
/Applications/QGIS.app/Contents/MacOS/bin/python3 \
    development/tools/run_actions_headless.py \
    "<site>/BNG Service Habitat Mapping.qgz" "Copy baseline" \
    "Hedgerows Post-Intervention" --answer no
```

`--answer` sets the reply to any question that the button asks. The runner
replaces the message bar, the progress dialog and the question box. A change
to a button can then be tested against a site of 11,000 parcels in seconds,
not by hand.

**A button saves as it runs and has no undo. Run it only against a copy of a
site.**
