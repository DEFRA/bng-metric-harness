---
name: generate-geopackage
description: >-
  Generate a BNG GeoPackage for a demonstration, a test or a bug report, in
  the BNG Service QGIS template (or the legacy Natural England one), and hand
  it over ready to open in QGIS. Use when asked to make, generate or build a
  GeoPackage, gpkg, test site, example site or demo file, especially one that
  shows a behaviour (degraded or partly degraded hedgerows, habitats that get
  worse, lost, created or enhanced habitats, watercourse encroachment, a
  validation flaw). Drives `npm run generate:gpkg`, checks the result, and
  delivers the template folder zipped with a table of what each feature shows.
userInvocable: true
arguments: "<what the file should show, and who it is for>"
---

# Generate a GeoPackage

Make the file with the harness's generator, not by hand or with a one-off
script. The generator draws valid sites from a seed, names flaws in the file
name, and checks every BNG Service file it writes. Hand-built sites have
gone wrong in ways those checks catch: repeated feature IDs that link a
post-intervention row to the wrong parent, and a bare `.gpkg` that the
template's QGIS project shows as "layers unavailable".

## Pick the command

| Asked for                                                                         | Command                                                                                                                 |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| A file to show, test or reproduce something                                       | `npm run generate:gpkg -- …` (this skill)                                                                               |
| A change to the committed BNG Service corpus in `example-files/service-template/` | Edit `scripts/service-template/recipes.mjs`, then `npm run generate:service-template`. Never edit the corpus for a demo |
| The metric scenario catalogue, with workbooks                                     | `npm run generate:scenarios` (`docs/generate-scenarios.md`)                                                             |
| A site from a real metric workbook                                                | `npm run generate:gpkg -- --format bng-service --from <xlsx>`                                                           |

**Use `--format bng-service` unless the legacy Natural England template is
asked for.** The default is still the legacy format.

## Steps

1. **Set up.** Use Node 24 (`nvm use`), then `npm install` in the harness.
   Packaging for QGIS needs the template repo: `npm run bootstrap` clones
   `bng-metric-template` beside the harness (or set `BNG_TEMPLATE_DIR`).
2. **Turn the request into flags.** `npm run generate:gpkg -- --help` lists
   all of them and every flaw.

   | Need                                      | Flags                                                                                                                                       |
   | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
   | Few enough features to talk through       | `--size 10` to `--size 20` parcels (default 50). Hedgerows scale at one per three parcels, and the template features add more               |
   | Somewhere plausible on a map              | `--centre E,N` in British National Grid. The default, 530000,180000, is in London; pick a rural point in England for hedgerows and farmland |
   | The same file again                       | `--seed N`: the same seed and flags give the same bytes                                                                                     |
   | The file before post-intervention mapping | `--stage baseline`                                                                                                                          |
   | A validation fault                        | `--flaw NAME`, named in the file name; lineage, degrade and version flaws combine with the others                                           |
   | More of one behaviour                     | `--worse KIND=N`, repeatable, 0 to 50: `hedge`, `partly-worse-hedge`, `parcel`, `vertical`, `encroached-watercourse`, `worse-watercourse`   |
   | A file to open in QGIS                    | `--package-template`                                                                                                                        |

   A default BNG Service site already holds what only the new template
   records: one parcel, vertical habitat and hedge that get worse, a hedge
   that gets worse in part (split, part **a** Retained, part **b** worse),
   an encroached watercourse and one whose condition gets worse, plus
   Retained, Enhanced, Created and lost features on every layer. To show
   more of one, ask for it: `--worse hedge=4 --worse partly-worse-hedge=4`
   draws eight hedgerows that get worse, each with its own parent. Parcels
   get worse only while another Retained parcel stays, so `--worse parcel=N`
   may give fewer than N.

3. **Choose a seed that shows what was asked.** `--worse` sets how many;
   the seed sets which conditions they move between (Good to Poor, Moderate
   to Poor, and so on) and what else the site holds. Generate a few (`--seed 1` to `--seed 15`, same other flags, into a
   scratch `--outdir`), then compare them:

   ```sh
   node .claude/skills/generate-geopackage/scripts/summarise.mjs <file.gpkg>
   ```

   It prints, per layer, the counts at each stage, the Retention Categories,
   the lost features and every row recording a habitat that gets worse.
   Pick the seed that covers the cases the request names, and regenerate it
   with `--package-template` into the final `--outdir`.

4. **Read the checks.** Each BNG Service file is checked as it is written:
   its lineage (as `npm run check:lineage`) and its values against the
   template's drop-downs. A check that should pass and fails exits 1; one a
   requested flaw may break only warns. Do not hand over a file that failed.
   For an upload question, also run the backend's template gate:

   ```sh
   node .claude/skills/generate-geopackage/scripts/backend-gate.mjs <file.gpkg>
   ```

   It needs the backend installed (`npm run install:be`; if npm refuses the
   backend's git-pinned bng-library, run `npm run lib:link` in the backend).

5. **Hand over the zip, not the bare `.gpkg`.** `--package-template` writes
   `<name>-qgis/`, a copy of the template folder with the rows in
   `Layers/BNG Service Layers.gpkg`, and `<name>-qgis.zip`. Tell the reader
   to unzip it and open `BNG Service Habitat Mapping.qgz` inside, keeping it
   out of a folder that syncs to the cloud. Give a short table of which
   feature shows which behaviour, from `summarise.mjs`.

## Say plainly

- **Whether the file was opened in QGIS.** An agent usually cannot. The
  checks above are not the same as opening it.
- **That the service cannot read a BNG Service file yet.** With the
  service-template flag on (`SERVICE_TEMPLATE_ENABLED=true`), an upload that
  passes the gate is still refused as "not yet read"
  (`SERVICE_TEMPLATE_NOT_YET_READ`). A demonstration of the template stays
  in QGIS.
- **Which template the file matches.** The schema is bng-library's copy of
  the template. If packaging refuses a file as not matching the template
  checkout, the two repos are at different versions: say so rather than
  forcing it.

## Gotchas

- `check:lineage` only reads files inside the harness: generate into
  `test-data/` (gitignored), not a temporary folder elsewhere.
- Output names carry a timestamp, so runs do not overwrite each other;
  packaging refuses to write over a folder already there.
- A bare `.gpkg` dragged into QGIS opens, but without the template's forms,
  drop-downs or buttons. Opening the template's project with a GeoPackage of
  another name or an older layout gives "layers unavailable".
