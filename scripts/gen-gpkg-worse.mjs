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
  WORSE_KINDS,
  resolveWorseCounts,
} from "#bng-lib";

const WHOLE_NUMBER = /^\d+$/;

/**
 * The counts `--worse` asks for, by kind, or undefined when it was not
 * given. Refuses a value that is not KIND=N, a kind the library does not
 * know, a count out of range, and a kind given twice.
 *
 * @param {string[]} values  each --worse value
 * @returns {Record<string, number> | undefined}
 */
export function parseWorseCounts(values) {
  if (values.length === 0) {
    return undefined;
  }
  const counts = {};
  for (const value of values) {
    const [kind, count, ...rest] = value.split("=");
    if (rest.length > 0 || !count || !WHOLE_NUMBER.test(count.trim())) {
      throw new FlawSelectionError(
        `--worse takes KIND=N, such as hedge=4 (got: ${value}); kinds: ${WORSE_KINDS.join(", ")}`,
      );
    }
    const name = kind.trim();
    if (name in counts) {
      throw new FlawSelectionError(`--worse names ${name} twice`);
    }
    counts[name] = Number(count.trim());
  }
  try {
    resolveWorseCounts(counts);
  } catch (err) {
    throw new FlawSelectionError(`--worse: ${err.message}`);
  }
  return counts;
}

/** The --help lines for --worse. */
export function worseHelp() {
  return `  --worse KIND=N      ${"bng-service"} synthetic only: draw N habitats that get
                      worse of a kind, in place of one (0 to ${MAX_WORSE_COUNT}).
                      Repeatable. Kinds: ${WORSE_KINDS.join(", ")}.
                      hedge gets worse as a whole; partly-worse-hedge is split
                      into a Retained part a and a worse part b.`;
}
