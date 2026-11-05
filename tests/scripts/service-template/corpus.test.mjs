import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  CONDITIONS,
  FORMAT_BNG_SERVICE,
  checkLineage,
  checkTemplateValues,
  listFlaws,
  readVersionRecords,
} from "#bng-lib";
import { polygonAreaSqm, wkbToGeoJSON } from "#gpkg-io";
import { checkFile } from "../../../scripts/lineage-check.mjs";
import {
  buildRecipe,
  familyFiles,
  removeStaleFiles,
  sameFixture,
} from "../../../scripts/service-template/build.mjs";
import {
  CONVERTER_COMMIT,
  TEMPLATE_DIR_ENV,
  converterProblem,
  describeTemplateCommit,
  templateCommit,
} from "../../../scripts/service-template/convert.mjs";
import { renderReadme } from "../../../scripts/service-template/readme.mjs";
import {
  FAMILIES,
  KIND_CONVERTED,
  KIND_DERIVED,
  KIND_GENERATED,
  RECIPES,
  recipeFor,
} from "../../../scripts/service-template/recipes.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const CORPUS = path.join(ROOT, "example-files/service-template");
const GENERATE = path.join(ROOT, "scripts/gen-service-template.mjs");
const NOT_A_GEOPACKAGE = "malformed/not-a-geopackage.gpkg";
const LEGACY_LAYOUT = "invalid-schema/legacy-template.gpkg";

// The bng-500/ files are checked where REQUIRE_CONVERTER is "true", as CI
// sets it with the template cloned at CONVERTER_COMMIT: that is what holds
// the committed files to the pinned converter. Elsewhere they are skipped,
// as a local template checkout may be at another commit.
const CHECK_CONVERTED = process.env.REQUIRE_CONVERTER === "true";
const CONVERTER_PROBLEM = CHECK_CONVERTED ? converterProblem() : null;
if (CONVERTER_PROBLEM) {
  throw new Error(`REQUIRE_CONVERTER is set, but ${CONVERTER_PROBLEM}`);
}
// A checkout at another commit would fail the byte-for-byte test on every
// bng-500/ file; say why instead.
const TEMPLATE_AT = CHECK_CONVERTED ? describeTemplateCommit() : null;
if (TEMPLATE_AT && !TEMPLATE_AT.pinned) {
  throw new Error(
    `REQUIRE_CONVERTER is set, but the converter is ${TEMPLATE_AT.text}`,
  );
}
const CONVERTED = RECIPES.filter((r) => r.kind === KIND_CONVERTED);
const BUILDABLE = CHECK_CONVERTED
  ? RECIPES
  : RECIPES.filter((r) => r.kind !== KIND_CONVERTED);

let outDir;
// Inside the harness, as --outdir must be; test-data/ is gitignored.
beforeAll(() => {
  const testData = path.join(ROOT, "test-data");
  mkdirSync(testData, { recursive: true });
  outDir = mkdtempSync(path.join(testData, "service-template-"));
  for (const recipe of BUILDABLE) {
    buildRecipe(recipe, outDir);
  }
});
afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

const built = (recipe) => path.join(outDir, recipe.path);

function versionRecords(file) {
  const db = new Database(file, { readonly: true });
  try {
    return readVersionRecords(db);
  } finally {
    db.close();
  }
}

function tableNames(file) {
  const db = new Database(file, { readonly: true });
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

describe("the service-template recipes", () => {
  it("name each file once, inside one of the families", () => {
    const paths = RECIPES.map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
    const dirs = new Set(FAMILIES.map((f) => f.dir));
    for (const recipePath of paths) {
      expect(dirs.has(recipePath.split("/")[0])).toBe(true);
    }
  });

  it("build a fixture for every BNG Service flaw bng-library writes", () => {
    const covered = new Set(RECIPES.flatMap((r) => r.options?.flaws ?? []));
    const missing = listFlaws({ format: FORMAT_BNG_SERVICE })
      .map((f) => f.name)
      .filter((name) => !covered.has(name));
    expect(missing).toEqual([]);
  });

  it("derive only from a generated recipe", () => {
    for (const recipe of RECIPES.filter((r) => r.kind === KIND_DERIVED)) {
      expect(recipeFor(recipe.from).kind).toBe("generated");
    }
  });
});

describe("the committed service-template corpus", () => {
  it("is exactly what the recipes build, byte for byte (AC2)", () => {
    const differ = BUILDABLE.filter((recipe) => {
      const committed = path.join(CORPUS, recipe.path);
      return (
        !existsSync(committed) ||
        !sameFixture(readFileSync(committed), readFileSync(built(recipe)))
      );
    }).map((r) => r.path);
    expect(
      differ,
      "Regenerate the corpus with `npm run generate:service-template` and commit it, if the change is meant (a bng-library repin, or a SQLite upgrade that changes how files are laid out)",
    ).toEqual([]);
  });

  it("holds no file a recipe does not build", () => {
    const known = new Set(RECIPES.map((r) => r.path));
    expect(familyFiles(CORPUS).filter((f) => !known.has(f))).toEqual([]);
  });

  it("has the README the recipes write", () => {
    expect(readFileSync(path.join(CORPUS, "README.md"), "utf8")).toBe(
      renderReadme(),
    );
  });
});

// The units of each layer's Area, checked against the geometry rather than
// the generator, so a pin that wrote the wrong unit, and a corpus rebuilt
// from it, would still fail (BMD-1084). An area habitat's Area is its
// polygon's area in hectares. A vertical area habitat's is the area the
// surveyor typed in, also in hectares, so in square metres it is its line's
// length times a wall height: typed in square metres it would be ten
// thousand times too large.
const SQ_METRES_PER_HECTARE = 10_000;
// bng-500/'s converter rounds Area to 4 decimal places of a hectare: a
// square metre, so up to half of one either way. A wrong unit is out by a
// factor of ten thousand.
const AREA_TOLERANCE_SQ_M = 0.5 + 1e-6;
const MIN_WALL_HEIGHT_M = 1;
const MAX_WALL_HEIGHT_M = 50;
const STAGES = ["Baseline", "Post-Intervention"];

function lineLength(coordinates) {
  return coordinates
    .slice(1)
    .reduce(
      (sum, [x, y], i) =>
        sum + Math.hypot(x - coordinates[i][0], y - coordinates[i][1]),
      0,
    );
}

/**
 * Every row of a layer, at both stages, across the corpus, with its file.
 * The malformed and invalid-schema fixtures are broken on purpose: a file
 * SQLite cannot read, or a table without an Area or geometry column, holds
 * no area to check.
 */
function corpusRows(layer) {
  return familyFiles(CORPUS).flatMap((file) => {
    const db = new Database(path.join(CORPUS, file), { readonly: true });
    try {
      return STAGES.map((stage) => `${layer} ${stage}`).flatMap((table) => {
        const columns = new Set(
          db
            .prepare(`PRAGMA table_info("${table}")`)
            .all()
            .map((c) => c.name),
        );
        if (!columns.has("Area") || !columns.has("geom")) {
          return [];
        }
        return db
          .prepare(
            `SELECT "Habitat Ref" AS ref, Area AS area, geom FROM "${table}"`,
          )
          .all()
          .map((row) => ({ file, table, ...row }));
      });
    } catch (error) {
      if (error.code === "SQLITE_NOTADB") {
        return [];
      }
      throw error;
    } finally {
      db.close();
    }
  });
}

describe("the committed service-template corpus's areas", () => {
  it("gives each area habitat its polygon's area in hectares", () => {
    const rows = corpusRows("Area Habitats").filter(
      (r) => r.geom && typeof r.area === "number",
    );
    const wrong = rows
      .map((r) => ({ ...r, sqm: polygonAreaSqm(wkbToGeoJSON(r.geom)) }))
      // A shape with no area (a bowtie) is a geometry flaw, not a unit.
      .filter((r) => r.sqm > 0)
      .filter(
        (r) =>
          Math.abs(r.area * SQ_METRES_PER_HECTARE - r.sqm) >
          AREA_TOLERANCE_SQ_M,
      )
      .map((r) => `${r.file} ${r.table} ${r.ref}: ${r.area}`);
    expect(rows.length).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });

  it("gives each vertical area habitat its typed area in hectares", () => {
    const rows = corpusRows("Vertical Area Habitats").filter(
      (r) => r.geom && typeof r.area === "number",
    );
    const wrong = rows
      // A line of any other kind has no length lineLength can measure, and
      // a height that is not a number passes every comparison, so both fail.
      .filter((r) => {
        const geometry = wkbToGeoJSON(r.geom);
        if (geometry.type !== "LineString") {
          return true;
        }
        const height =
          (r.area * SQ_METRES_PER_HECTARE) / lineLength(geometry.coordinates);
        return (
          !Number.isFinite(height) ||
          height < MIN_WALL_HEIGHT_M ||
          height > MAX_WALL_HEIGHT_M
        );
      })
      .map((r) => `${r.file} ${r.table} ${r.ref}: ${r.area}`);
    expect(rows.length).toBeGreaterThan(0);
    expect(wrong).toEqual([]);
  });

  // DEFRA/bng-library#126 moved this from 0.009332 (hectares) to 93 (square
  // metres); DEFRA/bng-library#132 back to hectares, at the same 93 m².
  it.each(STAGES)(
    "holds V001 at 0.0093 ha (93 m²) in valid/default-site.gpkg's %s table",
    (stage) => {
      const db = new Database(path.join(CORPUS, "valid/default-site.gpkg"), {
        readonly: true,
      });
      try {
        expect(
          db
            .prepare(
              `SELECT Area AS area FROM "Vertical Area Habitats ${stage}" WHERE "Habitat Ref" = 'V001'`,
            )
            .get().area,
        ).toBe(0.0093);
      } finally {
        db.close();
      }
    },
  );
});

const IRREPLACEABLE = "Irreplaceable Habitat";
const YES = "Yes";
// The tables each layer bng-library's irreplaceableLayers names is on.
const LAYER_TABLES = {
  habitats: ["Area Habitats Baseline", "Area Habitats Post-Intervention"],
  trees: ["Individual Trees Baseline", "Individual Trees Post-Intervention"],
};

/** The feature tables of `file` that hold a row marked irreplaceable. */
function irreplaceableTables(file) {
  const db = new Database(file, { readonly: true });
  try {
    const tables = db
      .prepare(
        "SELECT table_name AS name FROM gpkg_contents WHERE data_type = 'features'",
      )
      .all()
      .map((row) => row.name);
    return tables.filter((table) => {
      const columns = db.pragma(`table_info("${table}")`).map((c) => c.name);
      return (
        columns.includes(IRREPLACEABLE) &&
        db
          .prepare(`SELECT 1 FROM "${table}" WHERE "${IRREPLACEABLE}" = ?`)
          .get(YES) !== undefined
      );
    });
  } finally {
    db.close();
  }
}

const THIRTY_PLUS = "30+";
const ADVANCE = "Habitat created in advance/years";
const DELAY = "Delay in starting habitat creation/years";
// Each post-intervention table, with its advance and delay columns.
const TIMING_COLUMNS = {
  "Area Habitats Post-Intervention": [ADVANCE, DELAY],
  "Hedgerows Post-Intervention": [ADVANCE, DELAY],
  "Watercourses Post-Intervention": [ADVANCE, DELAY],
  "Vertical Area Habitats Post-Intervention": [ADVANCE, DELAY],
  "Individual Trees Post-Intervention": [
    "Habitat Created/Enhanced in advance/years",
    "Delay in starting habitat creation/enhancement in years",
  ],
};

/** The rows of each post-intervention table of `file` delayed by 30+ years. */
function thirtyPlusDelays(file) {
  const db = new Database(file, { readonly: true });
  try {
    return Object.fromEntries(
      Object.entries(TIMING_COLUMNS).map(([table, [advance, delay]]) => {
        const rows = db
          .prepare(
            `SELECT "Retention Category" AS retention, "${advance}" AS advance FROM "${table}" WHERE "${delay}" = ?`,
          )
          .all(THIRTY_PLUS);
        return [table, rows];
      }),
    );
  } finally {
    db.close();
  }
}

/** The irreplaceableLayers a generated or derived recipe's file is drawn with. */
function irreplaceableLayersOf(recipe) {
  const source = recipe.kind === KIND_DERIVED ? recipeFor(recipe.from) : recipe;
  return source.options.irreplaceableLayers;
}

describe("the built fixtures", () => {
  // A repin that ignored or renamed irreplaceableLayers would rebuild the
  // corpus to match itself, so the byte-for-byte test alone would not see it.
  it("mark a habitat irreplaceable only in the files whose recipe names its layer, in both stages", () => {
    const drawn = BUILDABLE.filter(
      (r) => r.kind === KIND_GENERATED || r.kind === KIND_DERIVED,
    );
    for (const recipe of drawn) {
      const expected = irreplaceableLayersOf(recipe).flatMap(
        (layer) => LAYER_TABLES[layer],
      );
      expect(irreplaceableTables(built(recipe)).sort(), recipe.path).toEqual(
        expected.sort(),
      );
    }
    const marked = drawn.filter((r) => irreplaceableLayersOf(r).length > 0);
    expect(marked.map((r) => r.path).sort()).toEqual([
      "attribute-problems/irreplaceable-area-habitat.gpkg",
      "attribute-problems/irreplaceable-tree.gpkg",
    ]);
  });

  // As for irreplaceableLayers: a repin that dropped the 30+ delay would
  // rebuild the corpus without it, and the byte-for-byte test would pass.
  it("delay a Created or Enhanced habitat by 30+ years on each layer of the default site, its advance blank", () => {
    const delays = thirtyPlusDelays(
      built(recipeFor("valid/default-site.gpkg")),
    );
    for (const [table, rows] of Object.entries(delays)) {
      expect(rows.length, table).toBeGreaterThanOrEqual(1);
      for (const row of rows) {
        expect(["Created", "Enhanced"], table).toContain(row.retention);
        expect(row.advance, table).toBeNull();
      }
    }
  });

  it("hold only values the template offers, in every valid file", () => {
    for (const recipe of RECIPES.filter((r) => r.path.startsWith("valid/"))) {
      expect(checkTemplateValues(built(recipe)), recipe.path).toEqual([]);
    }
  });

  it("pass the lineage check, each lineage flaw file with its own flaw (AC3)", () => {
    const checked = BUILDABLE.filter(
      (r) =>
        r.kind !== KIND_CONVERTED &&
        ![NOT_A_GEOPACKAGE, LEGACY_LAYOUT].includes(r.path),
    );
    for (const recipe of checked) {
      const result = checkFile(built(recipe));
      expect(result.status, recipe.path).not.toBe("fail");
    }
    for (const recipe of RECIPES.filter((r) =>
      r.path.startsWith("lineage-problems/"),
    )) {
      const result = checkFile(built(recipe));
      expect(result.expected, recipe.path).toBeTruthy();
      expect(result.status, recipe.path).toBe("pass");
    }
  });

  it("give each version fixture the version records its flaw names", () => {
    const records = (name) =>
      versionRecords(built(recipeFor(`version-problems/${name}.gpkg`)));
    expect(records("version-record-missing")).toHaveLength(0);
    expect(records("version-record-duplicated")).toHaveLength(2);
    expect(records("version-unsupported")).toHaveLength(1);
    expect(records("version-record-invalid")).toEqual([
      { format: FORMAT_BNG_SERVICE },
    ]);
    expect(
      versionRecords(built(recipeFor("valid/default-site.gpkg"))),
    ).toHaveLength(1);
  });

  it("drop the tables an invalid-schema edit names, and nothing else", () => {
    const valid = tableNames(built(recipeFor("valid/default-site.gpkg")));
    const noArea = tableNames(
      built(recipeFor("invalid-schema/no-area-habitats-baseline-table.gpkg")),
    );
    expect(valid.filter((t) => !noArea.includes(t))).toEqual([
      "Area Habitats Baseline",
    ]);
    const noPost = tableNames(
      built(recipeFor("invalid-schema/no-post-intervention-tables.gpkg")),
    );
    expect(noPost.some((t) => t.endsWith("Post-Intervention"))).toBe(false);
    expect(noPost).toContain("Area Habitats Baseline");
  });

  it("declare the geometry type an invalid-schema edit names", () => {
    const db = new Database(
      built(recipeFor("invalid-schema/wrong-geometry-type-in-hedgerows.gpkg")),
      { readonly: true },
    );
    try {
      expect(
        db
          .prepare(
            "SELECT geometry_type_name AS type FROM gpkg_geometry_columns WHERE table_name = 'Hedgerows Baseline'",
          )
          .get().type,
      ).toBe("POLYGON");
      expect(
        db
          .prepare("SELECT sql FROM sqlite_master WHERE name = ?")
          .get("Hedgerows Baseline").sql,
      ).toContain('"geom" POLYGON');
      expect(
        db.prepare('SELECT count(*) AS n FROM "Hedgerows Baseline"').get().n,
      ).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("keep the filename fixture byte for byte the file it copies", () => {
    expect(
      readFileSync(
        built(recipeFor("filename-problems/default site [invalid chars].gpkg")),
      ).equals(readFileSync(built(recipeFor("valid/default-site.gpkg")))),
    ).toBe(true);
  });
});

/** The rows `sql` selects from `file`. */
function query(file, sql, ...params) {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

const DEFAULT_SITE = "valid/default-site.gpkg";
const builtAt = (recipePath) => built(recipeFor(recipePath));

/** A habitat's baseline row and its post-intervention rows, by Habitat Ref. */
function habitat(file, layer, ref) {
  const [baseline] = query(
    file,
    `SELECT * FROM "${layer} Baseline" WHERE "Habitat Ref" = ?`,
    ref,
  );
  const post = query(
    file,
    `SELECT * FROM "${layer} Post-Intervention" WHERE "Habitat Ref" = ? OR parent_uuid = ?`,
    ref,
    baseline?.feature_uuid ?? null,
  );
  return { baseline, post };
}

// The SQL edits fail only where no row matches. A bng-library repin that
// kept the rows but changed what they show (a habitat that no longer gets
// worse, a culvert drawn as a ditch) would rebuild each fixture to match
// itself, so these check the facts each recipe relies on, in the file built.
describe("the fixtures derived for QA's BMD-1086 scenarios", () => {
  it.each([
    [
      "attribute-problems/degrade-area-advance-missing.gpkg",
      "Area Habitats",
      "H043",
    ],
    [
      "attribute-problems/degrade-vertical-area-advance-missing.gpkg",
      "Vertical Area Habitats",
      "V005",
    ],
  ])(
    "%s holds a habitat that gets worse, with no years in advance",
    (recipePath, layer, ref) => {
      const { baseline, post } = habitat(builtAt(recipePath), layer, ref);
      expect(post).toHaveLength(1);
      const [row] = post;
      expect(row["Retention Category"]).toBe("Created");
      expect(row.parent_uuid).toBe(baseline.feature_uuid);
      expect(row["Proposed Habitat Type"]).toBe(
        baseline["Baseline Habitat Type"],
      );
      expect(CONDITIONS.indexOf(row["Proposed Condition"])).toBeGreaterThan(
        CONDITIONS.indexOf(baseline["Baseline Condition"]),
      );
      expect(row["Habitat created in advance/years"]).toBeNull();
      // The default site gives it 30+, so the edit is what breaks the rule.
      const [base] = habitat(builtAt(DEFAULT_SITE), layer, ref).post;
      expect(base["Habitat created in advance/years"]).toBe("30+");
    },
  );

  it("watercourse-culvert-left-out.gpkg loses a culvert the default site retains", () => {
    const fixture = habitat(
      builtAt("attribute-problems/watercourse-culvert-left-out.gpkg"),
      "Watercourses",
      "R001",
    );
    expect(fixture.baseline["Baseline River Type"]).toBe("Culvert");
    expect(fixture.post).toEqual([]);
    const base = habitat(builtAt(DEFAULT_SITE), "Watercourses", "R001");
    expect(base.post.map((r) => r["Retention Category"])).toEqual(["Retained"]);
  });

  it("baseline-significance-high.gpkg gives one Retained woodland High in both stages", () => {
    const file = builtAt("attribute-problems/baseline-significance-high.gpkg");
    const { baseline, post } = habitat(file, "Area Habitats", "H002");
    expect(baseline["Baseline Broad Habitat Type"]).toBe("Woodland and forest");
    expect(post).toHaveLength(1);
    expect(post[0]["Retention Category"]).toBe("Retained");
    expect(post[0].parent_uuid).toBe(baseline.feature_uuid);
    for (const stage of STAGES) {
      expect(
        query(
          file,
          `SELECT "Habitat Ref" AS ref FROM "Area Habitats ${stage}" WHERE "Baseline Strategic Significance" = 'High'`,
        ),
        stage,
      ).toEqual([{ ref: "H002" }]);
    }
  });
});

// Read from the committed files, so they need no converter and run
// everywhere: a bng-library repin that changes what the checks report fails
// locally. Rebuilding them is the byte-for-byte test, gated above.
describe("the committed BNG500 files", () => {
  const committed = (recipe) => path.join(CORPUS, recipe.path);

  it("report exactly the issues their recipes list", () => {
    for (const recipe of CONVERTED) {
      const file = committed(recipe);
      const lineage = [...new Set(checkLineage(file).map((p) => p.flaw))];
      expect(lineage, recipe.path).toEqual(recipe.knownIssues.lineage);
      const values = {};
      for (const { table, field } of checkTemplateValues(file)) {
        values[table] = [...(values[table] ?? []), field].sort();
      }
      const known = Object.fromEntries(
        Object.entries(recipe.knownIssues.templateValues).map(
          ([table, fields]) => [table, [...fields].sort()],
        ),
      );
      expect(values, recipe.path).toEqual(known);
    }
  });

  it("carry one template version record each", () => {
    for (const recipe of CONVERTED) {
      expect(versionRecords(committed(recipe)), recipe.path).toHaveLength(1);
    }
  });
});

describe("converterProblem", () => {
  it("points at bootstrap when the template checkout is missing", () => {
    const before = process.env[TEMPLATE_DIR_ENV];
    process.env[TEMPLATE_DIR_ENV] = path.join(ROOT, "test-data", "no-such-dir");
    try {
      expect(converterProblem()).toContain("npm run bootstrap");
    } finally {
      if (before === undefined) {
        delete process.env[TEMPLATE_DIR_ENV];
      } else {
        process.env[TEMPLATE_DIR_ENV] = before;
      }
    }
  });
});

describe("templateCommit", () => {
  const SHA = "a".repeat(40);
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(path.join(ROOT, "test-data", "template-git-"));
    mkdirSync(path.join(dir, ".git", "refs", "heads"), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const write = (name, text) =>
    writeFileSync(path.join(dir, ".git", name), text);

  it("reads a detached HEAD", () => {
    write("HEAD", `${SHA}\n`);
    expect(templateCommit(dir)).toBe(SHA);
  });

  it("reads a branch, loose or packed", () => {
    write("HEAD", "ref: refs/heads/main\n");
    write("packed-refs", `# pack-refs\n${SHA} refs/heads/main\n`);
    expect(templateCommit(dir)).toBe(SHA);
    write("refs/heads/main", `${"b".repeat(40)}\n`);
    expect(templateCommit(dir)).toBe("b".repeat(40));
  });

  it("is null outside a git checkout", () => {
    expect(templateCommit(path.join(dir, "nowhere"))).toBeNull();
  });

  it("says when the checkout is not at the pinned commit", () => {
    expect(describeTemplateCommit(CONVERTER_COMMIT).pinned).toBe(true);
    const other = describeTemplateCommit(SHA);
    expect(other.pinned).toBe(false);
    expect(other.text).toContain("CI rebuilds the files");
  });
});

describe("sameFixture", () => {
  const file = readFileSync(path.join(CORPUS, "valid/default-site.gpkg"));

  it("ignores the SQLite version a GeoPackage's header records", () => {
    const upgraded = Buffer.from(file);
    upgraded.writeUInt32BE(3_099_000, 96);
    upgraded.writeUInt32BE(9, 92);
    expect(upgraded.equals(file)).toBe(false);
    expect(sameFixture(upgraded, file)).toBe(true);
  });

  it("tells apart files that differ anywhere else", () => {
    const changed = Buffer.from(file);
    changed[changed.length - 1] ^= 1;
    expect(sameFixture(changed, file)).toBe(false);
    const counter = Buffer.from(file);
    counter[24] ^= 1;
    expect(sameFixture(counter, file)).toBe(false);
  });

  it("compares a file that is not SQLite byte for byte", () => {
    expect(
      sameFixture(Buffer.from("not a gpkg"), Buffer.from("not a gpkg")),
    ).toBe(true);
    expect(
      sameFixture(Buffer.from("not a gpkg"), Buffer.from("not a gpkh")),
    ).toBe(false);
  });
});

describe("removeStaleFiles", () => {
  it("removes a family's file no recipe builds, and leaves the rest", () => {
    const stale = path.join(outDir, "valid/renamed-away.gpkg");
    writeFileSync(stale, "");
    expect(removeStaleFiles(outDir)).toEqual(["valid/renamed-away.gpkg"]);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(built(recipeFor("valid/default-site.gpkg")))).toBe(true);
  });
});

describe("generate:service-template", () => {
  it("rebuilds one file with --only, to the same bytes", () => {
    const one = mkdtempSync(
      path.join(ROOT, "test-data", "service-template-one-"),
    );
    try {
      const result = spawnSync(
        process.execPath,
        [GENERATE, "--outdir", one, "--only", "lineage-problems"],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      const lineage = RECIPES.filter((r) =>
        r.path.startsWith("lineage-problems/"),
      );
      expect(familyFiles(one).sort()).toEqual(
        lineage.map((r) => r.path).sort(),
      );
      for (const recipe of lineage) {
        expect(
          readFileSync(path.join(one, recipe.path)).equals(
            readFileSync(built(recipe)),
          ),
        ).toBe(true);
      }
    } finally {
      rmSync(one, { recursive: true, force: true });
    }
  });

  it("refuses a family or file no recipe builds", () => {
    const result = spawnSync(process.execPath, [GENERATE, "--only", "nope"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr + result.stdout).toContain("No family or file named");
  });
});
