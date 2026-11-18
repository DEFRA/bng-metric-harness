// The upload test for one corpus: every example file is uploaded through the
// backend's code, one test per file, named for it, and each fails with the
// file, what should have happened and what did. On GitHub Actions
// the results also go to the job summary.
//
// It needs an installed backend beside the harness (or BNG_BACKEND_DIR), and
// skips without one, unless REQUIRE_BACKEND is "true", as CI sets it: there a
// backend that is not installed fails the test rather than skipping it.
//
// Each corpus has a test file of its own, so each runs with the backend's
// service-template flag as that corpus needs it.

import { appendFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  backendDir,
  isBackendInstalled,
} from "../../../scripts/metric-comparison/backend.mjs";
import {
  EXAMPLE_FILES_DIR,
  corpusFiles,
  expectationFor,
  isUploaded,
} from "../../../scripts/example-uploads/expectations.mjs";
import {
  loadUploadChecks,
  uploadExampleFile,
} from "../../../scripts/example-uploads/upload-example-file.mjs";
import {
  summaryMarkdown,
  verdict,
} from "../../../scripts/example-uploads/report.mjs";

// The largest file takes a few seconds; a slow runner may need more.
const UPLOAD_TIMEOUT = 60_000;
const REQUIRE_BACKEND = process.env.REQUIRE_BACKEND === "true";

/**
 * @param {string} template LEGACY or SERVICE_TEMPLATE
 * @param {string} title how the job summary names the corpus
 */
export function describeUploads(template, title) {
  const installed = isBackendInstalled();
  const files = corpusFiles(template).filter(isUploaded);

  if (REQUIRE_BACKEND && !installed) {
    it("has an installed backend to upload through", () => {
      expect.fail(
        `REQUIRE_BACKEND is set, but there is no installed backend at ${backendDir()}`,
      );
    });
    return;
  }

  describe.skipIf(!installed)(`${title}: every example file`, () => {
    const verdicts = [];

    beforeAll(async () => {
      await loadUploadChecks(template);
    });

    afterAll(() => {
      const summary = process.env.GITHUB_STEP_SUMMARY;
      if (summary && verdicts.length > 0) {
        appendFileSync(summary, summaryMarkdown(title, verdicts));
      }
    });

    it.each(files)(
      "%s",
      async (file) => {
        const expectation = expectationFor(file);
        const result = await uploadExampleFile(
          file,
          path.join(EXAMPLE_FILES_DIR, file),
          template,
        );
        const outcome = verdict(file, expectation, result);
        verdicts.push(outcome);
        if (outcome.stale) {
          console.warn(outcome.message);
        }
        if (!outcome.pass) {
          expect.fail(outcome.message);
        }
      },
      UPLOAD_TIMEOUT,
    );
  });
}
