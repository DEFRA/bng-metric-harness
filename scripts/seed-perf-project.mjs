// Seed (or re-seed) the big-baseline perf project straight into the local
// Postgres, idempotently: one fixed project id, upserted, so re-runs re-point
// the row at the requested owner rather than piling up copies.
//
// Importable (the perf runner calls seedPerfProject) and runnable standalone —
// e.g. to seed a big project for YOUR dev user and eyeball the slow project
// list in the browser:
//
//   node scripts/seed-perf-project.mjs                      # the perf stub user
//   node scripts/seed-perf-project.mjs --sub=<uuid> --parcels=5000
import { fileURLToPath } from "node:url";
import path from "node:path";
import { error, info, run, runCapture } from "./_lib.mjs";
import { PERF_USER_SUB } from "./get-stub-token.mjs";

const PROJECT_ID = "00000000-0000-4000-8000-000000000933";
const DEFAULT_PARCELS = Number(process.env.PERF_PARCELS ?? "2000");
const POSTGRES_IMAGE = process.env.PERF_POSTGRES_IMAGE ?? "postgis/postgis:16-3.5";

// The sub is interpolated into the SQL below; restrict it to token-subject-safe
// characters so a mangled CLI arg cannot break out of the string literal.
const SAFE_SUB = /^[A-Za-z0-9-]+$/;

// Find the running Postgres container by image so we don't depend on the
// compose project name Tilt happens to use.
async function findPostgresContainer() {
  const byImage = await runCapture("docker", [
    "ps",
    "--filter",
    `ancestor=${POSTGRES_IMAGE}`,
    "--format",
    "{{.ID}}",
  ]);
  const id = byImage.stdout.trim().split("\n")[0];
  if (id) {
    return id;
  }
  const byName = await runCapture("docker", [
    "ps",
    "--filter",
    "name=postgres",
    "--format",
    "{{.ID}}",
  ]);
  return byName.stdout.trim().split("\n")[0] || null;
}

function seedSql(parcels, sub) {
  return `INSERT INTO bng.projects (id, user_id, relationship_id, org_id, project)
VALUES ('${PROJECT_ID}', '${sub}', NULL, NULL,
  jsonb_build_object(
    'name', 'BMD-933 perf big baseline',
    'baseline', jsonb_build_object('habitats', (
      SELECT jsonb_agg(jsonb_build_object(
        'featureId', gen_random_uuid(),
        'parcelRef', 'p' || g,
        'habitat', 'Mixed scrub',
        'areaHectares', 0.5,
        'condition', 'Moderate'
      )) FROM generate_series(1, ${parcels}) g))))
ON CONFLICT (id) DO UPDATE
  SET user_id = EXCLUDED.user_id, project = EXCLUDED.project, updated_at = now();`;
}

/**
 * Upsert the fixed perf project with a `parcels`-parcel baseline, owned by
 * `sub`. Returns true on success, false (after logging) on failure.
 */
export async function seedPerfProject(sub, parcels = DEFAULT_PARCELS) {
  if (!SAFE_SUB.test(sub)) {
    error(`Refusing to seed for sub "${sub}" — expected only letters, digits and hyphens.`);
    return false;
  }
  const container = await findPostgresContainer();
  if (!container) {
    error(
      `Could not find a running Postgres container (image ${POSTGRES_IMAGE}). Is the Tilt stack up?`,
    );
    return false;
  }
  info(`▸ seeding a ${parcels}-parcel baseline project for ${sub} (idempotent upsert)…`);
  const code = await run("docker", [
    "exec",
    "-i",
    container,
    "psql",
    "-U",
    "dev",
    "-d",
    "bng_metric_backend",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    seedSql(parcels, sub),
  ]);
  if (code !== 0) {
    error("Seeding failed — see psql output above.");
    return false;
  }
  return true;
}

function argValue(argv, name) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const argv = process.argv.slice(2);
  const sub = argValue(argv, "sub") ?? PERF_USER_SUB;
  const parcelsArg = argValue(argv, "parcels");
  const parcels = parcelsArg === null ? DEFAULT_PARCELS : Number(parcelsArg);
  if (!Number.isInteger(parcels) || parcels <= 0) {
    error(`--parcels must be a positive integer, got "${parcelsArg}".`);
    process.exit(1);
  }
  if (!(await seedPerfProject(sub, parcels))) {
    process.exit(1);
  }
}
