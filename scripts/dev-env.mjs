/**
 * The environment `npm run dev` gives the frontend and backend.
 *
 * Split out of `dev.mjs` so the choices it makes can be tested without
 * starting either app.
 */

/**
 * The service-template feature flag, as both apps read it. `--service-template`
 * turns it on; plain `npm run dev` leaves it unset, so the apps keep their own
 * default (off). Neither app's own dev script pins it, so the value reaches
 * both unchanged.
 */
export const SERVICE_TEMPLATE_FLAG = "SERVICE_TEMPLATE_ENABLED";

/** The dev options in `args`: `--b2c` and `--service-template`. */
export function devOptions(args) {
  return {
    b2c: args.includes("--b2c"),
    serviceTemplate: args.includes("--service-template"),
  };
}

/**
 * The environment both apps start with: the ambient one, then the B2C values
 * from the shared .env when `--b2c` is given (the file wins over the ambient
 * env), then the service-template flag when `--service-template` is given.
 *
 * @param {{ b2c: boolean, serviceTemplate: boolean }} options
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {() => Record<string, string>} loadB2cEnv  read only with --b2c
 */
export function childEnvFor(options, baseEnv, loadB2cEnv) {
  return {
    ...baseEnv,
    ...(options.b2c ? loadB2cEnv() : {}),
    ...(options.serviceTemplate ? { [SERVICE_TEMPLATE_FLAG]: "true" } : {}),
  };
}

/** A banner suffix naming the options in force, e.g. " [B2C, service template]". */
export function optionLabel(options) {
  const names = [
    options.b2c && "B2C",
    options.serviceTemplate && "service template",
  ].filter(Boolean);
  return names.length > 0 ? ` [${names.join(", ")}]` : "";
}
