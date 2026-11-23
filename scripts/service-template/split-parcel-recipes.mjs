/**
 * The recipes for the corpus's split area habitats: sites where baseline
 * parcels are split into parts linked to them, worse in part or with no part
 * worse. Kept apart from recipes.mjs, which lists them with the rest.
 */

// Few enough parcels to talk through, with three of them split.
const PARTLY_RETAINED_SITE = 15;
const PARTLY_RETAINED_PARCELS = 3;
// A site where parcels are split with no part getting worse: seed 1's
// 15-parcel site has two that can be enhanced from their condition.
const SPLIT_PARCEL_SITE = 15;
const SPLIT_PARCELS = 2;
// Every kind of habitat that gets worse a default site draws one of, set to
// none, so nothing on the split-parcel site gets worse.
const NOTHING_WORSE = {
  parcel: 0,
  vertical: 0,
  hedge: 0,
  "partly-worse-hedge": 0,
  "encroached-watercourse": 0,
  "worse-watercourse": 0,
};

/**
 * The split-parcel recipes, each built with recipes.mjs's `generated` from
 * its `seed`; `accepted` is their outcome. All three are passed in rather
 * than imported, as recipes.mjs imports this module.
 */
export function splitParcelRecipes({ generated, accepted, seed }) {
  return [
    generated(
      "valid/partly-retained-parcels.gpkg",
      `A ${PARTLY_RETAINED_SITE}-parcel site where ${PARTLY_RETAINED_PARCELS} baseline area habitats are only partly retained: each is split into a Retained part a and a part b Created in a worse condition, both linked to the baseline habitat`,
      accepted,
      {
        seed,
        numParcels: PARTLY_RETAINED_SITE,
        worseHabitatCounts: { "partly-worse-parcel": PARTLY_RETAINED_PARCELS },
      },
    ),
    generated(
      "valid/retained-enhanced-lost-parcels.gpkg",
      `A ${SPLIT_PARCEL_SITE}-parcel site where ${SPLIT_PARCELS} baseline area habitats are split with no part getting worse: each into a Retained part a, a part b Enhanced to a better condition in its own type, and a part c lost to development, Created as Developed land; sealed surface, all linked to the baseline habitat. Nothing else on the site gets worse`,
      accepted,
      {
        seed,
        numParcels: SPLIT_PARCEL_SITE,
        worseHabitatCounts: { ...NOTHING_WORSE, "split-parcel": SPLIT_PARCELS },
      },
    ),
  ];
}
