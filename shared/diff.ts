// What changed in the design between two revisions (`kretsa diff`, GET /api/diff).

export interface PartChange {
  ref: string;
  kind: "added" | "removed" | "changed";
  details: string[]; // "moved 2.1 mm on the board: …", "value 10k → 4k7", …
  at_mm?: [number, number]; // board position (new, or last known for removed parts)
}

export interface DesignDiff {
  from: string; // rev
  to: string;
  parts: PartChange[];
  /** Pads whose net changed. */
  padNets: { pad: string; from: string; to: string }[];
  /** Nets whose routing changed: [before, after]. */
  routing: { net: string; segments: [number, number]; length_mm: [number, number]; vias: [number, number] }[];
}
