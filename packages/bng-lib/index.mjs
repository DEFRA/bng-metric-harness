/**
 * @bng/lib — BNG test GeoPackage generator.
 *
 * Two entry points for the common cases:
 *   generateSyntheticGpkg(opts)         — buffer-out, synthetic-mode
 *   generateFromWorkbookBuffer(opts)    — buffer-in/out, workbook-driven
 *
 * The path-based pipeline that powers both is also re-exported here so the
 * harness CLI in `scripts/gen-gpkg.mjs` can drive it directly.
 */

// Buffer-out wrappers + flaw introspection used by both the CLI and a host UI.
export {
  generateSyntheticGpkg,
  generateFromWorkbookBuffer,
  listFlaws,
} from "./src/api.mjs";

// Path-based orchestration — CLI uses these directly so it can stream output
// to the user's chosen --outdir without going through the temp-file dance.
export {
  MODE_BASELINE,
  MODE_POST_INTERVENTION,
  MODE_BOTH,
  VALID_MODES,
  generateBaselineFile,
  generatePostInterventionFile,
  generateFromWorkbook,
} from "./src/orchestration.mjs";

// Logger plumbing — buffer-API callers normally let `generateSyntheticGpkg` /
// `generateFromWorkbookBuffer` capture messages, but expose `captureMessages`
// for callers that want to drive the orchestration entry points directly.
export {
  FlawSelectionError,
  captureMessages,
  drainMessages,
  setMode,
} from "./src/log.mjs";

// Domain primitives the CLI still uses around the orchestration entry points
// (centre defaulting, workbook --inspect, etc).
export { generateOne } from "./src/synthetic/synthetic.mjs";
export {
  ALL_FLAW_NAMES,
  CATEGORY_ATTRIBUTE,
  CATEGORY_EMPTY,
  CATEGORY_GEOMETRIC,
  FLAWS,
  resolveFlawSelection,
} from "./src/synthetic/flaws.mjs";
export {
  readMetricWorkbook,
  readMetricWorkbookFromBuffer,
} from "./src/workbook/metric-workbook.mjs";
export {
  FEATURE_REF_PAD,
  FEATURE_REF_PAD_CHAR,
  buildBaselineRows,
  buildPostInterventionRows,
} from "./src/workbook/workbook-rows.mjs";
