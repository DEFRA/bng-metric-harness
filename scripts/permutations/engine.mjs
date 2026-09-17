/**
 * Load the BNG metric engine (`bng-library/metric`).
 *
 * The statutory calculations are a zero-dependency ESM entry point of the
 * bng-library package, which this harness already carries as a devDependency.
 * The permutations runner uses them to compute engine-accurate baseline /
 * post-intervention unit totals, so the "Met / Unmet 10% net gain" scenarios
 * can be verified against the same arithmetic the service itself runs — not a
 * re-implementation that could drift.
 *
 * This used to resolve the engine by path, into the backend sibling, because
 * the calculations lived in a workspace nested inside that repo and could not
 * be depended on. They now live in bng-library, so a plain import does it and
 * the runner no longer needs the backend checked out at all.
 */

/**
 * Import the engine's public API.
 *
 * @returns {Promise<object>} the engine's module namespace
 */
export async function loadEngine() {
  return import("#metric");
}
