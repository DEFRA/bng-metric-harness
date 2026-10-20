import { describe, expect, it } from "vitest";
import {
  BNG_SERVICE_FLAWS,
  CATEGORY_DEGRADE,
  CATEGORY_LINEAGE,
  CATEGORY_VERSION,
  FlawSelectionError,
} from "#bng-lib";
import { flawListFor, splitFlaws } from "../../../scripts/gen-gpkg-flaws.mjs";

describe("flawListFor", () => {
  it.each([
    [CATEGORY_LINEAGE, "lineageFlawNames"],
    [CATEGORY_DEGRADE, "degradeFlawNames"],
    [CATEGORY_VERSION, "versionFlawNames"],
  ])("puts a %s flaw in %s", (category, list) => {
    expect(flawListFor(category, "a-flaw")).toBe(list);
  });

  it("refuses a category it does not know, rather than file it as another", () => {
    expect(() => flawListFor("something-new", "a-flaw")).toThrow(
      FlawSelectionError,
    );
    expect(() => flawListFor("something-new", "a-flaw")).toThrow(
      /category this CLI does not know \("something-new"\)/,
    );
  });

  it("knows the category of every flaw the pinned library has", () => {
    for (const [name, flaw] of Object.entries(BNG_SERVICE_FLAWS)) {
      expect(() => flawListFor(flaw.category, name), name).not.toThrow();
    }
  });
});

describe("splitFlaws", () => {
  it("files each BNG Service flaw by its category", () => {
    expect(
      splitFlaws(
        ["lineage-parent-missing", "degrade-not-worse", "version-unsupported"],
        { bngService: true, stage: "post-intervention" },
      ),
    ).toEqual({
      legacy: [],
      lineageFlawNames: ["lineage-parent-missing"],
      degradeFlawNames: ["degrade-not-worse"],
      versionFlawNames: ["version-unsupported"],
    });
  });
});
