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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FORMAT_BNG_SERVICE,
  checkLineage,
  checkTemplateValues,
  listFlaws,
  readVersionRecords,
} from "#bng-lib";
import { checkFile } from "../../../scripts/lineage-check.mjs";
import {
  buildRecipe,
  familyFiles,
  removeStaleFiles,
  sameFixture,
} from "../../../scripts/service-template/build.mjs";
import {
  TEMPLATE_DIR_ENV,
  converterProblem,
} from "../../../scripts/service-template/convert.mjs";
import { renderReadme } from "../../../scripts/service-template/readme.mjs";
import {
  FAMILIES,
  KIND_CONVERTED,
  KIND_DERIVED,
  RECIPES,
  recipeFor,
} from "../../../scripts/service-template/recipes.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const CORPUS = path.join(ROOT, "example-files/service-template");
const GENERATE = path.join(ROOT, "scripts/gen-service-template.mjs");
const NOT_A_GEOPACKAGE = "malformed/not-a-geopackage.gpkg";
const LEGACY_LAYOUT = "invalid-schema/legacy-template.gpkg";

// The bng-500/ files need the template's converter. Without it they are
// skipped, unless REQUIRE_CONVERTER is set, as CI sets it.
const CONVERTER_PROBLEM = converterProblem();
if (CONVERTER_PROBLEM && process.env.REQUIRE_CONVERTER === "true") {
  throw new Error(`REQUIRE_CONVERTER is set, but ${CONVERTER_PROBLEM}`);
}
const CONVERTED = RECIPES.filter((r) => r.kind === KIND_CONVERTED);
const BUILDABLE = CONVERTER_PROBLEM
  ? RECIPES.filter((r) => r.kind !== KIND_CONVERTED)
  : RECIPES;

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

describe("the built fixtures", () => {
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

describe.skipIf(CONVERTER_PROBLEM)("the converted BNG500 files", () => {
  it("report exactly the issues their recipes list", () => {
    for (const recipe of CONVERTED) {
      const file = built(recipe);
      const lineage = [...new Set(checkLineage(file).map((p) => p.flaw))];
      expect(lineage, recipe.path).toEqual(recipe.knownIssues.lineage);
      const values = {};
      for (const { table, field } of checkTemplateValues(file)) {
        values[table] = [...(values[table] ?? []), field];
      }
      expect(values, recipe.path).toEqual(recipe.knownIssues.templateValues);
    }
  });

  it("carry one template version record each", () => {
    for (const recipe of CONVERTED) {
      expect(versionRecords(built(recipe)), recipe.path).toHaveLength(1);
    }
  });
});

describe("converterProblem", () => {
  /** converterProblem() with BNG_TEMPLATE_DIR set to `dir`. */
  function problemFor(dir) {
    const before = process.env[TEMPLATE_DIR_ENV];
    process.env[TEMPLATE_DIR_ENV] = dir;
    try {
      return converterProblem();
    } finally {
      if (before === undefined) {
        delete process.env[TEMPLATE_DIR_ENV];
      } else {
        process.env[TEMPLATE_DIR_ENV] = before;
      }
    }
  }

  const git = (dir, ...args) =>
    spawnSync(
      "git",
      [
        "-C",
        dir,
        "-c",
        "user.name=test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { encoding: "utf8" },
    );

  /** A git repo holding a stub converter, committed. */
  function stubTemplate() {
    const dir = mkdtempSync(path.join(ROOT, "test-data", "template-stub-"));
    const converter = path.join(dir, "plugin", "bng_template_convert");
    mkdirSync(converter, { recursive: true });
    writeFileSync(path.join(converter, "old_to_new.py"), "# stub\n");
    git(dir, "init", "--quiet");
    git(dir, "add", ".");
    git(dir, "commit", "--quiet", "-m", "stub");
    return { dir, converter };
  }

  it("points at bootstrap when the template checkout is missing", () => {
    expect(problemFor(path.join(ROOT, "test-data", "no-such-dir"))).toContain(
      "npm run bootstrap",
    );
  });

  it("says to update CONVERTER_COMMIT when the checkout is at another commit", () => {
    const { dir } = stubTemplate();
    try {
      expect(problemFor(dir)).toContain("update CONVERTER_COMMIT");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a checkout whose converter has uncommitted changes", () => {
    const { dir, converter } = stubTemplate();
    try {
      writeFileSync(path.join(converter, "old_to_new.py"), "# edited\n");
      expect(problemFor(dir)).toContain("uncommitted changes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
