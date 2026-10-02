// GeoPackage layer and reference-column names shared by the harness scripts,
// kept in one place so they cannot drift apart. They mirror the schema that
// bng-library creates (src/bng-schema.mjs), which does not export them.

export const LAYER_URBAN_TREES = "Urban Trees";

export const COL_PARCEL_REF = "Parcel Ref";
export const COL_TREE_REF = "Tree Ref";

/** Every layer keys its features by "Parcel Ref" except individual trees. */
export function refColumnFor(layer) {
  return layer === LAYER_URBAN_TREES ? COL_TREE_REF : COL_PARCEL_REF;
}
