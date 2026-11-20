/**
 * The recipes for the corpus's Created area habitats left blank: files
 * derived from `valid/default-site.gpkg` with values a surveyor can leave
 * blank in QGIS on a Created habitat. Kept apart from recipes.mjs, which
 * lists them with the rest.
 */

import { setValues } from "./derive.mjs";

const HABITAT_REF = "Habitat Ref";
const RETENTION = "Retention Category";
const AREA_POST = "Area Habitats Post-Intervention";
const DEGRADE_REFUSED = "STAGED_HABITAT_DEGRADE_NOT_VALID";
// The default site's Created area habitat these fixtures leave blank.
const CREATED_AREA = "H005";
const CREATED_AREA_WHERE = {
  [HABITAT_REF]: CREATED_AREA,
  [RETENTION]: "Created",
};

/**
 * The Created area recipes, each built with recipes.mjs's `derived`;
 * `accepted` is its outcome for a file the service takes. Both are passed in
 * rather than imported, as recipes.mjs imports this module.
 */
export function createdAreaRecipes({ derived, accepted }) {
  return [
    derived(
      "incomplete/area-created-no-condition-or-timing.gpkg",
      `\`valid/default-site.gpkg\` with ${CREATED_AREA}, a Created area habitat, given no Proposed Condition, years created in advance or delay`,
      [
        setValues(
          AREA_POST,
          {
            "Proposed Condition": null,
            "Habitat created in advance/years": null,
            "Delay in starting habitat creation/years": null,
          },
          CREATED_AREA_WHERE,
        ),
      ],
      `${accepted}, ${CREATED_AREA} saved Incomplete, with no target condition to price it at`,
    ),
    derived(
      "attribute-problems/area-created-no-habitat-type.gpkg",
      `\`valid/default-site.gpkg\` with ${CREATED_AREA}, a Created area habitat linked to its parent, given no Proposed Broad Habitat Type, Habitat Type or Distinctiveness. The service reads a blank Proposed Habitat Type as the row's Baseline one, so it takes ${CREATED_AREA} as Created in its parent's own type, and holds it to the steps for a habitat that gets worse`,
      [
        setValues(
          AREA_POST,
          {
            "Proposed Broad Habitat Type": null,
            "Proposed Habitat Type": null,
            "Proposed Distinctiveness": null,
          },
          CREATED_AREA_WHERE,
        ),
      ],
      DEGRADE_REFUSED,
    ),
  ];
}
