import { Writable } from "node:stream";

import concurrently from "concurrently";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SERVICE_TEMPLATE_FLAG,
  childEnvFor,
  devOptions,
  dropRemovedKeys,
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

  it("ignores a flag inherited from the shell without the option, and says so", () => {
    const onIgnored = vi.fn();
    const env = childEnvFor(
      devOptions([]),
      { ...BASE, [SERVICE_TEMPLATE_FLAG]: "true" },
      () => ({}),
      onIgnored,
    );
    expect(SERVICE_TEMPLATE_FLAG in env).toBe(false);
    expect(onIgnored).toHaveBeenCalledWith("true");
  });

  it("ignores a flag in the B2C .env without the option", () => {
    const env = childEnvFor(
      devOptions(["--b2c"]),
      BASE,
      () => ({ [SERVICE_TEMPLATE_FLAG]: "true" }),
      () => {},
    );
    expect(SERVICE_TEMPLATE_FLAG in env).toBe(false);
  });

  it("turns the flag on with the option, whatever was inherited", () => {
    const onIgnored = vi.fn();
    const env = childEnvFor(
      devOptions(["--service-template"]),
      { ...BASE, [SERVICE_TEMPLATE_FLAG]: "false" },
      () => ({}),
      onIgnored,
    );
    expect(env[SERVICE_TEMPLATE_FLAG]).toBe("true");
    expect(onIgnored).not.toHaveBeenCalled();
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

  it("is unset without the option, even when the shell sets it", async () => {
    process.env[SERVICE_TEMPLATE_FLAG] = "true";
    const childEnv = childEnvFor(devOptions([]), process.env, () => ({}));
    dropRemovedKeys(childEnv, process.env);
    expect(await flagSeenByConcurrently(childEnv)).toBe("unset");
  });

  it("is on with the option", async () => {
    delete process.env[SERVICE_TEMPLATE_FLAG];
    const childEnv = childEnvFor(
      devOptions(["--service-template"]),
      process.env,
      () => ({}),
    );
    dropRemovedKeys(childEnv, process.env);
    expect(await flagSeenByConcurrently(childEnv)).toBe("true");
  });
});

describe("dropRemovedKeys", () => {
  it("removes only the keys the child env left out", () => {
    const processEnv = { PATH: "/bin", [SERVICE_TEMPLATE_FLAG]: "true" };
    dropRemovedKeys({ PATH: "/bin", EXTRA: "x" }, processEnv);
    expect(processEnv).toEqual({ PATH: "/bin" });
  });
});
