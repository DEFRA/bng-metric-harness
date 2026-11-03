import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadGate } from "../../../.claude/skills/geopackage-validation-explainer/scripts/observe-fixtures.mjs";
import { scratchDir } from "./_fixtures.mjs";

// Stand-ins for the backend's two gates that report which one ran and what it
// was handed, so a test can tell a path from a buffer.
const LEGACY_GATE = `export function validateGpkg(input) {
  return { gate: "legacy", isBuffer: Buffer.isBuffer(input), input: String(input) };
}
`;
const SERVICE_TEMPLATE_GATE = `export function validateServiceTemplateGpkgFile(input) {
  return { gate: "service-template", isBuffer: Buffer.isBuffer(input), input };
}
`;
const FIXTURE_BYTES = "fixture bytes";

describe("loadGate", () => {
  let dir;
  let gate;
  let fixture;

  beforeAll(async () => {
    dir = scratchDir();
    dir.write("backend/src/validation/geopackage/geopackage.js", LEGACY_GATE);
    dir.write(
      "backend/src/validation/geopackage/service-template/service-template-gate.js",
      SERVICE_TEMPLATE_GATE,
    );
    fixture = dir.write("fixture.gpkg", FIXTURE_BYTES);
    gate = await loadGate(path.join(dir.root, "backend"));
  });

  afterAll(() => dir.remove());

  it("hands a service-template fixture's path to the BNG Service template gate", () => {
    const relative = path.join("service-template", "valid", "a.gpkg");
    expect(gate(fixture, relative)).toEqual({
      gate: "service-template",
      isBuffer: false,
      input: fixture,
    });
  });

  it("hands any other fixture's contents to the legacy gate", () => {
    const relative = path.join("valid", "a.gpkg");
    expect(gate(fixture, relative)).toEqual({
      gate: "legacy",
      isBuffer: true,
      input: FIXTURE_BYTES,
    });
  });

  it("does not take a directory that only starts with service-template for the corpus", () => {
    const relative = path.join("service-template-old", "a.gpkg");
    expect(gate(fixture, relative).gate).toBe("legacy");
  });
});
