/**
 * Report a broken bng-library scenario catalogue (scenarios.json) as a plain
 * message rather than a stack trace. The catalogue is checked when the
 * library is first imported, before any harness code runs, so this is
 * imported first and catches the error on its way out.
 */

import { error } from "../_lib.mjs";

process.on("uncaughtException", (err) => {
  if (err?.name === "ScenarioCatalogueError") {
    error(err.message);
    error("Fix bng-library's src/permutations/scenarios.json and run again.");
  } else {
    // What Node prints for an uncaught error; rethrowing here would exit 7.
    console.error(err);
  }
  process.exit(1);
});
