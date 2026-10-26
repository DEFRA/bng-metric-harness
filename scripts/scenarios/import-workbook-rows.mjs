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
    input.advance,
    input.delay,
    input.table,
  );
  if (timing.advanceYears === null || timing.delayYears === null) {
    // The workbook treats blank timing as zero. A blank required condition
    // makes its own formulas leave this row unpriced, while keeping positional
    // enhancement pairing and all baseline allocations intact.
    changes.push({
      sheet,
      reference: input.ref,
      retention: input.retention,
      raw: { advanceYears: input.advance, delayYears: input.delay },
      metric: { ...timing, condition: null },
      excludedFromCalculation: true,
    });
    Object.assign(row, timing, { condition: null });
    return;
  }
  if (input.retention === "Lost" && input.table === "Habitats") {
    Object.assign(row, timing);
  }
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

/** Keep vocabulary checking for every input except the declared null projection. */
export function filterProjectedInputIssues(issues, timingChanges = []) {
  const projected = new Set();
  for (const change of timingChanges.filter(
    (item) => item.excludedFromCalculation,
  )) {
    for (const [field, value] of Object.entries(change.metric)) {
      if (value === null) {
        projected.add(`${change.sheet}|${change.reference}|${field}`);
      }
    }
  }
  return issues.filter(
    (issue) =>
      issue.value !== null ||
      !projected.has(`${issue.sheet}|${issue.reference}|${issue.field}`),
  );
}
