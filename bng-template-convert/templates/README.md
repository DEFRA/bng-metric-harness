# Templates

The two QGIS templates that the converter reads and writes. They are kept here
so that the code and the formats it targets have the same version history.

| Folder | Template | Role |
| --- | --- | --- |
| `bng-service/` | BNG Service Habitat Mapping | The staged format. `old_to_new.py` writes it and `new_to_old.py` reads it |
| `legacy-ne/` | Net Gain Habitat Mapping | The Natural England template, not changed. `new_to_old.py` writes it and `old_to_new.py` reads it |

## Differences that matter to the converter

- **Stages.** A legacy row holds the baseline and the proposed values in
  `Baseline *` and `Proposed *` columns. The BNG Service template has separate
  baseline and post-intervention layers. One legacy file becomes a pair, and a
  pair becomes one file.
- **Lineage.** The BNG Service template records `parent_uuid`,
  `parent_checksum` and `parent_geom` on each post-intervention row. Legacy has
  no lineage. Conversion to legacy drops it, and conversion back rebuilds it
  from the references.
- **Area units.** `Area` is in hectares in the BNG Service template and in
  whole square metres in legacy. `gpkg_common.py` converts in both directions.
  `Length` is in metres in both.
- **Vertical area habitats.** Only the BNG Service template has them, so
  conversion to legacy cannot carry them.

## Using a template

**Copy the folder and work in the copy.** A template that is opened and saved
in place changes.

`bng-service/HOW TO USE THIS TEMPLATE.md` is the surveyor's guide, including
the four attribute-table buttons.
