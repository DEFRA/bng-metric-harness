/**
 * `--worse KIND=N` for the BNG Service format: how many of each kind of
 * habitat that gets worse a synthetic site draws, in place of one each
 * (bng-library's `worseHabitatCounts`).
 *
 * Split out of `gen-gpkg.mjs` to keep that file within its size budget; it is
 * the CLI's only consumer.
 */

import {
  FlawSelectionError,
  MAX_WORSE_COUNT,
  STAGE_BASELINE,
  WORSE_KINDS,
  assertDegradeSubjectsDrawn,
  resolveWorseCounts,
} from "#bng-lib";

const WHOLE_NUMBER = /^\d+$/;

/**
 * The counts `--worse` asks for, by kind, or undefined when it was not
 * given. Refuses a value that is not KIND=N, a kind the library does not
 * know, a count out of range, a kind given twice, and a count of 0 for the
 * kind a degrade flaw asked for breaks.
 *
 * @param {string[]} values  each --worse value
 * @param {string[]} [degradeFlawNames]  the degrade flaws asked for
 * @returns {Record<string, number> | undefined}
 */
export function parseWorseCounts(values, degradeFlawNames = []) {
  if (values.length === 0) {
    return undefined;
  }
  // No prototype, so a kind such as constructor reaches the library's
  // unknown-kind refusal instead of reading as given twice.
  const counts = Object.create(null);
  for (const value of values) {
    const [kind, count, ...rest] = value.split("=");
    if (rest.length > 0 || !count || !WHOLE_NUMBER.test(count.trim())) {
      throw new FlawSelectionError(
        `--worse takes KIND=N, such as hedge=4 (got: ${value}); kinds: ${WORSE_KINDS.join(", ")}`,
      );
    }
    const name = kind.trim();
    if (Object.hasOwn(counts, name)) {
      throw new FlawSelectionError(`--worse names ${name} twice`);
    }
    counts[name] = Number(count.trim());
  }
  try {
    assertDegradeSubjectsDrawn(degradeFlawNames, resolveWorseCounts(counts));
  } catch (err) {
    throw new FlawSelectionError(`--worse: ${err.message}`);
  }
  return counts;
}

/**
 * Refuse counts the file would not show: a site drawn with a geometric flaw
 * (or --bad) and no degrade flaw is the minimal site, which draws no
 * habitats that get worse (a degrade flaw adds them to it); and the
 * baseline-stage file leaves the post-intervention tables, where they are
 * recorded, empty.
 *
 * @param {Record<string, number> | undefined} counts  as parseWorseCounts gives
 * @param {{ geometricFlawNames: string[], degradeFlawNames: string[], stage: string }} site
 */
export function assertWorseDrawn(
  counts,
  { geometricFlawNames, degradeFlawNames, stage },
) {
  if (!counts) {
    return;
  }
  if (geometricFlawNames.length > 0 && degradeFlawNames.length === 0) {
    throw new FlawSelectionError(
      "--worse with --bad or a geometric flaw needs a degrade flaw too: their minimal site draws no habitats that get worse without one",
    );
  }
  if (stage === STAGE_BASELINE) {
    throw new FlawSelectionError(
      `--worse changes post-intervention features, which the baseline-stage file leaves empty; drop --stage ${STAGE_BASELINE}`,
    );
  }
}

/** The --help lines for --worse. */
export function worseHelp() {
  return `  --worse KIND=N      ${"bng-service"} synthetic only: draw N habitats that get
                      worse of a kind, in place of one (0 to ${MAX_WORSE_COUNT}).
                      Repeatable. Kinds: ${WORSE_KINDS.join(", ")}.
                      hedge gets worse as a whole; partly-worse-hedge is split
                      into a Retained part a and a worse part b.`;
}
