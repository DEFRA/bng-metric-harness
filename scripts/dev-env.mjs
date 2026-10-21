/**
 * The environment `npm run dev` gives the frontend and backend.
 *
 * Split out of `dev.mjs` so the choices it makes can be tested without
 * starting either app.
 */

/**
 * The service-template feature flag, as both apps read it. Only
 * `--service-template` decides it: with the option it is on, and without it
 * the harness removes any value inherited from the shell or the B2C .env, so
 * plain `npm run dev` always runs with the apps' default (off). Neither app's
 * own dev script pins it, so the value reaches both unchanged.
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
 * env), then the service-template flag: set with `--service-template`, and
 * removed without it, so an inherited value cannot turn it on unasked.
 *
 * @param {{ b2c: boolean, serviceTemplate: boolean }} options
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {() => Record<string, string>} loadB2cEnv  read only with --b2c
 * @param {(value: string) => void} [onIgnored]  told the inherited value
 *   it removed, to warn about it
 */
export function childEnvFor(options, baseEnv, loadB2cEnv, onIgnored) {
  const env = { ...baseEnv, ...(options.b2c ? loadB2cEnv() : {}) };
  if (options.serviceTemplate) {
    env[SERVICE_TEMPLATE_FLAG] = "true";
    return env;
  }
  if (SERVICE_TEMPLATE_FLAG in env) {
    onIgnored?.(env[SERVICE_TEMPLATE_FLAG]);
    delete env[SERVICE_TEMPLATE_FLAG];
  }
  return env;
}

/** A banner suffix naming the options in force, e.g. " [B2C, service template]". */
export function optionLabel(options) {
  const names = [
    options.b2c && "B2C",
    options.serviceTemplate && "service template",
  ].filter(Boolean);
  return names.length > 0 ? ` [${names.join(", ")}]` : "";
}
