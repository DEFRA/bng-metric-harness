/**
 * `--habitat`: pin the baseline habitat of the first N synthetic parcels.
 *
 * The generator's random pools are inland-only, so a habitat the statutory
 * metric files under a coastal / intertidal broad type — IGGI is the one that
 * matters in practice — can only reach a fixture by being pinned here.
 *
 * Split out of `gen-gpkg.mjs` to keep that file within its size budget; it is
 * the CLI's only consumer.
 */

import { error } from "./_lib.mjs";
import { ALL_HABITATS } from "#bng-lib";

// Layer key the generator reads per-row attribute overrides from.
export const HABITATS_LAYER = "habitats";

const MAX_HABITAT_SUGGESTIONS = 5;
// The metric spells a habitat "<Broad habitat type> - <Habitat type>".
const HABITAT_NAME_SEPARATOR = " - ";
// Pinned rows are Retained so the proposed columns mirror the baseline. A
// habitat outside the in-scope pools has nothing to be enhanced or created
// into, and a retained row is coherent for every habitat.
const PINNED_RETENTION = "Retained";

function findHabitatFullName(name) {
  const wanted = name.trim();
  const exact = ALL_HABITATS.find((h) => h.fullName === wanted);
  if (exact) {
    return exact.fullName;
  }
  const lower = wanted.toLowerCase();
  return (
    ALL_HABITATS.find((h) => h.fullName.toLowerCase() === lower)?.fullName ??
    null
  );
}

// Near-misses for an unrecognised --habitat: the whole string, the broad type
// on its own, or the type half on its own — a typo usually leaves at least one
// of the three intact.
function habitatSuggestions(name) {
  const lower = name.trim().toLowerCase();
  const sepIdx = lower.indexOf(HABITAT_NAME_SEPARATOR);
  const broadPart = sepIdx < 0 ? lower : lower.slice(0, sepIdx);
  const typePart =
    sepIdx < 0 ? "" : lower.slice(sepIdx + HABITAT_NAME_SEPARATOR.length);
  return ALL_HABITATS.filter((h) => {
    const full = h.fullName.toLowerCase();
    return (
      full.includes(lower) ||
      full.startsWith(broadPart) ||
      (typePart !== "" && full.includes(typePart))
    );
  }).slice(0, MAX_HABITAT_SUGGESTIONS);
}

function reportUnknownHabitat(name) {
  error(
    `Unknown habitat "${name}" — expected "<Broad habitat type> - <Habitat type>" ` +
      "exactly as the statutory metric spells it.",
  );
  const suggestions = habitatSuggestions(name);
  if (suggestions.length > 0) {
    error(`Did you mean:\n  ${suggestions.map((h) => h.fullName).join("\n  ")}`);
  }
  process.exit(1);
}

/**
 * Turn the --habitat values into the per-row override list `generateOne`
 * expects, or null when none were given. Exits on anything the generator
 * would only discover after creating the output file.
 */
export function resolveHabitatPins(names, numParcels, selection) {
  if (names.length === 0) {
    return null;
  }
  if (names.length > numParcels) {
    error(
      `--habitat given ${names.length} times but only ${numParcels} parcel(s) requested; raise --size`,
    );
    process.exit(1);
  }
  if (selection.attributeOverrides[HABITATS_LAYER]) {
    error(
      "--habitat cannot be combined with an attribute-override flaw that targets the Habitats layer",
    );
    process.exit(1);
  }
  return names.map((name) => {
    const fullName = findHabitatFullName(name);
    if (!fullName) {
      reportUnknownHabitat(name);
    }
    return { habitatFullName: fullName, retention: PINNED_RETENTION };
  });
}
