/**
 * `--flaw` for the BNG Service format: split the selection into the legacy
 * flaws and the format's own lineage and template-version flaws, and refuse
 * a selection the file could not hold.
 *
 * Split out of `gen-gpkg.mjs` to keep that file within its size budget; it is
 * the CLI's only consumer.
 */

import {
  BNG_SERVICE_FLAWS,
  CATEGORY_LINEAGE,
  FORMAT_BNG_SERVICE,
  FlawSelectionError,
  LEGACY_ONLY_FLAWS,
  STAGE_BASELINE,
} from "#bng-lib";

/**
 * Split --flaw into the legacy flaws, which the legacy generator draws, and
 * the BNG Service format's own lineage and template-version flaws, which are
 * applied to the converted file. A flaw the template cannot carry is refused.
 */
export function splitFlaws(names, { bngService, stage }) {
  const legacy = [];
  const lineageFlawNames = [];
  const versionFlawNames = [];
  for (const name of names) {
    const flaw = BNG_SERVICE_FLAWS[name];
    if (bngService && LEGACY_ONLY_FLAWS.has(name)) {
      throw new FlawSelectionError(
        `Flaw "${name}" cannot be written in the BNG Service template (it has no Count column).`,
      );
    }
    if (!flaw) {
      legacy.push(name);
    } else if (!bngService) {
      throw new FlawSelectionError(
        `Flaw "${name}" is a BNG Service template flaw; add --format ${FORMAT_BNG_SERVICE}.`,
      );
    } else if (flaw.category === CATEGORY_LINEAGE) {
      lineageFlawNames.push(name);
    } else {
      versionFlawNames.push(name);
    }
  }
  assertBngServiceFlawsWritable(lineageFlawNames, versionFlawNames, stage);
  return { legacy, lineageFlawNames, versionFlawNames };
}

/**
 * Refuse a BNG Service flaw selection the file could not hold, so a file is
 * never named for a flaw it does not carry.
 */
function assertBngServiceFlawsWritable(
  lineageFlawNames,
  versionFlawNames,
  stage,
) {
  // As bng-library's partitionFlaws: each version flaw says what the whole
  // record is, and each lineage flaw restamps the same feature, so a second
  // of either would be named in the file but not written to it.
  if (versionFlawNames.length > 1) {
    throw new FlawSelectionError(
      `Only one template-version flaw at a time; got ${versionFlawNames.join(", ")}`,
    );
  }
  if (lineageFlawNames.length > 1) {
    throw new FlawSelectionError(
      `Only one lineage flaw at a time, as each restamps the same feature; got ${lineageFlawNames.join(", ")}`,
    );
  }
  // Each lineage flaw changes a post-intervention feature, and the
  // baseline-stage file leaves those tables empty.
  if (stage === STAGE_BASELINE && lineageFlawNames.length > 0) {
    throw new FlawSelectionError(
      `Lineage flaws change post-intervention features, which the baseline-stage file leaves empty; drop --stage ${STAGE_BASELINE}`,
    );
  }
}
