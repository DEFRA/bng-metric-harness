import { describe, expect, it } from "vitest";
import {
  parsePerfTemplate,
  uploadTemplateEnv,
} from "../../scripts/perf-template.mjs";

describe("parsePerfTemplate", () => {
  it.each([undefined, "", "   "])("treats %j as unset", (value) => {
    expect(parsePerfTemplate(value)).toBe("");
  });

  it.each(["legacy", " Legacy ", "LEGACY"])("accepts %j as legacy", (value) => {
    expect(parsePerfTemplate(value)).toBe("legacy");
  });

  it.each(["service", " SERVICE "])("accepts %j as service", (value) => {
    expect(parsePerfTemplate(value)).toBe("service");
  });

  it.each(["servce", "bng-service", "SERVCE"])("rejects %j", (value) => {
    expect(() => parsePerfTemplate(value)).toThrow(
      `PERF_TEMPLATE must be "legacy" or "service", not "${value.toLowerCase()}".`,
    );
  });
});

describe("uploadTemplateEnv", () => {
  it("leaves UPLOAD_TEMPLATE unset for the legacy default", () => {
    expect(uploadTemplateEnv(parsePerfTemplate(""))).toEqual({});
  });

  it.each(["legacy", "service"])(
    "sets UPLOAD_TEMPLATE for an explicit %s",
    (template) => {
      expect(uploadTemplateEnv(parsePerfTemplate(template))).toEqual({
        UPLOAD_TEMPLATE: template,
      });
    },
  );

  it("does not forward a value the parser rejects", () => {
    expect(uploadTemplateEnv("servce")).toEqual({});
  });
});
