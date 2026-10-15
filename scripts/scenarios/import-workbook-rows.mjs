import { workbookRowsFromGeoPackage } from "#workbook-writer";
import { metricTiming, readTimingInputs } from "./import-timing.mjs";

function restoreAreaBaseline(rows, baselineRows, inputs) {
  const createdRefs = new Set(
    inputs
      .filter((i) => i.table === "Habitats" && i.retention === "Created")
      .map((i) => i.ref),
  );
  const current = new Map(
    rows.habitatBaseline.map((row) => [row.reference, row]),
  );
  // The baseline half is derived BEFORE replacing legacy Lost labels. Keep its
  // lost area rows, alongside each retained/enhanced row's allocation fields.
  rows.habitatBaseline = baselineRows.habitatBaseline.flatMap((row) => {
    const proposedBaseline = current.get(row.reference);
    return proposedBaseline || createdRefs.has(row.reference)
      ? [proposedBaseline ?? row]
      : [];
  });
}

function applyRowTiming(row, input, sheet, changes) {
  const timing = metricTiming(
    input.retention,
    row.advanceYears,
    row.delayYears,
  );
  if (
    timing.advanceYears === row.advanceYears &&
    timing.delayYears === row.delayYears
  ) {
    return;
  }
  changes.push({
    sheet,
    reference: input.ref,
    retention: input.retention,
    raw: { advanceYears: row.advanceYears, delayYears: row.delayYears },
    metric: timing,
  });
  Object.assign(row, timing);
}

function applyInputTiming(rows, input, changes) {
  for (const stage of ["Creation", "Enhancement"]) {
    const sheet = `${input.prefix}${stage}`;
    const matches = rows[sheet].filter((row) => row.reference === input.ref);
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous workbook timing reference ${sheet}/${input.ref}`,
      );
    }
    for (const row of matches) {
      applyRowTiming(row, input, sheet, changes);
    }
  }
}

function applyTiming(rows, inputs) {
  const changes = [];
  for (const input of inputs) {
    applyInputTiming(rows, input, changes);
  }
  return changes;
}
/** Write the workbook for the independently specified, cleansed import inputs. */
export function importWorkbookRows(baselineFile, piFile) {
  const { rows, notes } = workbookRowsFromGeoPackage(piFile);
  const baseline = workbookRowsFromGeoPackage(baselineFile);
  const inputs = readTimingInputs(piFile);
  restoreAreaBaseline(rows, baseline.rows, inputs);
  const timingChanges = applyTiming(rows, inputs);
  return { rows, notes, timingChanges };
}
