/**
 * --processes for generate:scenarios: how many LibreOffice processes
 * recalculate the workbooks at once.
 */

/**
 * @param {string} text the option's value, empty when it was not given
 * @returns {number | undefined} a whole number of 1 or more, or undefined
 *   for bng-library's default of one per CPU
 */
export function parseProcesses(text) {
  if (!text) {
    return undefined;
  }
  const processes = Number(text);
  if (!Number.isInteger(processes) || processes < 1) {
    throw new Error(
      `--processes must be a whole number of 1 or more (got: ${text})`,
    );
  }
  return processes;
}
