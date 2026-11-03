import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.join(import.meta.dirname, "../../scripts/run-perf-tests.mjs");

function runWithTemplate(template) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, PERF_TEMPLATE: template },
  });
}

describe("PERF_TEMPLATE", () => {
  it.each(["servce", "bng-service", "SERVCE"])(
    "rejects %j before building the image",
    (template) => {
      const result = runWithTemplate(template);
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain(
        `PERF_TEMPLATE must be "legacy" or "service", not "${template.toLowerCase()}".`,
      );
      expect(output).not.toContain("Building the perf-tests image");
      expect(output).not.toContain("uploading the legacy template");
    },
  );
});
