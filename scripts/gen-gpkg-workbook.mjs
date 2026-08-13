/**
 * Workbook-driven generation for gen-gpkg: resolves a workbook source (local
 * path or HTTPS URL, with LFS-aware download caching), names the output pair,
 * and drives bng-lib's generateFromWorkbook for one workbook or a list file.
 *
 * Split out of gen-gpkg.mjs, which remains the CLI entry point.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { error, info, timestampSuffix } from "./_lib.mjs";
import {
  MODE_BASELINE,
  MODE_POST_INTERVENTION,
  generateFromWorkbook,
  readMetricWorkbook,
} from "#bng-lib";

const CACHE_DIR = path.resolve(import.meta.dirname, "..", ".cache", "bng500");

// Cache filenames are the first 16 hex chars of the URL's sha256 — plenty to
// avoid collisions across a workbook corpus while keeping names short.
const CACHE_KEY_HEX_CHARS = 16;

// A Git LFS pointer is a tiny text file; sniff the first line of anything
// suspiciously small to catch a raw.githubusercontent.com URL that returned
// the pointer instead of the real workbook.
const LFS_POINTER_MAX_BYTES = 1024;
const LFS_POINTER_SNIFF_BYTES = 64;

/**
 * Convert a GitHub HTML blob URL to the LFS-aware media URL. The BNG500
 * corpus uses Git LFS for the workbook files, so `raw.githubusercontent.com`
 * returns only the LFS pointer; `media.githubusercontent.com/media` resolves
 * the actual file content.
 */
function rewriteGithubBlobUrl(url) {
  const m = url.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/,
  );
  if (!m) {
    return url;
  }
  const [, owner, repo, ref, p] = m;
  return `https://media.githubusercontent.com/media/${owner}/${repo}/${ref}/${p}`;
}

async function downloadToCache(url) {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
  const hash = createHash("sha256")
    .update(url)
    .digest("hex")
    .slice(0, CACHE_KEY_HEX_CHARS);
  const ext = path.extname(new URL(url).pathname) || ".xlsx";
  const cached = path.join(CACHE_DIR, `${hash}${ext}`);
  if (existsSync(cached)) {
    info(`  cache hit: ${path.basename(cached)}`);
    return cached;
  }
  info(`  fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (
    buf.length < LFS_POINTER_MAX_BYTES &&
    buf
      .slice(0, LFS_POINTER_SNIFF_BYTES)
      .toString("utf8")
      .startsWith("version https://git-lfs")
  ) {
    throw new Error(
      `${url} returned a Git LFS pointer, not the actual file. ` +
        "Use the GitHub blob URL (or the media.githubusercontent.com/media URL) for LFS-tracked files.",
    );
  }
  writeFileSync(cached, buf);
  return cached;
}

/**
 * Resolve a workbook source (local path or HTTPS URL) to a local file path.
 * Returns the resolved path; downloads remote URLs into the cache.
 */
async function resolveWorkbookSource(ref) {
  const trimmed = ref.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    const url = rewriteGithubBlobUrl(trimmed);
    return downloadToCache(url);
  }
  const abs = path.resolve(trimmed);
  if (!existsSync(abs)) {
    throw new Error(`Workbook not found: ${abs}`);
  }
  return abs;
}

function workbookOutputNames(source) {
  // Strip trailing query/hash, keep last path segment, replace extension.
  const url = source.replace(/[?#].*$/, "");
  const base =
    path.basename(url).replace(/\.(xlsx|xlsm|xls)$/i, "") ||
    "bng-from-workbook";
  const ts = timestampSuffix();
  return {
    baseline: `${base}-baseline-${ts}.gpkg`,
    postIntervention: `${base}-post-intervention-${ts}.gpkg`,
  };
}

function workbookSummary(source, localPath, workbook) {
  return {
    source,
    resolvedPath: localPath,
    version: workbook.version,
    siteInfo: workbook.siteInfo,
    counts: {
      habitats: {
        baseline: workbook.habitats.baseline.length,
        created: workbook.habitats.created.length,
        enhancements: workbook.habitats.enhancements.length,
      },
      hedgerows: {
        baseline: workbook.hedgerows.baseline.length,
        created: workbook.hedgerows.created.length,
        enhancements: workbook.hedgerows.enhancements.length,
      },
      watercourses: {
        baseline: workbook.watercourses.baseline.length,
        created: workbook.watercourses.created.length,
        enhancements: workbook.watercourses.enhancements.length,
      },
      trees: {
        baseline: workbook.trees.baseline.length,
        created: workbook.trees.created.length,
      },
    },
    summary: workbook.summary,
  };
}

export async function runFromWorkbook(
  source,
  { outDir, strict, inspect, centre, mode },
) {
  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }
  const localPath = await resolveWorkbookSource(source);
  const workbook = readMetricWorkbook(localPath);

  if (inspect) {
    console.log(
      JSON.stringify(workbookSummary(source, localPath, workbook), null, 2),
    );
    return;
  }

  const names = workbookOutputNames(source);
  const outPaths = {
    baseline: path.join(outDir, names.baseline),
    postIntervention: path.join(outDir, names.postIntervention),
  };
  if (mode !== MODE_POST_INTERVENTION && existsSync(outPaths.baseline)) {
    unlinkSync(outPaths.baseline);
  }
  if (mode !== MODE_BASELINE && existsSync(outPaths.postIntervention)) {
    unlinkSync(outPaths.postIntervention);
  }

  generateFromWorkbook(outPaths, workbook, source, { strict, centre, mode });
}

function readWorkbookList(listPath) {
  return readFileSync(listPath, "utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

export async function runFromList(
  listPathArg,
  { outDir, strict, centre, mode },
) {
  const listPath = path.resolve(listPathArg);
  if (!existsSync(listPath)) {
    error(`--from-list file not found: ${listPath}`);
    process.exit(1);
  }
  const opts = { outDir, strict, inspect: false, centre, mode };
  for (const entry of readWorkbookList(listPath)) {
    try {
      await runFromWorkbook(entry, opts);
    } catch (e) {
      error(`Failed for ${entry}: ${e.message ?? e}`);
    }
  }
}
