import { describe, expect, it } from "vitest";
import {
  BNG_SERVICE_FLAWS,
  CATEGORY_CHANGE,
  CATEGORY_DEGRADE,
  CATEGORY_LINEAGE,
  CATEGORY_VERSION,
  FlawSelectionError,
} from "#bng-lib";
import {
  assertChangeFlawsDrawable,
  flawListFor,
  splitFlaws,
} from "../../../scripts/gen-gpkg-flaws.mjs";

describe("flawListFor", () => {
  it.each([
    [CATEGORY_LINEAGE, "lineageFlawNames"],
    [CATEGORY_DEGRADE, "degradeFlawNames"],
    [CATEGORY_CHANGE, "changeFlawNames"],
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
        [
          "lineage-parent-missing",
          "degrade-not-worse",
          "remeandered-watercourse-outside",
          "version-unsupported",
        ],
        { bngService: true, stage: "post-intervention" },
      ),
    ).toEqual({
      legacy: [],
      lineageFlawNames: ["lineage-parent-missing"],
      degradeFlawNames: ["degrade-not-worse"],
      changeFlawNames: ["remeandered-watercourse-outside"],
      versionFlawNames: ["version-unsupported"],
    });
  });

  it("refuses a site-change flaw on a baseline-stage file, which has no change to break", () => {
    expect(() =>
      splitFlaws(["remeandered-watercourse-outside"], {
        bngService: true,
        stage: "baseline",
      }),
    ).toThrow(/Site-change flaws change post-intervention features/);
  });
});

describe("assertChangeFlawsDrawable", () => {
  const CHANGE = ["remeandered-watercourse-outside"];

  it("refuses a site-change flaw beside a geometric flaw or --bad", () => {
    const refused = () =>
      assertChangeFlawsDrawable(CHANGE, {
        geometricFlawNames: ["bowtie-parcel"],
        emptyLayers: new Set(),
      });
    expect(refused).toThrow(FlawSelectionError);
    expect(refused).toThrow(/drop the geometric flaw or --bad/);
  });

  it("refuses a site-change flaw with the rivers layer empty", () => {
    const refused = () =>
      assertChangeFlawsDrawable(CHANGE, {
        geometricFlawNames: [],
        emptyLayers: new Set(["rivers"]),
      });
    expect(refused).toThrow(FlawSelectionError);
    expect(refused).toThrow(/empty rivers layer cannot hold; drop no-rivers/);
  });

  it("passes a site that draws the change, and any site with no site-change flaw", () => {
    expect(() =>
      assertChangeFlawsDrawable(CHANGE, {
        geometricFlawNames: [],
        emptyLayers: new Set(["hedgerows"]),
      }),
    ).not.toThrow();
    expect(() =>
      assertChangeFlawsDrawable([], {
        geometricFlawNames: ["bowtie-parcel"],
        emptyLayers: new Set(["rivers"]),
      }),
    ).not.toThrow();
  });
});
