/**
 * @bng/gpkg-io — generic GeoPackage I/O.
 *
 * Schema-agnostic and SRS-agnostic. Domain code (BNG-specific table DDL,
 * SRS choice, layer colours) lives outside this package.
 */

export {
  encodeWkbPoint,
  encodeWkbLineString,
  encodeWkbPolygon,
  encodeGpkgBinary,
  envelopeFromCoords,
  expandEnvelope,
  gpkgLineString,
  gpkgPoint,
  gpkgPolygon,
} from "./src/wkb.mjs";

export { REQUIRED_SRS, initGeoPackage, openGeoPackage, registerLayer } from "./src/init.mjs";

export {
  createLayerStylesTable,
  insertLayerStyle,
  lineQml,
  lineSld,
  pointQml,
  pointSld,
  polygonQml,
  polygonSld,
} from "./src/styles.mjs";

export { filledArray, placeholders } from "./src/sql.mjs";
