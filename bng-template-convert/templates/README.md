# Templates

The QGIS templates this converter reads and writes, kept here so the code and
the formats it targets are versioned together. Working copies of the same three
live outside the repo; these are reference copies, with every `*.backup-*` file
left behind.

| Folder | Template | Role |
| --- | --- | --- |
| `bng-service/` | BNG Service Habitat Mapping | The staged format. Separate Baseline and Post-Intervention layers, lineage columns, and the four attribute-table actions. What `old_to_new.py` writes and `new_to_old.py` reads. |
| `legacy-ne/` | Net Gain Habitat Mapping | The unmodified Natural England template. One row carries both baseline and proposed values, and there is no lineage. What `new_to_old.py` writes and `old_to_new.py` reads. |
| `legacy-ne-vertical-area/` | Net Gain Habitat Mapping, with Vertical Area Habitats | A fork of the Natural England template that adds the Vertical Area Habitats trio. The converter does not target this one; it is here because it is where the vertical area layers were worked out. |

## Differences that matter to the converter

- **Staging.** `legacy-ne` holds one feature per parcel with `Baseline *` and
  `Proposed *` columns side by side. `bng-service` splits that into two layers,
  so one legacy file becomes a pair and a pair becomes one file.
- **Lineage.** `bng-service` stamps `parent_uuid`, `parent_checksum` and
  `parent_geom` onto each post-intervention row. Legacy has none of this, so
  converting to legacy drops it and converting back rebuilds it from references.
- **Area units.** `bng-service` records `Area` in hectares; legacy `Area` is a
  whole number of square metres. `gpkg_common.py` converts in both directions.
  `Length` is metres on both sides.
- **Vertical area habitats.** Present in `bng-service` and
  `legacy-ne-vertical-area`, absent from `legacy-ne`, which is why converting to
  legacy cannot carry them.

## Using one

Copy the folder somewhere else first and work in the copy. Opening a template in
place and saving will modify it.

`bng-service/HOW TO USE THIS TEMPLATE.md` is the surveyor-facing guide to the
staged template, including the four attribute-table buttons.

## legacy-ne-vertical-area holds two projects

`Net Gain Habitat Mapping - with Vertical Area Habitats.qgz` is the current one.
`Net Gain Habitat Mapping - with Green Walls.qgz` is the earlier name for the
same work, kept because it was never a `*.backup-*` file. Both point at the same
`Layers/Net Gain Habitat Mapping Layers.gpkg`.
