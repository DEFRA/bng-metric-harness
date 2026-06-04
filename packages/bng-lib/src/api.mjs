/**
 * Buffer-in / buffer-out public API. Wraps the path-based generators with a
 * temp-file dance so callers (e.g. the prototype's web form) can pass and
 * receive Buffers without touching the disk themselves.
 *
 * better-sqlite3 only writes to a real file descriptor, so we materialise
 * each gpkg in os.tmpdir(), read it back, and unlink. The path-based
 * pipeline is unchanged.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { generateOne } from "./synthetic/synthetic.mjs";
import {
  ALL_FLAW_NAMES,
  CATEGORY_ATTRIBUTE,
  CATEGORY_EMPTY,
  CATEGORY_GEOMETRIC,
  FLAWS,
  resolveFlawSelection,
} from "./synthetic/flaws.mjs";
import { readMetricWorkbookFromBuffer } from "./workbook/metric-workbook.mjs";
import {
  MODE_BASELINE,
  MODE_BOTH,
  MODE_POST_INTERVENTION,
  VALID_MODES,
  generateFromWorkbook,
} from "./orchestration.mjs";
import { captureMessages } from "./log.mjs";

const TMP_PREFIX = "bng-lib-";
const DEFAULT_CENTRE_E = 530000;
const DEFAULT_CENTRE_N = 180000;
const DEFAULT_SYNTHETIC_PARCELS = 50;

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), TMP_PREFIX));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function defaultCentre(centre) {
  if (centre && centre.length === 2 && Number.isFinite(centre[0]) && Number.isFinite(centre[1])) {
    return centre;
  }
  return [DEFAULT_CENTRE_E, DEFAULT_CENTRE_N];
}

/**
 * Generate one synthetic GeoPackage. Returns the file as a Buffer plus a
 * filenameHint the caller can use as the download filename, and any
 * messages emitted along the way (banner, warnings).
 *
 * options:
 *   numParcels   number of habitat parcels (default 50)
 *   centre       [easting, northing] in BNG (default Maidenhead)
 *   bad          shorthand for --bad (apply every composable geometric flaw)
 *   flaws        array of flaw names to apply (geometric | empty | attribute)
 */
export function generateSyntheticGpkg(options = {}) {
  const {
    numParcels = DEFAULT_SYNTHETIC_PARCELS,
    centre,
    bad = false,
    flaws = [],
  } = options;

  const resolvedCentre = defaultCentre(centre);
  const selection = resolveFlawSelection({ bad, flaws, numParcels });

  return withTempDir((dir) => {
    const filenameHint = syntheticFilenameHint({ selection, bad });
    const outPath = path.join(dir, filenameHint);
    const { messages } = captureMessages(() => {
      generateOne(outPath, resolvedCentre, { numParcels, ...selection });
    });
    return {
      buffer: readFileSync(outPath),
      filenameHint,
      messages,
    };
  });
}

/**
 * Generate one or both gpkgs from an uploaded workbook buffer.
 *
 * options:
 *   workbookBuffer    Buffer of the uploaded xlsx/xlsm
 *   workbookFilename  used to derive the output filenames
 *   mode              'baseline' | 'post-intervention' | 'both' (default 'both')
 *   strict            propagate to buildBaselineRows / buildPostInterventionRows
 *   centre            [easting, northing] in BNG (default Maidenhead)
 *
 * Returns:
 *   baseline           { buffer, filenameHint } | undefined
 *   postIntervention   { buffer, filenameHint } | undefined
 *   messages           captured banner + warnings
 *   success            false if the workbook produced no usable area
 */
export function generateFromWorkbookBuffer(options) {
  const {
    workbookBuffer,
    workbookFilename = "workbook.xlsx",
    mode = MODE_BOTH,
    strict = false,
    centre,
  } = options;

  if (!VALID_MODES.has(mode)) {
    throw new Error(`mode must be one of: ${[...VALID_MODES].join(", ")} (got: ${mode})`);
  }

  const resolvedCentre = defaultCentre(centre);
  const workbook = readMetricWorkbookFromBuffer(workbookBuffer, workbookFilename);
  const names = workbookOutputNames(workbookFilename);

  return withTempDir((dir) => {
    const outPaths = {
      baseline: path.join(dir, names.baseline),
      postIntervention: path.join(dir, names.postIntervention),
    };

    const { result, messages } = captureMessages(() =>
      generateFromWorkbook(outPaths, workbook, workbookFilename, {
        strict,
        centre: resolvedCentre,
        mode,
      }),
    );

    if (!result.success) {
      return { success: false, messages };
    }

    const out = { success: true, messages };
    if (mode !== MODE_POST_INTERVENTION) {
      out.baseline = { buffer: readFileSync(outPaths.baseline), filenameHint: names.baseline };
    }
    if (mode !== MODE_BASELINE) {
      out.postIntervention = {
        buffer: readFileSync(outPaths.postIntervention),
        filenameHint: names.postIntervention,
      };
    }
    return out;
  });
}

function timestampSuffix(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function workbookOutputNames(source) {
  const cleaned = source.replace(/[?#].*$/, "");
  const base = path.basename(cleaned).replace(/\.(xlsx|xlsm|xls)$/i, "") || "bng-from-workbook";
  const ts = timestampSuffix();
  return {
    baseline: `${base}-baseline-${ts}.gpkg`,
    postIntervention: `${base}-post-intervention-${ts}.gpkg`,
  };
}

function sortFlawNames(names) {
  return [...names].sort((a, b) => a.localeCompare(b));
}

function syntheticFilenameHint({ selection, bad }) {
  const { geometricFlawNames, emptyFlawNames, attributeFlawNames } = selection;
  let flawSuffix;
  if (attributeFlawNames.length > 0) {
    flawSuffix = `-${sortFlawNames(attributeFlawNames).join("-")}`;
  } else if (emptyFlawNames.length > 0) {
    flawSuffix = `-${sortFlawNames(emptyFlawNames).join("-")}`;
  } else if (geometricFlawNames.length === 0) {
    flawSuffix = "";
  } else if (bad) {
    flawSuffix = "-bad";
  } else {
    flawSuffix = `-bad-${sortFlawNames(geometricFlawNames).join("-")}`;
  }
  return `bng-test-data${flawSuffix}-${timestampSuffix()}.gpkg`;
}

const CATEGORY_LABELS = {
  [CATEGORY_GEOMETRIC]: "geometric",
  [CATEGORY_EMPTY]: "empty-layer",
  [CATEGORY_ATTRIBUTE]: "attribute-override",
};

/**
 * Returns the flaw registry in a form suitable for rendering a form:
 *   [{ name, description, errorCode, category, categoryLabel, standalone }]
 * Grouped logically by category but flat so the caller can group however it
 * likes.
 */
export function listFlaws() {
  return ALL_FLAW_NAMES.map((name) => {
    const f = FLAWS[name];
    const category = f.category ?? CATEGORY_GEOMETRIC;
    return {
      name,
      description: f.description,
      errorCode: f.errorCode,
      category,
      categoryLabel: CATEGORY_LABELS[category],
      standalone: Boolean(f.standalone),
    };
  });
}
