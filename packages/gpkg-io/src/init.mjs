/**
 * GeoPackage metadata-table initialisation and feature-layer registration.
 * SRS-agnostic: callers pass in their own SRS definitions and the srsId to
 * tag each layer with.
 *
 * Two entry points:
 *   - `openGeoPackage(filename, opts)` — opens a fresh file and inits it
 *   - `initGeoPackage(db, extraSrs)`   — inits an already-open handle
 */

import Database from "better-sqlite3";

/**
 * @typedef {object} SrsRow
 * @property {number} srsId
 * @property {string} name
 * @property {string} organization
 * @property {number} organizationCoordsysId
 * @property {string} definition
 * @property {string} [description]
 */

/**
 * The mandatory SRSes per OGC GeoPackage spec: an undefined cartesian system,
 * an undefined geographic system, and WGS 84.
 *
 * @see https://www.geopackage.org/spec/#_requirement-11
 *
 * @type {SrsRow[]}
 */
export const REQUIRED_SRS = [
  {
    srsId: -1,
    name: "Undefined cartesian SRS",
    organization: "NONE",
    organizationCoordsysId: -1,
    definition: "undefined",
    description: "undefined cartesian coordinate reference system",
  },
  {
    srsId: 0,
    name: "Undefined geographic SRS",
    organization: "NONE",
    organizationCoordsysId: 0,
    definition: "undefined",
    description: "undefined geographic coordinate reference system",
  },
  {
    srsId: 4326,
    name: "WGS 84 geodetic",
    organization: "EPSG",
    organizationCoordsysId: 4326,
    definition:
      'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]',
    description: "longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid",
  },
];

/**
 * Initialise a SQLite database as a valid GeoPackage by setting the required
 * pragmas and creating the three mandatory metadata tables (gpkg_spatial_
 * ref_sys, gpkg_contents, gpkg_geometry_columns). The mandatory SRSes are
 * always inserted; pass `extraSrs` to add additional SRS rows (e.g. a
 * national grid).
 *
 * @see https://www.geopackage.org/spec/#_requirement-1
 *
 * @param {object}   db          better-sqlite3 Database handle
 * @param {SrsRow[]} [extraSrs]  additional SRS rows beyond the OGC-mandatory
 *                               three (-1, 0, 4326)
 */
export function initGeoPackage(db, extraSrs = []) {
  db.pragma("journal_mode = WAL");
  db.pragma("application_id = 0x47504B47");
  db.pragma("user_version = 10301");

  db.exec(`
    CREATE TABLE IF NOT EXISTS gpkg_spatial_ref_sys (
      srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY,
      organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
      definition TEXT NOT NULL, description TEXT
    );

    CREATE TABLE IF NOT EXISTS gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL DEFAULT 'features',
      identifier TEXT UNIQUE, description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE,
      srs_id INTEGER REFERENCES gpkg_spatial_ref_sys(srs_id)
    );

    CREATE TABLE IF NOT EXISTS gpkg_geometry_columns (
      table_name TEXT NOT NULL, column_name TEXT NOT NULL DEFAULT 'geometry',
      geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL,
      z TINYINT NOT NULL DEFAULT 0, m TINYINT NOT NULL DEFAULT 0,
      CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
      CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name)
    );
  `);

  const insertSrs = db.prepare(`
    INSERT OR IGNORE INTO gpkg_spatial_ref_sys
      (srs_name, srs_id, organization, organization_coordsys_id, definition, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const srs of [...REQUIRED_SRS, ...extraSrs]) {
    insertSrs.run(
      srs.name,
      srs.srsId,
      srs.organization,
      srs.organizationCoordsysId,
      srs.definition,
      srs.description ?? "",
    );
  }
}

/**
 * Register a feature layer in the GeoPackage metadata tables. Inserts (or
 * replaces) rows in `gpkg_contents` and `gpkg_geometry_columns` so that GIS
 * tools recognise the table as a spatial layer.
 *
 * @param {object} db                  better-sqlite3 Database handle
 * @param {string} tableName
 * @param {string} geomType            'POINT' | 'LINESTRING' | 'POLYGON' | …
 * @param {number[]|null} envelope     [minX, maxX, minY, maxY] or null
 * @param {number} srsId
 */
export function registerLayer(db, tableName, geomType, envelope, srsId) {
  const [minX = null, maxX = null, minY = null, maxY = null] = envelope ?? [];

  db.prepare(
    `
    INSERT OR REPLACE INTO gpkg_contents
      (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id)
    VALUES (?, 'features', ?, '', ?, ?, ?, ?, ?)
  `,
  ).run(tableName, tableName, minX, minY, maxX, maxY, srsId);

  db.prepare(
    `
    INSERT OR REPLACE INTO gpkg_geometry_columns
      (table_name, column_name, geometry_type_name, srs_id, z, m)
    VALUES (?, 'geometry', ?, ?, 0, 0)
  `,
  ).run(tableName, geomType, srsId);
}

/**
 * Open (or create) `filename` as a GeoPackage and initialise its metadata
 * tables. Returns the better-sqlite3 db handle; the caller is responsible
 * for `db.close()`.
 *
 * For read-only access to an existing GeoPackage, use
 * `openGeoPackageReadonly` instead — it skips the metadata-init writes
 * that would otherwise conflict with the readonly flag.
 *
 * @param {string} filename
 * @param {object} [opts]
 * @param {SrsRow[]} [opts.srs]   extra SRS rows beyond the OGC-mandatory
 *                                three (-1, 0, 4326)
 * @returns {import('better-sqlite3').Database}
 */
export function openGeoPackage(filename, { srs = [] } = {}) {
  const db = new Database(filename);
  initGeoPackage(db, srs);
  return db;
}

/**
 * Open an existing GeoPackage read-only for querying. No metadata-table
 * writes are performed. Caller is responsible for `db.close()`.
 *
 * @param {string} filename
 * @returns {import('better-sqlite3').Database}
 */
export function openGeoPackageReadonly(filename) {
  return new Database(filename, { readonly: true });
}
