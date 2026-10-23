/**
 * The environment `npm run dev` gives the frontend and backend.
 *
 * Split out of `dev.mjs` so the choices it makes can be tested without
 * starting either app.
 */

/**
 * The service-template feature flag, as both apps read it. `--service-template`
 * turns it on. Without the option the harness leaves it as the shell (or, with
 * `--b2c`, the B2C .env) set it: a developer who exports it meant it, and it
 * is off when nobody sets it, the apps' default. Neither app's own dev script
 * pins it, so the value reaches both unchanged.
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
 * env), then the service-template flag set on with `--service-template`.
 * Nothing inherited is removed.
 *
 * @param {{ b2c: boolean, serviceTemplate: boolean }} options
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {() => Record<string, string>} loadB2cEnv  read only with --b2c
 */
export function childEnvFor(options, baseEnv, loadB2cEnv) {
  const env = { ...baseEnv, ...(options.b2c ? loadB2cEnv() : {}) };
  if (options.serviceTemplate) {
    env[SERVICE_TEMPLATE_FLAG] = "true";
  }
  return env;
}

/**
 * Where the flag both apps get comes from, for the banner, checked in the
 * order `childEnvFor` applies them: the option, then the B2C .env (which wins
 * over the shell), then the shell. Null when nothing sets it: off, the apps'
 * default.
 *
 * @param {{ serviceTemplate: boolean }} options
 * @param {NodeJS.ProcessEnv} shellEnv  the ambient environment
 * @param {Record<string, string>} b2cEnv  the B2C .env's values ({} without --b2c)
 */
export function flagSource(options, shellEnv, b2cEnv) {
  if (options.serviceTemplate) {
    return "--service-template";
  }
  if (SERVICE_TEMPLATE_FLAG in b2cEnv) {
    return "the B2C .env";
  }
  return SERVICE_TEMPLATE_FLAG in shellEnv ? "your shell" : null;
}

/** A banner suffix naming the options in force, e.g. " [B2C, service template]". */
export function optionLabel(options) {
  const names = [
    options.b2c && "B2C",
    options.serviceTemplate && "service template",
  ].filter(Boolean);
  return names.length > 0 ? ` [${names.join(", ")}]` : "";
}
