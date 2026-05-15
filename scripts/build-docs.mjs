#!/usr/bin/env node
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { visit } from "unist-util-visit";

import { color, HARNESS_ROOT, header, info, warn } from "./_lib.mjs";

const SIBLING_ROOT = process.env.SIBLING_ROOT
  ? path.resolve(process.env.SIBLING_ROOT)
  : path.resolve(HARNESS_ROOT, "..");

const SITE_SRC = path.resolve(HARNESS_ROOT, "site_src", "docs");
const GENERATED_YAML = path.resolve(HARNESS_ROOT, "mkdocs.generated.yml");

// Every repo is treated uniformly. README is always pulled. `docs/` is included
// when present — the harness has none today, but will be picked up automatically.
const REPOS = [
  { slug: "harness", name: "bng-metric-harness", title: "Harness" },
  { slug: "frontend", name: "bng-metric-frontend", title: "Frontend" },
  { slug: "backend", name: "bng-metric-backend", title: "Backend" },
];

const GITHUB_ORG = "DEFRA";
const SHORT_SHA_LEN = 12;
const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
]);

function repoRoot(repo) {
  return path.resolve(SIBLING_ROOT, repo.name);
}

function rawGithubUrl(repoName, repoRelPath) {
  return `https://raw.githubusercontent.com/${GITHUB_ORG}/${repoName}/HEAD/${repoRelPath}`;
}

function blobGithubUrl(repoName, repoRelPath) {
  return `https://github.com/${GITHUB_ORG}/${repoName}/blob/HEAD/${repoRelPath}`;
}

async function walkMarkdown(dir) {
  const out = [];
  if (!existsSync(dir)) {
    return out;
  }
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkMarkdown(full)));
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

// Discover every markdown file we plan to copy. Returns:
//   { manifest: Map<absSourcePath, { absDestPath, repo, relInSection }>,
//     bySection: Map<repoSlug, Array<{ absSourcePath, absDestPath, kind, relInSection, title }>> }
async function discoverDocs() {
  const manifest = new Map();
  const bySection = new Map();

  for (const repo of REPOS) {
    const root = repoRoot(repo);
    if (!existsSync(root)) {
      warn(`Skipping ${repo.name}: not found at ${root}`);
      continue;
    }

    const entries = [];

    const readmePath = path.join(root, "README.md");
    if (existsSync(readmePath)) {
      const destPath = path.join(SITE_SRC, repo.slug, "index.md");
      manifest.set(readmePath, { absDestPath: destPath, repo, relInSection: "index.md" });
      entries.push({
        absSourcePath: readmePath,
        absDestPath: destPath,
        kind: "readme",
        relInSection: "index.md",
        title: "Overview",
      });
    } else {
      warn(`${repo.name} has no README.md at its root.`);
    }

    const docsDir = path.join(root, "docs");
    const docFiles = await walkMarkdown(docsDir);
    for (const src of docFiles) {
      const repoRel = path.relative(docsDir, src);
      // Normalize: lower-case every path segment so GitHub Pages (case-sensitive)
      // matches what macOS dev (case-insensitive) sees.
      const lowered = repoRel.split(path.sep).map((s) => s.toLowerCase()).join("/");
      const destPath = path.join(SITE_SRC, repo.slug, lowered);
      manifest.set(src, { absDestPath: destPath, repo, relInSection: lowered });
      entries.push({
        absSourcePath: src,
        absDestPath: destPath,
        kind: "doc",
        relInSection: lowered,
        title: titleFromSlug(path.basename(lowered, ".md")),
      });
    }

    bySection.set(repo.slug, entries);
  }

  return { manifest, bySection };
}

const ACRONYMS = new Set(["csrf", "api", "db", "gis", "id", "url", "sql", "cdp"]);

function titleFromSlug(slug) {
  return slug
    .replace(/[-_]+/g, " ")
    .split(" ")
    .map((word) =>
      ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.replace(/\b\w/g, (c) => c.toUpperCase()),
    )
    .join(" ");
}

function splitFragment(url) {
  const hashIdx = url.indexOf("#");
  if (hashIdx === -1) {
    return { base: url, fragment: "" };
  }
  return { base: url.slice(0, hashIdx), fragment: url.slice(hashIdx) };
}

function shouldRewriteUrl(url) {
  if (!url) {
    return false;
  }
  if (url.startsWith("#")) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return false;
  }
  if (url.startsWith("//")) {
    return false;
  }
  return true;
}

function rewriteUrl(url, { sourceFile, destFile, repo, manifest }) {
  if (!shouldRewriteUrl(url)) {
    return url;
  }

  const { base, fragment } = splitFragment(url);
  if (!base) {
    return url;
  }

  const absSource = path.resolve(path.dirname(sourceFile), base);

  // 1. If the link points to a file we copied into the site, rewrite as a relative path.
  const hit = manifest.get(absSource);
  if (hit) {
    const rel = path.relative(path.dirname(destFile), hit.absDestPath);
    return `${rel}${fragment}`;
  }

  // 2. Otherwise it's an external-to-the-site repo-relative path.
  //    Rewrite to a canonical GitHub URL so it still resolves.
  const root = repoRoot(repo);
  const insideRepo = !path.relative(root, absSource).startsWith("..");
  if (!insideRepo) {
    // Points outside the repo entirely (rare). Leave as-is and warn.
    warn(`${path.relative(SIBLING_ROOT, sourceFile)}: link "${url}" escapes its repo; leaving unchanged.`);
    return url;
  }

  const repoRel = path.relative(root, absSource).split(path.sep).join("/");
  const ext = path.extname(repoRel).toLowerCase();
  const url2 = IMAGE_EXTENSIONS.has(ext)
    ? rawGithubUrl(repo.name, repoRel)
    : blobGithubUrl(repo.name, repoRel);
  return `${url2}${fragment}`;
}

// Conservatively rewrite src="..." and href="..." in raw HTML embedded in markdown.
function rewriteHtmlAttrs(html, ctx) {
  return html.replace(
    /\b(src|href)=("([^"]*)"|'([^']*)')/g,
    (_m, attr, _q, dq, sq) => {
      const orig = dq ?? sq ?? "";
      const next = rewriteUrl(orig, ctx);
      return `${attr}="${next}"`;
    },
  );
}

const URL_NODE_TYPES = new Set(["link", "image", "definition"]);

function makeLinkRewriter(ctx) {
  return () => (tree) => {
    visit(tree, (node) => {
      if (URL_NODE_TYPES.has(node.type)) {
        node.url = rewriteUrl(node.url, ctx);
        return;
      }
      if (node.type === "html" && typeof node.value === "string") {
        node.value = rewriteHtmlAttrs(node.value, ctx);
      }
    });
  };
}

async function transformAndWrite({ absSourcePath, absDestPath, repo, manifest }) {
  const src = await readFile(absSourcePath, "utf8");
  const processor = unified()
    .use(remarkParse)
    .use(makeLinkRewriter({ sourceFile: absSourcePath, destFile: absDestPath, repo, manifest }))
    .use(remarkStringify, {
      bullet: "-",
      fences: true,
      listItemIndent: "one",
      rule: "-",
    });
  const out = String(await processor.process(src));
  await mkdir(path.dirname(absDestPath), { recursive: true });
  await writeFile(absDestPath, out, "utf8");
}

function navForSection(repo, entries) {
  // README first, then docs alphabetically by relInSection.
  const readme = entries.find((e) => e.kind === "readme");
  const docs = entries
    .filter((e) => e.kind === "doc")
    .sort((a, b) => a.relInSection.localeCompare(b.relInSection));

  const items = [];
  if (readme) {
    items.push({ Overview: `${repo.slug}/index.md` });
  }
  for (const d of docs) {
    items.push({ [d.title]: `${repo.slug}/${d.relInSection}` });
  }
  return items;
}

function yamlStringifyNav(nav) {
  // Hand-roll YAML emission — keeps the dep list small and produces a clean,
  // diff-friendly output. Schema: array of { Title: value } where value is
  // either a string (page path) or an array of the same shape.
  const lines = ["nav:"];
  function emit(items, indent) {
    for (const item of items) {
      const [title] = Object.keys(item);
      const value = item[title];
      const pad = "  ".repeat(indent);
      if (typeof value === "string") {
        lines.push(`${pad}- ${quote(title)}: ${value}`);
      } else {
        lines.push(`${pad}- ${quote(title)}:`);
        emit(value, indent + 1);
      }
    }
  }
  emit(nav, 1);
  return lines.join("\n") + "\n";
}

function quote(s) {
  // Quote titles that contain YAML-significant characters.
  if (/[:#&*!|>%@`,?\-{}[\]]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replaceAll('"', String.raw`\"`)}"`;
  }
  return s;
}

async function writeStaticAssets() {
  const css = `/* Architecture page: let the LikeC4 iframe use the full content area. */
.md-content--full-bleed {
  margin: 0 -1.2rem;
}

.md-content--full-bleed .architecture-frame {
  width: 100%;
  height: calc(100vh - 8rem);
  border: 0;
  display: block;
}
`;
  const dest = path.join(SITE_SRC, "assets", "full-bleed.css");
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, css, "utf8");
}

async function writeArchitecturePage() {
  const dest = path.join(SITE_SRC, "architecture", "index.md");
  const body = `---
title: Architecture
hide:
  - toc
---

# Architecture

Interactive diagram explorer built from the LikeC4 sources in the harness repo.

<div class="md-content--full-bleed" markdown>
<iframe class="architecture-frame" src="./app/" title="LikeC4 architecture explorer"></iframe>
</div>

[Open in a new tab](./app/){:target="_blank"}
`;
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, body, "utf8");
}

async function writeLandingPage(bySection) {
  const dest = path.join(SITE_SRC, "index.md");
  const cards = REPOS.filter((r) => bySection.has(r.slug)).map(
    (r) => `- **[${r.title}](${r.slug}/index.md)** — documentation for \`${r.name}\``,
  );
  const body = `# BNG Metric documentation

This site aggregates documentation across the three repositories that make up
the BNG Metric service:

${cards.join("\n")}
- **[Architecture](architecture/index.md)** — interactive LikeC4 diagram explorer

Rebuilds nightly and on manual trigger from the
[\`bng-metric-harness\`](https://github.com/${GITHUB_ORG}/bng-metric-harness)
repository.
`;
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, body, "utf8");
}

async function resolveRef(gitDir, ref) {
  const refPath = path.join(gitDir, ref);
  if (existsSync(refPath)) {
    return (await readFile(refPath, "utf8")).trim();
  }
  // Packed refs fallback.
  const packed = path.join(gitDir, "packed-refs");
  if (!existsSync(packed)) {
    return null;
  }
  const lines = (await readFile(packed, "utf8")).split("\n");
  const hit = lines.find((l) => l.endsWith(` ${ref}`));
  return hit ? hit.split(" ")[0] : null;
}

async function readGitSha(repoDir) {
  const gitDir = path.join(repoDir, ".git");
  if (!existsSync(gitDir)) {
    return null;
  }
  try {
    const head = await readFile(path.join(gitDir, "HEAD"), "utf8");
    const refMatch = head.match(/^ref:\s*(.+?)\s*$/);
    if (!refMatch) {
      return head.trim();
    }
    return await resolveRef(gitDir, refMatch[1]);
  } catch {
    return null;
  }
}

async function writeBuildInfo() {
  const dest = path.join(SITE_SRC, "_build-info.md");
  const rows = [];
  for (const repo of REPOS) {
    const root = repoRoot(repo);
    const present = existsSync(root);
    const sha = present ? await readGitSha(root) : null;
    const presentCell = present ? "yes" : "missing";
    const shaCell = sha ? `\`${sha.slice(0, SHORT_SHA_LEN)}\`` : "—";
    rows.push(`| ${repo.name} | ${presentCell} | ${shaCell} |`);
  }
  const body = `---
title: Build info
hide:
  - navigation
---

# Build info

Snapshot of the inputs to the most recent docs build.

| Repository | Present | HEAD |
| ---------- | ------- | ---- |
${rows.join("\n")}

Built on ${new Date().toISOString()}.
`;
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, body, "utf8");
}

async function writeMkdocsGenerated(bySection) {
  const nav = [{ Home: "index.md" }];
  for (const repo of REPOS) {
    const entries = bySection.get(repo.slug);
    if (!entries || entries.length === 0) {
      continue;
    }
    nav.push({ [repo.title]: navForSection(repo, entries) });
  }
  nav.push(
    { Architecture: "architecture/index.md" },
    { "Build info": "_build-info.md" },
  );

  const preamble = `# Generated by scripts/build-docs.mjs — DO NOT EDIT.
# This file is included via INHERIT: from mkdocs.yml.
`;
  await writeFile(GENERATED_YAML, `${preamble}\n${yamlStringifyNav(nav)}`, "utf8");
}

async function main() {
  header("Aggregating docs from sibling repos");
  info(`SIBLING_ROOT = ${SIBLING_ROOT}`);

  // Clean previous output so renames/removals don't leak.
  if (existsSync(SITE_SRC)) {
    await rm(SITE_SRC, { recursive: true, force: true });
  }
  await mkdir(SITE_SRC, { recursive: true });

  const { manifest, bySection } = await discoverDocs();

  let copied = 0;
  for (const [absSourcePath, { absDestPath, repo }] of manifest) {
    await transformAndWrite({ absSourcePath, absDestPath, repo, manifest });
    copied++;
  }

  await writeLandingPage(bySection);
  await writeArchitecturePage();
  await writeBuildInfo();
  await writeStaticAssets();
  await writeMkdocsGenerated(bySection);

  console.log(color("green", `✓ Aggregated ${copied} markdown file(s)`));
  for (const repo of REPOS) {
    const entries = bySection.get(repo.slug) ?? [];
    console.log(
      color("dim", `  ${repo.slug.padEnd(8)} — ${entries.length} file(s)`),
    );
  }
  console.log(color("dim", `Output: ${path.relative(HARNESS_ROOT, SITE_SRC)}/`));
  console.log(color("dim", `Nav:    ${path.relative(HARNESS_ROOT, GENERATED_YAML)}`));
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
