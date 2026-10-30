// loadBackendPipeline keeps the backend it loads for the process. These run
// in a file of their own, so nothing has loaded it before them.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BACKEND_DIR_ENV,
  isBackendInstalled,
  loadBackendPipeline,
} from "../../../scripts/metric-comparison/backend.mjs";

describe("loadBackendPipeline", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "no-backend-"));
  const dirAsSet = process.env[BACKEND_DIR_ENV];
  afterAll(() => {
    if (dirAsSet === undefined) {
      delete process.env[BACKEND_DIR_ENV];
    } else {
      process.env[BACKEND_DIR_ENV] = dirAsSet;
    }
    rmSync(empty, { recursive: true, force: true });
  });

  it("says which module a backend that predates the import lacks", async () => {
    process.env[BACKEND_DIR_ENV] = empty;

    await expect(loadBackendPipeline()).rejects.toThrow(
      /has no src\/services\/upload\/import-upload-file\.js.*: it predates/,
    );
  });

  // Read before any test points the env at the empty folder.
  const installed = isBackendInstalled();

  it.skipIf(!installed)(
    "tries again after a load that failed, rather than failing the same way",
    async () => {
      process.env[BACKEND_DIR_ENV] = empty;
      await expect(loadBackendPipeline()).rejects.toThrow(/predates/);

      if (dirAsSet === undefined) {
        delete process.env[BACKEND_DIR_ENV];
      } else {
        process.env[BACKEND_DIR_ENV] = dirAsSet;
      }
      const backend = await loadBackendPipeline();

      expect(backend.importUploadFile).toEqual(expect.any(Function));
    },
  );
});
