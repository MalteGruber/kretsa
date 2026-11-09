// Schematic connectivity, from `kicad-cli sch export netlist` (GET /api/netlist).
// Used for net cross-probing: nets are matched between schematic and PCB through their pins
// ("U3.4" = symbol U3 pin 4 = footprint U3 pad 4), so naming differences don't matter.

export interface NetlistNet {
  name: string; // e.g. "/VBUS", "GND", "Net-(U2-EN)"
  nodes: string[]; // "REF.PIN"
}

export interface Netlist {
  nets: NetlistNet[];
}
