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
 * Compare what happened with what the file expects. Only the expected result
 * passes: a throw is never it, even for a file to be refused.
 *
 * @param {string} file the path under example-files/
 * @param {{ expected: string }} expectation
 * @param {object} result from uploadExampleFile
 * @returns {{ file: string, pass: boolean, expected: string, actual: string, message: string }}
 */
export function verdict(file, expectation, result) {
  const actual = describeOutcome(result);
  return {
    file,
    expected: expectation.expected,
    actual,
    pass: result.outcome === expectation.expected,
    message: `${file} ${SHOULD[expectation.expected]}, and was ${actual}`,
  };
}

const cell = (text) =>
  String(text)
    .replaceAll("|", String.raw`\|`)
    .replaceAll("\n", " ");

/**
 * The CI job summary for one corpus: a count, then every wrong result.
 *
 * @param {string} title which corpus, and with which backend
 * @param {Array<ReturnType<typeof verdict>>} verdicts
 */
export function summaryMarkdown(title, verdicts) {
  const wrong = verdicts.filter((v) => !v.pass);
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
  return `${lines.join("\n")}\n`;
}
