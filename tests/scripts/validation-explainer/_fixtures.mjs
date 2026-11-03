import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A scratch directory, and a way to write files into it by relative path. */
export function scratchDir() {
  const root = mkdtempSync(path.join(tmpdir(), "validation-explainer-"));
  return {
    root,
    write(relative, text) {
      const file = path.join(root, relative);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, text);
      return file;
    },
    remove() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
