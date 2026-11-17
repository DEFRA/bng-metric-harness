/**
 * `--flaw` for the BNG Service format: split the selection into the legacy
 * flaws and the format's own lineage, degraded-habitat, site-change and
 * template-version flaws, and refuse a selection the file could not hold.
 *
 * Split out of `gen-gpkg.mjs` to keep that file within its size budget; it is
 * the CLI's only consumer.
 */

import {
  BNG_SERVICE_FLAWS,
  CATEGORY_CHANGE,
  CATEGORY_DEGRADE,
  CATEGORY_LINEAGE,
  CATEGORY_VERSION,
  FORMAT_BNG_SERVICE,
  FlawSelectionError,
  LEGACY_ONLY_FLAWS,
  STAGE_BASELINE,
} from "#bng-lib";

// Which list each BNG Service flaw category goes in.
const FLAW_LISTS = {
  [CATEGORY_LINEAGE]: "lineageFlawNames",
  [CATEGORY_DEGRADE]: "degradeFlawNames",
  [CATEGORY_CHANGE]: "changeFlawNames",
  [CATEGORY_VERSION]: "versionFlawNames",
};

/**
 * The list a BNG Service flaw of this category goes in. A category this CLI
 * does not know is refused, so a library that adds one fails loudly here
 * rather than having its flaws applied as some other kind.
 */
export function flawListFor(category, name) {
  const list = FLAW_LISTS[category];
  if (!list) {
    throw new FlawSelectionError(
      `Flaw "${name}" is of a BNG Service flaw category this CLI does not know ("${category}"); teach scripts/gen-gpkg-flaws.mjs about it.`,
    );
  }
  return list;
}

/**
 * Split --flaw into the legacy flaws, which the legacy generator draws, and
 * the BNG Service format's own lineage, degraded-habitat, site-change and
 * template-version flaws, which are applied to the converted file. A flaw the template cannot
 * carry is refused.
 */
export function splitFlaws(names, { bngService, stage }) {
  const legacy = [];
  const lists = {
    lineageFlawNames: [],
    degradeFlawNames: [],
    changeFlawNames: [],
    versionFlawNames: [],
  };
  for (const name of names) {
    const list = listOf(name, bngService);
    if (list) {
      lists[list].push(name);
    } else {
      legacy.push(name);
    }
  }
  assertBngServiceFlawsWritable(lists, stage);
  return { legacy, ...lists };
}

/**
 * The BNG Service list a flaw goes in, or null for a legacy flaw. A flaw the
 * template cannot carry, or a BNG Service flaw without the format, is refused.
 */
function listOf(name, bngService) {
  if (bngService && LEGACY_ONLY_FLAWS.has(name)) {
    throw new FlawSelectionError(
      `Flaw "${name}" cannot be written in the BNG Service template (it has no Count column).`,
    );
  }
  const flaw = BNG_SERVICE_FLAWS[name];
  if (!flaw) {
    return null;
  }
  if (!bngService) {
    throw new FlawSelectionError(
      `Flaw "${name}" is a BNG Service template flaw; add --format ${FORMAT_BNG_SERVICE}.`,
    );
  }
  return flawListFor(flaw.category, name);
}

/**
 * Refuse a site-change flaw on a site that cannot draw the change it breaks:
 * one with a geometric flaw or --bad, which draws the minimal bad fixture,
 * or with the rivers layer empty. bng-library refuses both too, but with a
 * plain error, after the output folder is cleared; refused here, the user
 * gets the CLI's message and nothing is touched.
 */
export function assertChangeFlawsDrawable(
  changeFlawNames,
  { geometricFlawNames = [], emptyLayers = new Set() },
) {
  if (changeFlawNames.length === 0) {
    return;
  }
  const names = changeFlawNames.join(", ");
  if (geometricFlawNames.length > 0) {
    throw new FlawSelectionError(
      `Site-change flaw ${names} breaks a change the default site draws, which a geometric flaw or --bad does not draw; drop the geometric flaw or --bad`,
    );
  }
  if (emptyLayers.has("rivers")) {
    throw new FlawSelectionError(
      `Site-change flaw ${names} breaks a watercourse change, which an empty rivers layer cannot hold; drop no-rivers`,
    );
  }
}

/** Refuse a second flaw of one kind, saying why where there is a reason. */
function assertOneAtATime(names, kind, reason = "") {
  if (names.length > 1) {
    throw new FlawSelectionError(
      `Only one ${kind} flaw at a time${reason}; got ${names.join(", ")}`,
    );
  }
}

/**
 * Refuse a flaw that changes post-intervention features on a baseline-stage
 * file, which leaves those tables empty.
 */
function assertPostInterventionStage(names, kinds, stage) {
  if (stage === STAGE_BASELINE && names.length > 0) {
    throw new FlawSelectionError(
      `${kinds} flaws change post-intervention features, which the baseline-stage file leaves empty; drop --stage ${STAGE_BASELINE}`,
    );
  }
}

/**
 * Refuse a BNG Service flaw selection the file could not hold, so a file is
 * never named for a flaw it does not carry.
 */
function assertBngServiceFlawsWritable(
  { lineageFlawNames, degradeFlawNames, changeFlawNames, versionFlawNames },
  stage,
) {
  // As bng-library's partitionFlaws: each version flaw says what the whole
  // record is, each lineage flaw restamps the same feature, and some degrade
  // flaws break the same row, so a second of any would be named in the file
  // but not written to it. It takes one site-change flaw at a time too.
  assertOneAtATime(versionFlawNames, "template-version");
  assertOneAtATime(
    lineageFlawNames,
    "lineage",
    ", as each restamps the same feature",
  );
  assertOneAtATime(
    degradeFlawNames,
    "degraded-habitat",
    ", as some break the same row",
  );
  assertOneAtATime(changeFlawNames, "site-change");
  assertPostInterventionStage(lineageFlawNames, "Lineage", stage);
  assertPostInterventionStage(degradeFlawNames, "Degraded-habitat", stage);
  assertPostInterventionStage(changeFlawNames, "Site-change", stage);
}
