import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  copyStatus,
  extractCopyStatus,
  extractExampleFixtures,
  extractFixtures,
  readmeClaims,
} from "../../../.claude/skills/geopackage-validation-explainer/scripts/validation-facts.mjs";
import { scratchDir } from "./_fixtures.mjs";

// The legacy README: the code is the last column, in backticks.
const LEGACY_README = `# Example files

| \`stray.gpkg\` | before any directory heading | \`GPKG_STRAY\` |

## spatial-problems/

| File | Covers | Flaw | Error code |
| --- | --- | --- | --- |
| \`Baseline - bowtie parcel.gpkg\` | a bowtie | \`bowtie-parcel\` | \`AREA_PARCELS_INVALID_GEOMETRY\` |
| \`Baseline - no code.gpkg\` | nothing claimed | \`none\` | |

## valid/

| File | Covers |
| --- | --- |
| \`fine.gpkg\` | a valid file |
`;

// The BNG Service template README: the code is in Expected, third from the
// end, and is not quoted; an outcome there claims nothing.
const SERVICE_TEMPLATE_README = `# BNG Service template corpus

## lineage-problems/

| File | Shows | Expected | Built from |
| --- | --- | --- | --- |
| \`lineage-parent-missing.gpkg\` | no parent | STAGED_PARENT_LINK_MISSING | seed 1 |
| \`lineage-parent-quoted.gpkg\` | quoted | \`STAGED_UNKNOWN_PARENT_REF\` | seed 1 |

## valid/

| File | Shows | Expected | Built from |
| --- | --- | --- | --- |
| \`default-site.gpkg\` | the default site | accepted | seed 1 |
| \`refused-later.gpkg\` | refused elsewhere | refused: not ready to upload | seed 1 |
`;

describe("readmeClaims", () => {
  let dir;
  let claims;

  beforeAll(() => {
    dir = scratchDir();
    claims = readmeClaims([
      {
        readme: dir.write("README.md", LEGACY_README),
        prefix: "",
        codeCell: -2,
      },
      {
        readme: dir.write("service-template/README.md", SERVICE_TEMPLATE_README),
        prefix: "service-template/",
        codeCell: -3,
      },
    ]);
  });

  afterAll(() => dir.remove());

  it("reads the legacy README's last column, keyed by directory and file", () => {
    expect(claims["spatial-problems/Baseline - bowtie parcel.gpkg"]).toBe(
      "AREA_PARCELS_INVALID_GEOMETRY",
    );
  });

  it("reads the service-template README's Expected column, quoted or not, under its prefix", () => {
    expect(claims["service-template/lineage-problems/lineage-parent-missing.gpkg"]).toBe(
      "STAGED_PARENT_LINK_MISSING",
    );
    expect(claims["service-template/lineage-problems/lineage-parent-quoted.gpkg"]).toBe(
      "STAGED_UNKNOWN_PARENT_REF",
    );
  });

  it("claims nothing for an outcome, an empty cell, a table without the column, or a row above every heading", () => {
    expect(Object.keys(claims).toSorted()).toEqual([
      "service-template/lineage-problems/lineage-parent-missing.gpkg",
      "service-template/lineage-problems/lineage-parent-quoted.gpkg",
      "spatial-problems/Baseline - bowtie parcel.gpkg",
    ]);
  });

  it("claims nothing for a README that is not there", () => {
    expect(
      readmeClaims([{ readme: path.join(dir.root, "missing.md"), prefix: "", codeCell: -2 }]),
    ).toEqual({});
  });
});

describe("extractExampleFixtures", () => {
  let dir;
  let result;

  const README = `## dir/

| File | Covers | Error code |
| --- | --- | --- |
| \`agrees.gpkg\` | | \`CODE_A\` |
| \`passes-gate.gpkg\` | | \`CODE_B\` |
| \`contradicted.gpkg\` | | \`CODE_C\` |
| \`not-observed.gpkg\` | | \`CODE_D\` |
| \`stale.gpkg\` | | \`CODE_GONE\` |
`;

  beforeAll(() => {
    dir = scratchDir();
    for (const file of ["agrees", "passes-gate", "contradicted", "stale", "unclaimed"]) {
      dir.write(`examples/dir/${file}.gpkg`, "");
    }
    const observedByCode = {
      CODE_A: ["dir/agrees.gpkg"],
      CODE_Z: ["dir/contradicted.gpkg"],
    };
    const observedByFile = {
      "dir/agrees.gpkg": ["CODE_A"],
      "dir/passes-gate.gpkg": [],
      "dir/contradicted.gpkg": ["CODE_Z"],
      "dir/stale.gpkg": [],
    };
    result = extractExampleFixtures(observedByCode, observedByFile, {
      readmes: [{ readme: dir.write("README.md", README), prefix: "", codeCell: -2 }],
      examplesDir: path.join(dir.root, "examples"),
      registryCodes: new Set(["CODE_A", "CODE_B", "CODE_C", "CODE_D", "CODE_Z"]),
    });
  });

  afterAll(() => dir.remove());

  it("takes what the gate observes, without repeating a file the README agrees on", () => {
    expect(result.byCode.CODE_A).toEqual(["dir/agrees.gpkg"]);
    expect(result.byCode.CODE_Z).toEqual(["dir/contradicted.gpkg"]);
  });

  it("trusts the README for a file the gate passes or never saw", () => {
    expect(result.byCode.CODE_B).toEqual(["dir/passes-gate.gpkg"]);
    expect(result.byCode.CODE_D).toEqual(["dir/not-observed.gpkg"]);
  });

  it("lets the observation win over a README the gate contradicts, and reports it", () => {
    expect(result.byCode.CODE_C).toBeUndefined();
    expect(result.contradicted).toEqual([
      "dir/contradicted.gpkg — README says CODE_C, the gate reports CODE_Z",
    ]);
  });

  it("reports a README claim for a code the registry no longer defines, and maps no file to it", () => {
    expect(result.byCode.CODE_GONE).toBeUndefined();
    expect(result.withoutCode).toEqual(["dir/stale.gpkg — README says CODE_GONE"]);
  });

  it("lists the files on disk that no rule claims, a stale claim's included", () => {
    expect(result.unclaimed).toEqual([
      path.join("dir", "stale.gpkg"),
      path.join("dir", "unclaimed.gpkg"),
    ]);
  });
});

// The legacy registry: a quoted and a bare key, description after errorCode.
const LEGACY_FLAWS = `export const FLAWS = {
  'bowtie-parcel': {
    errorCode: 'AREA_PARCELS_INVALID_GEOMETRY',
    description: 'one habitat parcel drawn as a bowtie',
    apply(site) {
      return site
    }
  },
  sliver: {
    description: "a sliver between parcels",
    errorCode: 'SLIVERS_OUTSIDE_REDLINE'
  }
}
`;

// The BNG Service registries: a description on its own line, a frozen entry,
// a non-literal outcome, and a flaw with no code at all.
const BNG_SERVICE_FLAWS = `const ACCEPTED = 'accepted'

export const BNG_SERVICE_FLAWS = {
  'lineage-parent-missing': {
    description:
      'a Retained area habitat names no baseline habitat',
    errorCode: 'STAGED_PARENT_LINK_MISSING',
    category: CATEGORY_LINEAGE
  },
  'fixed-in-service': {
    description: 'a flaw the service accepts',
    errorCode: ACCEPTED
  },
  'no-code': {
    description: 'a flaw with no code'
  }
}

export const REMAPPED_LEGACY_FLAWS = Object.freeze({
  'iggi-outside': Object.freeze({
    description:
      \`an IGGI is placed outside the redline\`,
    errorCode: 'VERTICAL_HABITATS_OUTSIDE_REDLINE'
  })
})
`;

describe("extractFixtures", () => {
  let dir;
  let fixtures;

  beforeAll(() => {
    dir = scratchDir();
    dir.write("src/synthetic/flaws.mjs", LEGACY_FLAWS);
    dir.write("src/bng-service/flaws.mjs", BNG_SERVICE_FLAWS);
    fixtures = extractFixtures(dir.root);
  });

  afterAll(() => dir.remove());

  it("reads every registry, keyed by the code each flaw is refused with", () => {
    expect(Object.keys(fixtures).toSorted()).toEqual([
      "AREA_PARCELS_INVALID_GEOMETRY",
      "SLIVERS_OUTSIDE_REDLINE",
      "STAGED_PARENT_LINK_MISSING",
      "VERTICAL_HABITATS_OUTSIDE_REDLINE",
    ]);
  });

  it("names a quoted key and a bare one, with a description before or after the code", () => {
    expect(fixtures.AREA_PARCELS_INVALID_GEOMETRY).toEqual([
      { name: "bowtie-parcel", description: "one habitat parcel drawn as a bowtie" },
    ]);
    expect(fixtures.SLIVERS_OUTSIDE_REDLINE).toEqual([
      { name: "sliver", description: "a sliver between parcels" },
    ]);
  });

  it("reads a description on its own line, in an entry frozen or not", () => {
    expect(fixtures.STAGED_PARENT_LINK_MISSING).toEqual([
      {
        name: "lineage-parent-missing",
        description: "a Retained area habitat names no baseline habitat",
      },
    ]);
    expect(fixtures.VERTICAL_HABITATS_OUTSIDE_REDLINE).toEqual([
      { name: "iggi-outside", description: "an IGGI is placed outside the redline" },
    ]);
  });
});

const SINGLE_ERROR_COPY = `const PLACEHOLDER_ERROR_CODES = new Set([
  'PLACEHOLDER_ONLY',
  'GRADUATED',
  'LISTED_PLACEHOLDER'
])

const CODE_ENTRIES = {
  DEDICATED_ONLY: dedicatedEntry,
  GRADUATED: dedicatedEntry,

  // a comment between entries
  LISTED_DEDICATED: dedicatedEntry
}
`;

const CONTROLLER = `const LINEAGE_DESCRIBERS = {
  STAGED_PARENT_LINK_MISSING: describeLineageFeature,
  LISTED_DEDICATED: describeLineageFeature
}

const TEMPLATE_FILE_ERROR_CODES = new Set([
  'TEMPLATE_VERSION_MISSING',
  'LISTED_PLACEHOLDER'
])
`;

describe("extractCopyStatus and copyStatus", () => {
  let dir;
  let sets;

  beforeAll(() => {
    dir = scratchDir();
    dir.write("frontend/src/server/error-file/single-error-copy.js", SINGLE_ERROR_COPY);
    dir.write("frontend/src/server/error-file/controller.js", CONTROLLER);
    dir.write("old-frontend/src/server/error-file/single-error-copy.js", SINGLE_ERROR_COPY);
    sets = extractCopyStatus(path.join(dir.root, "frontend"));
  });

  afterAll(() => dir.remove());

  it("reads both controller collections as shown as a list", () => {
    expect([...sets.shownAsList].toSorted()).toEqual([
      "LISTED_DEDICATED",
      "LISTED_PLACEHOLDER",
      "STAGED_PARENT_LINK_MISSING",
      "TEMPLATE_VERSION_MISSING",
    ]);
  });

  it.each([
    ["STAGED_PARENT_LINK_MISSING", "backend-message"],
    ["TEMPLATE_VERSION_MISSING", "backend-message"],
    ["LISTED_DEDICATED", "backend-message"],
    ["LISTED_PLACEHOLDER", "backend-message"],
    ["DEDICATED_ONLY", "dedicated"],
    ["GRADUATED", "dedicated"],
    ["PLACEHOLDER_ONLY", "placeholder"],
    ["UNHANDLED", "catch-all"],
  ])("gives %s the status %s", (code, status) => {
    expect(copyStatus(code, sets)).toBe(status);
  });

  it("shows nothing as a list for a frontend with no controller", () => {
    const old = extractCopyStatus(path.join(dir.root, "old-frontend"));
    expect(old.shownAsList.size).toBe(0);
    expect(copyStatus("STAGED_PARENT_LINK_MISSING", old)).toBe("catch-all");
  });
});
