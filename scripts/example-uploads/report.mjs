/**
 * Whether an upload gave the result an example file expects, and how to say
 * so: a line for the test log and a table for the CI job summary, each naming
 * the file, what should have happened, what did, and, for a refusal, the
 * error codes.
 */

import { ACCEPTED, BASELINE, REFUSED } from "./expectations.mjs";
import { FAILED } from "./upload-example-file.mjs";

const uploadName = (key) =>
  key === BASELINE ? "baseline" : "post-intervention";

const SHOULD = {
  [ACCEPTED]: "should have been accepted",
  [REFUSED]: "should have been refused",
};

/** What the service did, in words. */
export function describeOutcome(result) {
  const uploads = result.uploads.map(uploadName).join(" then ");
  if (result.outcome === ACCEPTED) {
    return `accepted (${uploads} upload)`;
  }
  const at = `at the ${uploadName(result.refusedAt)} upload`;
  if (result.outcome === FAILED) {
    return `the service threw ${at}: ${result.message}`;
  }
  return `refused ${at} with ${result.codes.join(", ")}`;
}

/**
 * Compare what happened with what the file expects.
 *
 * - The expected result passes.
 * - A throw is never the expected result, even for a file to be refused or a
 *   known gap.
 * - A known gap passes whether the service accepts it, as it does today, or
 *   refuses it. A known gap the service refuses is stale: it is reported, for
 *   the entry to be removed, but does not fail. Failing would block the
 *   backend change that closes the gap, since the backend runs this test at
 *   harness main, where the gap is still listed.
 *
 * @param {string} file the path under example-files/
 * @param {{ expected: string, knownGap?: string }} expectation
 * @param {object} result from uploadExampleFile
 * @returns {{ file: string, pass: boolean, knownGap: boolean, stale: boolean, expected: string, actual: string, message: string }}
 */
export function verdict(file, expectation, result) {
  const actual = describeOutcome(result);
  const base = { file, expected: expectation.expected, actual, stale: false };
  if (expectation.knownGap && result.outcome !== FAILED) {
    const stale = result.outcome !== ACCEPTED;
    return {
      ...base,
      pass: true,
      knownGap: true,
      stale,
      message: stale
        ? `${file} was a known gap (${expectation.knownGap}) and is now ${actual}. Remove it from KNOWN_GAPS in scripts/example-uploads/expectations.mjs, and update its README row.`
        : `${file} should be refused but is accepted today, a known gap: ${expectation.knownGap}`,
    };
  }
  const pass = result.outcome === expectation.expected;
  return {
    ...base,
    pass,
    knownGap: Boolean(expectation.knownGap),
    message: `${file} ${SHOULD[expectation.expected]}, and was ${actual}`,
  };
}

const cell = (text) =>
  String(text)
    .replaceAll("|", String.raw`\|`)
    .replaceAll("\n", " ");

const codeSpan = (v) => `\`${cell(v.file)}\``;

/**
 * The CI job summary for one corpus: a count, every wrong result, then the
 * known gaps, and any known gap the service now refuses.
 *
 * @param {string} title which corpus, and with which backend
 * @param {Array<ReturnType<typeof verdict>>} verdicts
 */
export function summaryMarkdown(title, verdicts) {
  const wrong = verdicts.filter((v) => !v.pass);
  const gaps = verdicts.filter((v) => v.pass && v.knownGap && !v.stale);
  const stale = verdicts.filter((v) => v.stale);
  const lines = [`### ${title}`, ""];
  lines.push(
    wrong.length === 0
      ? `All ${verdicts.length} example files gave the expected result.`
      : `**${wrong.length} of ${verdicts.length} example files gave the wrong result.**`,
    "",
  );
  if (wrong.length > 0) {
    lines.push(
      "| File | Should have been | What happened |",
      "| --- | --- | --- |",
    );
    for (const v of wrong) {
      lines.push(`| \`${cell(v.file)}\` | ${v.expected} | ${cell(v.actual)} |`);
    }
    lines.push("");
  }
  if (gaps.length > 0) {
    lines.push(
      `Known gaps, which should be refused but are accepted today: ${gaps.map(codeSpan).join(", ")}.`,
      "",
    );
  }
  if (stale.length > 0) {
    lines.push(
      "Stale known gaps, which the service now refuses: remove each from KNOWN_GAPS in `scripts/example-uploads/expectations.mjs`, and update its README row.",
      "",
    );
    for (const v of stale) {
      lines.push(`- ${codeSpan(v)}: ${cell(v.actual)}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
