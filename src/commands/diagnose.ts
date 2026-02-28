/**
 * Diagnose command wrapper
 *
 * Thin commander.js wrapper for diagnose CLI command.
 */

import { diagnoseCommand } from "../cli/diagnose";
import type { DiagnoseOptions } from "../cli/diagnose";

/**
 * Execute diagnose command with commander options
 *
 * @param options - Command options from commander
 */
export async function diagnose(options: DiagnoseOptions): Promise<void> {
  await diagnoseCommand(options);
}
