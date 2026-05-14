/**
 * Pick-list constants and the precomputed `HABITATS` table used by both the
 * synthetic-mode generators and the --bad fixture.
 *
 * `HABITATS` is filtered to inland broad types (the synthetic site is land-
 * based, so coastal / intertidal / non-area types are excluded) and indexed
 * by broad type for proposed-habitat sampling.
 */

import { conditionScores as metricConditionScores } from "../data/metric-values-habitat-condition.mjs";
import { distinctivenessCategories as metricDistinctiveness } from "../data/metric-values-habitat-distinctiveness.mjs";

export const SITE_NAME = "Oakwood Regional Development";
export const SURVEY_DATE = "2025-06-15";
export const MAPPED_BY = "J. Smith";
export const SURVEY_COMPANY = "Ecological Consultants Ltd";
export const BASE_MAP = "OS MasterMap";
export const BAD_FIXTURE_SURVEY_DETAILS = "Bad-mode fixture";
export const TREE_TYPE_STREET = "Street tree";

// Synthetic-mode sizing rules. Scale linear features / trees off the parcel
// count with sensible floors so a small `--size` still produces a fixture
// with each layer represented.
export const MIN_HEDGEROW_COUNT = 3;
export const MIN_RIVER_COUNT = 1;
export const MIN_TREE_COUNT = 5;
export const HEDGEROW_PER_PARCEL_RATIO = 3;
export const RIVER_PER_PARCEL_RATIO = 15;
export const TREE_PER_PARCEL_RATIO = 2;
export const SYNTHETIC_RLB_RADIUS_M = 400;
export const LINE_FEATURE_REJECTION_BUDGET_FACTOR = 20;

// Restrict to inland broad types — fixture site is land-based, so coastal,
// intertidal, rocky-shore etc. are out of scope. Also skips any habitat the
// metric defines as non-area (e.g. "Individual trees", "Watercourse footprint",
// "Infrastructure (IGGI)"), which belong on other layers or aren't applicable.
const INLAND_BROAD_TYPES = new Set([
  "Cropland",
  "Grassland",
  "Heathland and shrub",
  "Lakes",
  "Sparsely vegetated land",
  "Urban",
  "Wetland",
  "Woodland and forest",
]);

const TYPE_NAME_SEPARATOR = " - ";
const TYPE_NAME_SEP_LENGTH = TYPE_NAME_SEPARATOR.length;

/** @type {{ fullName: string, broad: string, type: string, validConditions: string[], distinctiveness: string }[]} */
export const HABITATS = [];
export const HABITATS_BY_BROAD = {};

function tryParseInlandHabitat(fullName) {
  const sepIdx = fullName.indexOf(TYPE_NAME_SEPARATOR);
  if (sepIdx < 0) {
    return null;
  }
  const broad = fullName.slice(0, sepIdx);
  if (!INLAND_BROAD_TYPES.has(broad)) {
    return null;
  }
  const conds = metricConditionScores[fullName];
  if (!conds) {
    return null;
  }
  const validConditions = Object.entries(conds)
    .filter(([, v]) => typeof v === "number")
    .map(([k]) => k);
  if (validConditions.length === 0) {
    return null;
  }
  return {
    fullName,
    broad,
    type: fullName.slice(sepIdx + TYPE_NAME_SEP_LENGTH),
    validConditions,
    distinctiveness: metricDistinctiveness[fullName],
  };
}

for (const fullName of Object.keys(metricDistinctiveness)) {
  const habitat = tryParseInlandHabitat(fullName);
  if (!habitat) {
    continue;
  }
  HABITATS.push(habitat);
  if (!HABITATS_BY_BROAD[habitat.broad]) {
    HABITATS_BY_BROAD[habitat.broad] = [];
  }
  HABITATS_BY_BROAD[habitat.broad].push(habitat);
}

export const BROAD_HABITAT_TYPES = Object.keys(HABITATS_BY_BROAD);

// Hedgerows / Rivers / Urban Trees use their own metric tables; the prototype
// validates them separately. Until the same wiring is added for those layers,
// keep the generic enum lists used previously.
export const CONDITIONS = ["Good", "Fairly Good", "Moderate", "Fairly Poor", "Poor"];
export const DISTINCTIVENESS = ["V.High", "High", "Medium", "Low", "V.Low"];

export const STRATEGIC_SIGNIFICANCE = [
  "Formally identified in local strategy",
  "Location ecologically desirable but not in local strategy",
  "Area/compensation not in local strategy/ no local strategy",
];

export const RETENTION_CATEGORIES = ["Retained", "Enhanced", "Lost", "Created"];

export const LOCATIONS = ["On-site", "Off-site"];

export const SPATIAL_RISK_HABITAT = [
  "Compensation inside LPA boundary or NCA of impact site",
  "Compensation outside LPA or NCA of impact site, but in neighbouring LPA or NCA",
];

export const HEDGE_TYPES = [
  "Species-rich native hedgerow with trees",
  "Species-rich native hedgerow",
  "Native hedgerow with trees",
  "Native hedgerow",
  "Native hedgerow - associated with bank or ditch",
  "Line of trees",
  "Non-native and ornamental hedgerow",
];

export const HEDGE_CONDITIONS = ["Good", "Moderate", "Poor"];

export const RIVER_TYPES = [
  "Priority habitat",
  "Other rivers and streams",
  "Ditches",
  "Canals",
  "Culvert",
];

export const ENCROACHMENT_WATERCOURSE = ["No Encroachment", "Minor", "Major"];

export const ENCROACHMENT_RIPARIAN = [
  "Major/Major",
  "Major/Moderate",
  "Moderate/Moderate",
  "Minor/Minor",
  "Minor/No Encroachment",
  "No Encroachment/No Encroachment",
];

export const SPATIAL_RISK_RIVER = [
  "Within waterbody catchment",
  "Outside waterbody catchment, but within operational catchment",
];
