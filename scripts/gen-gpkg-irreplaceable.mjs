/**
 * `--irreplaceable LAYERS` for the BNG Service format: the layers whose
 * irreplaceable parcel or tree a synthetic site keeps (bng-library's
 * `irreplaceableLayers`), or `none`. A default site marks one on each, and
 * the service refuses an irreplaceable tree, so `none` gives a file it can
 * accept.
 *
 * Split out of `gen-gpkg.mjs` to keep that file within its size budget; it is
 * the CLI's only consumer.
 */

import { FlawSelectionError, IRREPLACEABLE_LAYERS } from "#bng-lib";

const NONE = "none";

/**
 * The layers `--irreplaceable` names, or undefined when it was not given, so
 * the library keeps its default. Takes a comma-separated list, or `none`.
 *
 * @param {string | undefined} value
 * @returns {string[] | undefined}
 */
export function parseIrreplaceableLayers(value) {
  if (value === undefined) {
    return undefined;
  }
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 1 && names[0] === NONE) {
    return [];
  }
  const unknown = names.filter((name) => !IRREPLACEABLE_LAYERS.includes(name));
  if (names.length === 0 || unknown.length > 0) {
    throw new FlawSelectionError(
      `--irreplaceable takes ${NONE} or a comma-separated list of ${IRREPLACEABLE_LAYERS.join(", ")} (got: ${value})`,
    );
  }
  return [...new Set(names)];
}

/** The --help lines for --irreplaceable. */
export function irreplaceableHelp() {
  return `  --irreplaceable L   bng-service synthetic only: the layers that keep the
                      irreplaceable feature a default site marks (${IRREPLACEABLE_LAYERS.join(", ")};
                      default all), or ${NONE}. The service refuses an
                      irreplaceable tree, so use ${NONE} for a file to upload.`;
}
