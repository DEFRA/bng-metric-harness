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
  checkTemplateValues,
  listFlaws,
  readVersionRecords,
} from "#bng-lib";
import { checkFile } from "../../../scripts/lineage-check.mjs";
import {
  buildRecipe,
  familyFiles,
  removeStaleFiles,
} from "../../../scripts/service-template/build.mjs";
import { renderReadme } from "../../../scripts/service-template/readme.mjs";
import {
  FAMILIES,
  KIND_DERIVED,
  RECIPES,
  recipeFor,
} from "../../../scripts/service-template/recipes.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const CORPUS = path.join(ROOT, "example-files/service-template");
const GENERATE = path.join(ROOT, "scripts/gen-service-template.mjs");
const NOT_A_GEOPACKAGE = "malformed/not-a-geopackage.gpkg";
const LEGACY_LAYOUT = "invalid-schema/legacy-template.gpkg";

let outDir;
// Inside the harness, as --outdir must be; test-data/ is gitignored.
beforeAll(() => {
  const testData = path.join(ROOT, "test-data");
  mkdirSync(testData, { recursive: true });
  outDir = mkdtempSync(path.join(testData, "service-template-"));
  for (const recipe of RECIPES) {
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
    const differ = RECIPES.filter((recipe) => {
      const committed = path.join(CORPUS, recipe.path);
      return (
        !existsSync(committed) ||
        !readFileSync(committed).equals(readFileSync(built(recipe)))
      );
    }).map((r) => r.path);
    expect(differ).toEqual([]);
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
    const checked = RECIPES.filter(
      (r) => ![NOT_A_GEOPACKAGE, LEGACY_LAYOUT].includes(r.path),
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
