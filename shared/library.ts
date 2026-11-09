// Component libraries as kretsa sees them: parts = symbol + footprint + 3D model.
// Libraries come only from KiCad lib tables (sym-lib-table / fp-lib-table) in the project and the
// workspace root, never KiCad's stock libraries: every part in a kretsa workflow is made by the agent.

export type Level = "error" | "warning" | "info";

export interface PartIssue {
  level: Level;
  code: string; // e.g. "pin_without_pad", "model_missing"
  text: string;
}

export interface LibraryRef {
  kind: "sym" | "fp";
  name: string; // nickname from the lib table
  uri: string; // as written in the table
  path: string; // resolved absolute path
  table: string; // which lib table file
  exists: boolean;
}

export interface PartSummary {
  id: string; // "Lib:Name"
  lib: string;
  name: string;
  reference: string;
  value: string;
  description: string;
  footprint: string; // "Lib:Name" as written in the symbol ("" if none)
  power: boolean;
  pins: number;
  units: number;
  hasModel: boolean;
  errors: number;
  warnings: number;
}

export interface Pin {
  number: string;
  name: string;
  type: string; // input, output, bidirectional, passive, power_in, ...
  shape: string;
  unit: number; // 0 = common to all units
  hidden: boolean;
  at: [number, number, number]; // x, y (mm, symbol coords, y up), rotation
  length: number;
  alternates: { name: string; type: string }[];
}

export interface Pad {
  number: string;
  type: string; // smd, thru_hole, np_thru_hole, connect
  shape: string;
  at: [number, number, number];
  size: [number, number];
  drill?: number[];
  layers: string[];
}

export interface Model {
  path: string; // as written
  resolved: string;
  exists: boolean;
  offset: [number, number, number];
  scale: [number, number, number];
  rotate: [number, number, number];
}

export interface FootprintDetail {
  id: string;
  file: string;
  description: string;
  attributes: string[]; // smd, through_hole, exclude_from_bom, ...
  pads: Pad[];
  /** Bounding boxes (mm, footprint coords, y down) per layer group, when present. */
  courtyard?: [number, number, number, number];
  fab?: [number, number, number, number];
  models: Model[];
}

export interface PartDetail extends PartSummary {
  file: string;
  fields: Record<string, string>;
  extends?: string;
  pinList: Pin[];
  footprintDetail?: FootprintDetail;
  issues: PartIssue[];
}

export interface LibraryInfo {
  libraries: LibraryRef[];
  parts: PartSummary[];
  /** Footprints not used by any symbol of these libraries. */
  orphanFootprints: string[];
}
