// Swappable logger used by the generator internals. Default mode is "cli":
// info/warn/header print to stdout with ANSI; error throws. Switch to
// "collect" before a buffer-API call so the same code paths push human-
// readable messages onto a captured array instead of writing to the console.
// "silent" drops info/warn entirely. error always throws — the CLI catches at
// its top level and prints; the buffer API surfaces the message as a thrown
// FlawSelectionError.

const ansi = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

let mode = "cli";
let collected = [];

export class FlawSelectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "FlawSelectionError";
  }
}

export function setMode(next) {
  mode = next;
}

export function drainMessages() {
  const out = collected;
  collected = [];
  return out;
}

export function color(name, text) {
  return `${ansi[name] ?? ""}${text}${ansi.reset}`;
}

export function header(label, colorName = "blue") {
  if (mode === "cli") {
    const line = "─".repeat(Math.max(0, 60 - label.length - 3));
    console.log(
      color(colorName, `\n${color("bold", `▸ ${label}`)} ${color("dim", line)}`),
    );
  } else if (mode === "collect") {
    collected.push({ level: "header", message: label });
  }
}

export function info(msg) {
  if (mode === "cli") {
    console.log(color("dim", msg));
  } else if (mode === "collect") {
    collected.push({ level: "info", message: msg });
  }
}

export function warn(msg) {
  if (mode === "cli") {
    console.log(color("yellow", `⚠ ${msg}`));
  } else if (mode === "collect") {
    collected.push({ level: "warn", message: msg });
  }
}

// Always throws. The CLI's top-level main() catches and prints; the buffer
// API lets it propagate to the web handler.
export function error(msg) {
  throw new FlawSelectionError(msg);
}

// Run `fn` with the logger in "collect" mode. Returns { result, messages }.
// Restores the previous mode in finally, so nested calls are safe even though
// the underlying state is module-global (this generator is one-shot per call).
export function captureMessages(fn) {
  const previous = mode;
  setMode("collect");
  try {
    const result = fn();
    return { result, messages: drainMessages() };
  } finally {
    setMode(previous);
  }
}
