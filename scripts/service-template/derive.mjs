/**
 * The SQL edits that turn a valid BNG Service file into a fixture no
 * generator writes: an invalid-schema file, or one value changed, one row
 * left out or one row added. Each helper returns an edit, a function of an open better-sqlite3
 * handle, so a recipe can list its edits as data. Every edit keeps the
 * GeoPackage's own registers (gpkg_contents, gpkg_geometry_columns) in step
 * with the table it changes, so a fixture changes only what its recipe
 * names.
 */

import { TEMPLATE_SOURCE } from "#bng-lib";
import { wkbToGeoJSON } from "#gpkg-io";

const GEOMETRY_COLUMN = "geom";

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const escapeRegExp = (text) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

function tableSql(db, table) {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!row) {
    throw new Error(`no table "${table}" to edit`);
  }
  return row.sql;
}

/**
 * Rebuild a table with its columns declared as `types` says, keeping every
 * row: SQLite cannot change a column's declared type in place.
 */
function rebuildWithTypes(db, table, types) {
  let sql = tableSql(db, table);
  for (const [column, type] of Object.entries(types)) {
    const declared = new RegExp(`${escapeRegExp(quote(column))} [A-Z]+`);
    if (!declared.test(sql)) {
      throw new Error(`no column "${column}" in "${table}" to retype`);
    }
    sql = sql.replace(declared, `${quote(column)} ${type}`);
  }
  const rebuilt = `${table} (rebuilt)`;
  db.exec(sql.replace(quote(table), quote(rebuilt)));
  db.exec(`INSERT INTO ${quote(rebuilt)} SELECT * FROM ${quote(table)}`);
  db.exec(`DROP TABLE ${quote(table)}`);
  db.exec(`ALTER TABLE ${quote(rebuilt)} RENAME TO ${quote(table)}`);
}

/** Drop a table and its entries in the GeoPackage's registers. */
export const dropTable = (table) => (db) => {
  db.exec(`DROP TABLE ${quote(table)}`);
  for (const register of [
    "gpkg_geometry_columns",
    "gpkg_extensions",
    "gpkg_contents",
  ]) {
    db.prepare(`DELETE FROM ${register} WHERE table_name = ?`).run(table);
  }
};

/** Drop every table of one stage, such as all the Post-Intervention tables. */
export const dropStage = (stage) => (db) => {
  const tables = db
    .prepare(
      "SELECT table_name FROM gpkg_contents WHERE table_name LIKE ? ORDER BY table_name",
    )
    .all(`% ${stage}`)
    .map((row) => row.table_name);
  for (const table of tables) {
    dropTable(table)(db);
  }
};

export const dropColumns = (table, columns) => (db) => {
  for (const column of columns) {
    db.exec(`ALTER TABLE ${quote(table)} DROP COLUMN ${quote(column)}`);
  }
};

/** Rename columns, following the geometry column in its register. */
export const renameColumns = (table, renames) => (db) => {
  for (const [from, to] of Object.entries(renames)) {
    db.exec(
      `ALTER TABLE ${quote(table)} RENAME COLUMN ${quote(from)} TO ${quote(to)}`,
    );
    db.prepare(
      "UPDATE gpkg_geometry_columns SET column_name = ? WHERE table_name = ? AND column_name = ?",
    ).run(to, table, from);
  }
};

/** Declare columns with other SQLite types, keeping their values. */
export const retypeColumns = (table, types) => (db) => {
  rebuildWithTypes(db, table, types);
};

/** Declare the geometry column a geometry type the template does not use. */
export const setGeometryType = (table, type) => (db) => {
  rebuildWithTypes(db, table, { [GEOMETRY_COLUMN]: type });
  db.prepare(
    "UPDATE gpkg_geometry_columns SET geometry_type_name = ? WHERE table_name = ?",
  ).run(type, table);
};

/** Register a layer in another spatial reference system. */
export const setSrs = (table, srsId) => (db) => {
  for (const register of ["gpkg_geometry_columns", "gpkg_contents"]) {
    db.prepare(`UPDATE ${register} SET srs_id = ? WHERE table_name = ?`).run(
      srsId,
      table,
    );
  }
};

/** Drop a layer's geometry column, and its register entry. */
export const dropGeometryColumn = (table) => (db) => {
  dropColumns(table, [GEOMETRY_COLUMN])(db);
  db.prepare("DELETE FROM gpkg_geometry_columns WHERE table_name = ?").run(
    table,
  );
};

/** Add and register a second geometry column, left empty. */
export const addGeometryColumn = (table, column, type) => (db) => {
  db.exec(`ALTER TABLE ${quote(table)} ADD COLUMN ${quote(column)} ${type}`);
  const { srs_id: srsId } = db
    .prepare("SELECT srs_id FROM gpkg_geometry_columns WHERE table_name = ?")
    .get(table);
  db.prepare(
    "INSERT INTO gpkg_geometry_columns (table_name, column_name, geometry_type_name, srs_id, z, m) VALUES (?, ?, ?, ?, 0, 0)",
  ).run(table, column, type, srsId);
};

/** The WHERE clause and its values that match every column of `where`. */
function matching(where) {
  const columns = Object.keys(where);
  if (columns.length === 0) {
    throw new Error("an edit to rows must say which rows it edits");
  }
  return {
    clause: columns.map((column) => `${quote(column)} = ?`).join(" AND "),
    values: Object.values(where),
  };
}

/** Run a row edit, failing where it matches no row, so a stale recipe shows. */
function runOnRows(db, table, sql, values) {
  const { changes } = db.prepare(sql).run(...values);
  if (changes === 0) {
    throw new Error(`no row of "${table}" matches the edit`);
  }
}

/** Set columns of the rows whose columns hold the values `where` names. */
export const setValues = (table, values, where) => (db) => {
  const assignments = Object.keys(values)
    .map((column) => `${quote(column)} = ?`)
    .join(", ");
  const match = matching(where);
  runOnRows(
    db,
    table,
    `UPDATE ${quote(table)} SET ${assignments} WHERE ${match.clause}`,
    [...Object.values(values), ...match.values],
  );
};

/** Delete the rows whose columns hold the values `where` names. */
export const deleteRows = (table, where) => (db) => {
  const match = matching(where);
  runOnRows(
    db,
    table,
    `DELETE FROM ${quote(table)} WHERE ${match.clause}`,
    match.values,
  );
};

/** The one row of `table` that `where` matches; fails on none or several. */
function oneRow(db, table, where) {
  const match = matching(where);
  const rows = db
    .prepare(`SELECT * FROM ${quote(table)} WHERE ${match.clause}`)
    .all(...match.values);
  if (rows.length !== 1) {
    throw new Error(
      `${rows.length} rows of "${table}" match the edit, where it needs one`,
    );
  }
  return rows[0];
}

/**
 * Add a copy of the one row `where` matches, with the columns `values` names
 * set, under a new fid: a second point where the template has one.
 */
export const copyRow = (table, where, values) => (db) => {
  const { fid, ...row } = oneRow(db, table, where);
  const copy = { ...row, ...values };
  const columns = Object.keys(copy);
  db.prepare(
    `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...Object.values(copy));
};

// parent_geom is WKT to three decimal places, a millimetre, as the template
// writes it.
const WKT_DECIMALS = 3;

/** A point's GeoPackage geometry as the template writes its parent_geom. */
function pointWkt(blob) {
  const geometry = wkbToGeoJSON(blob);
  if (geometry.type !== "Point") {
    throw new Error(`no parent_geom for a ${geometry.type}`);
  }
  const [x, y] = geometry.coordinates;
  return `POINT (${x.toFixed(WKT_DECIMALS)} ${y.toFixed(WKT_DECIMALS)})`;
}

/**
 * Link the rows `where` matches to the one point of `parentTable` that
 * `parentWhere` matches, as the template links a post-intervention row: by
 * Parent Ref, parent_uuid and parent_geom. `copied` maps a column of the
 * parent to the row's column that takes its value (the Baseline columns, or
 * `geom` to place the row on its parent).
 */
export const linkToParent =
  (table, where, parentTable, parentWhere, copied = {}) =>
  (db) => {
    const parent = oneRow(db, parentTable, parentWhere);
    const values = {
      "Parent Ref": parent["Habitat Ref"],
      parent_uuid: parent.feature_uuid,
      parent_geom: pointWkt(parent[GEOMETRY_COLUMN]),
    };
    for (const [from, to] of Object.entries(copied)) {
      values[to] = parent[from];
    }
    setValues(table, values, where)(db);
  };

/**
 * Replace the text of the template version record, found as the service
 * finds it: by the standard URI bng-library writes it under, not by its
 * scope, which any other metadata row may share.
 */
export const setVersionRecord = (metadata) => (db) => {
  runOnRows(
    db,
    "gpkg_metadata",
    "UPDATE gpkg_metadata SET metadata = ? WHERE md_standard_uri = ?",
    [metadata, TEMPLATE_SOURCE.metadataUri],
  );
};
