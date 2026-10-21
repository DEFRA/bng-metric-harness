/**
 * The SQL edits that turn a valid BNG Service file into an invalid-schema
 * fixture. Each helper returns an edit, a function of an open better-sqlite3
 * handle, so a recipe can list its edits as data. Every edit keeps the
 * GeoPackage's own registers (gpkg_contents, gpkg_geometry_columns) in step
 * with the table it changes, so a fixture breaks the template's schema and
 * nothing else.
 */

const GEOMETRY_COLUMN = "geom";

const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const escapeRegExp = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
