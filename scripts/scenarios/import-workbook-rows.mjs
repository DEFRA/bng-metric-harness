import { workbookRowsFromGeoPackage } from "#workbook-writer";
import { metricTiming, readTimingInputs } from "./import-timing.mjs";

/** Each row of a list by its reference, in order: a reference may repeat. */
function rowsByReference(list) {
  const byReference = new Map();
  for (const row of list) {
    byReference.set(row.reference, [
      ...(byReference.get(row.reference) ?? []),
      row,
    ]);
  }
  return byReference;
}

function restoreAreaBaseline(rows, baselineRows) {
  // A reference may repeat (BMD-1058), and a legacy tree that worsens keeps
  // the ref of the tree it is, so the baseline half holds that ref twice: the
  // tree, and the Created row's N/A placeholder. Each post-intervention
  // baseline row is matched to one baseline-half row, in order, so neither
  // is counted twice.
  const current = rowsByReference(rows.habitatBaseline);
  // The baseline the service saves is rebuilt from the post-intervention file,
  // whose Created rows have no baseline habitat. Keep the baseline half's
  // order, with each kept row's allocation fields from the post-intervention
  // file.
  rows.habitatBaseline = baselineRows.habitatBaseline.flatMap((row) => {
    const proposedBaseline = current.get(row.reference)?.shift();
    return proposedBaseline ? [proposedBaseline] : [];
  });
  // The service saves every baseline habitat the post-intervention file
  // holds, so one the baseline half lacks would be under-counted here: the
  // pair disagrees, and is refused rather than priced.
  const unmatched = [...current]
    .filter(([, left]) => left.length > 0)
    .map(([ref]) => ref);
  if (unmatched.length > 0) {
    throw new Error(
      `The post-intervention file holds baseline habitats the baseline half does not: ${unmatched.join(", ")}`,
    );
  }
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
  restoreAreaBaseline(rows, baseline.rows);
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
