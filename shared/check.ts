// Design checks: kicad-cli ERC (schematic) + DRC with schematic parity (PCB), normalized.
// Produced by core/src/check.ts; served at GET /api/check and printed by `kretsa check`.

export type CheckSource = "erc" | "drc" | "unconnected" | "parity";
export type Severity = "error" | "warning" | "info" | "exclusion";

export interface CheckItem {
  text: string; // KiCad's description, e.g. "Pad 2 [GND] of C1 on F.Cu"
  ref?: string; // refdes parsed from the description, when there is one
  at_mm?: [number, number];
  uuid?: string;
}

export interface Violation {
  /** Stable across runs while the same problem persists (type + item descriptions); used for diffs. */
  key: string;
  source: CheckSource;
  type: string; // KiCad's check id, e.g. "clearance", "pin_not_connected"
  severity: Severity;
  text: string;
  /** Library lookup noise (symbol/footprint differs from or is missing in the library). */
  library: boolean;
  /** Schematic sheet for ERC: readable path ("/", "/power/") and KiCad's UUID path (for navigation). */
  sheet?: string;
  sheet_uuid?: string;
  items: CheckItem[];
}

export interface CheckReport {
  rev: string; // project rev the check ran against
  at: string; // ISO time
  kicad: string | null;
  /** Which checks ran; a missing file or failed run is listed in `errors`. */
  ran: { erc: boolean; drc: boolean };
  errors: string[];
  violations: Violation[];
}

export interface CheckDiff {
  added: Violation[];
  fixed: Violation[];
  since: string | null; // rev of the baseline
}
