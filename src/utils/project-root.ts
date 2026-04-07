import * as display from "./display.js";
import { getProjectRoot } from "./config.js";

export function requireProjectRoot(): string {
  try {
    return getProjectRoot();
  } catch {
    display.error("Not in a Rotifer project. Run 'rotifer init' first.");
    process.exit(1);
  }

  throw new Error("unreachable");
}
