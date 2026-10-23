import { Writable } from "node:stream";

import concurrently from "concurrently";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SERVICE_TEMPLATE_FLAG,
  childEnvFor,
  devOptions,
  flagSource,
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

  it("keeps a flag inherited from the shell without the option", () => {
    const env = childEnvFor(
      devOptions([]),
      { ...BASE, [SERVICE_TEMPLATE_FLAG]: "true" },
      () => ({}),
    );
    expect(env[SERVICE_TEMPLATE_FLAG]).toBe("true");
  });

  it("keeps a flag the B2C .env sets", () => {
    const env = childEnvFor(devOptions(["--b2c"]), BASE, () => ({
      [SERVICE_TEMPLATE_FLAG]: "true",
    }));
    expect(env[SERVICE_TEMPLATE_FLAG]).toBe("true");
  });

  it("turns the flag on with the option, whatever was inherited", () => {
    const env = childEnvFor(
      devOptions(["--service-template"]),
      { ...BASE, [SERVICE_TEMPLATE_FLAG]: "false" },
      () => ({}),
    );
    expect(env[SERVICE_TEMPLATE_FLAG]).toBe("true");
  });

  it("says where the flag comes from", () => {
    const options = devOptions([]);
    expect(flagSource(options, BASE)).toBeNull();
    expect(
      flagSource(options, { ...BASE, [SERVICE_TEMPLATE_FLAG]: "true" }),
    ).toBe("your environment");
    expect(
      flagSource(devOptions(["--service-template"]), {
        ...BASE,
        [SERVICE_TEMPLATE_FLAG]: "true",
      }),
    ).toBe("--service-template");
  });

  it("names the options in force in the banner", () => {
    expect(optionLabel(devOptions([]))).toBe("");
    expect(optionLabel(devOptions(["--b2c", "--service-template"]))).toBe(
      " [B2C, service template]",
    );
  });
});

// What `npm run dev` does with both apps, against a command that prints the
// flag it sees: concurrently merges `process.env` back under the child env.
async function flagSeenByConcurrently(childEnv) {
  let output = "";
  const outputStream = new Writable({
    write(chunk, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  const { result } = concurrently(
    [
      {
        command: `node -p "process.env.${SERVICE_TEMPLATE_FLAG} ?? 'unset'"`,
        env: childEnv,
      },
    ],
    { outputStream, prefix: "none" },
  );
  await result;
  return output.split("\n")[0].trim();
}

describe("the flag both apps see when npm run dev starts them together", () => {
  const inherited = process.env[SERVICE_TEMPLATE_FLAG];

  afterEach(() => {
    if (inherited === undefined) {
      delete process.env[SERVICE_TEMPLATE_FLAG];
    } else {
      process.env[SERVICE_TEMPLATE_FLAG] = inherited;
    }
  });

  // concurrently reads the shell's environment from process.env itself.
  const seen = (args, shellValue) => {
    if (shellValue === undefined) {
      delete process.env[SERVICE_TEMPLATE_FLAG];
    } else {
      process.env[SERVICE_TEMPLATE_FLAG] = shellValue;
    }
    return flagSeenByConcurrently(
      childEnvFor(devOptions(args), process.env, () => ({})),
    );
  };

  it("is unset when nobody sets it", async () => {
    expect(await seen([])).toBe("unset");
  });

  it("is the shell's value without the option", async () => {
    expect(await seen([], "true")).toBe("true");
  });

  it("is on with the option, whatever the shell set", async () => {
    expect(await seen(["--service-template"], "false")).toBe("true");
  });
});
