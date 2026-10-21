import { describe, expect, it, vi } from "vitest";
import {
  SERVICE_TEMPLATE_FLAG,
  childEnvFor,
  devOptions,
  optionLabel,
} from "../../scripts/dev-env.mjs";

const BASE = { PATH: "/bin", OIDC_CLIENT_ID: "ambient" };

describe("the environment npm run dev gives both apps", () => {
  it("leaves the service-template flag unset without the option", () => {
    const env = childEnvFor(devOptions([]), BASE, () => ({}));
    expect(env).toEqual(BASE);
    expect(SERVICE_TEMPLATE_FLAG in env).toBe(false);
  });

  it("turns the flag on with --service-template", () => {
    const env = childEnvFor(
      devOptions(["all", "--service-template"]),
      BASE,
      () => ({}),
    );
    expect(env[SERVICE_TEMPLATE_FLAG]).toBe("true");
    expect(env.PATH).toBe("/bin");
  });

  it("reads the B2C .env only with --b2c, and the file wins over the ambient env", () => {
    const loadB2cEnv = vi.fn(() => ({ OIDC_CLIENT_ID: "from-file" }));
    expect(childEnvFor(devOptions([]), BASE, loadB2cEnv)).toEqual(BASE);
    expect(loadB2cEnv).not.toHaveBeenCalled();
    const env = childEnvFor(devOptions(["--b2c"]), BASE, loadB2cEnv);
    expect(env.OIDC_CLIENT_ID).toBe("from-file");
  });

  it("combines --b2c and --service-template", () => {
    const env = childEnvFor(
      devOptions(["--b2c", "--service-template"]),
      BASE,
      () => ({ OIDC_CLIENT_ID: "from-file" }),
    );
    expect(env).toEqual({
      ...BASE,
      OIDC_CLIENT_ID: "from-file",
      [SERVICE_TEMPLATE_FLAG]: "true",
    });
  });

  it("names the options in force in the banner", () => {
    expect(optionLabel(devOptions([]))).toBe("");
    expect(optionLabel(devOptions(["--b2c", "--service-template"]))).toBe(
      " [B2C, service template]",
    );
  });
});
