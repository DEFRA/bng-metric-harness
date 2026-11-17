/**
 * --processes for generate:scenarios: how many LibreOffice processes
 * recalculate the workbooks at once.
 */

import { availableParallelism } from "node:os";

// Digits only, no leading zero: so "1e9", "0x2" and " 2 ", which Number()
// would turn into whole numbers, are refused.
const WHOLE_NUMBER = /^[1-9]\d*$/;

/**
 * @param {string} text the option's value, empty when it was not given
 * @param {number} [cpus] the machine's CPUs: more processes than that is
 *   refused, as one per CPU is already the default
 * @returns {number | undefined} a whole number from 1 to `cpus`, or
 *   undefined for bng-library's default of one per CPU
 */
export function parseProcesses(text, cpus = availableParallelism()) {
  if (!text) {
    return undefined;
  }
  if (!WHOLE_NUMBER.test(text)) {
    throw new Error(
      `--processes must be a whole number of 1 or more (got: ${text})`,
    );
  }
  const processes = Number(text);
  if (processes > cpus) {
    throw new Error(
      `--processes ${text} is more than this machine's ${cpus} CPUs; one per CPU is already the default`,
    );
  }
  return processes;
}
