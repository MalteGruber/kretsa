// Markdown views of libraries and parts, written for an LLM to read.

import type { FootprintDetail, LibraryInfo, PartDetail, PartIssue } from "../../shared/library";
import type { PartRenders } from "./render";

const f2 = (n: number) => +n.toFixed(3);
const fmtIssue = (i: PartIssue) => `- **${i.level}** \`${i.code}\` ${i.text}`;

export function libraryMarkdown(info: LibraryInfo, opts: { query?: string; issuesOnly?: boolean } = {}): string {
  const lines = ["# Libraries", ""];
  if (!info.libraries.length) {
    lines.push("No libraries: there is no sym-lib-table / fp-lib-table in this project or the workspace root.",
      "Create project libraries and register them with `${KIPRJMOD}`-relative URIs, for example:",
      "", "```", '(sym_lib_table (version 7)', '  (lib (name "Project")(type "KiCad")(uri "${KIPRJMOD}/lib/Project.kicad_sym")(options "")(descr "")))', "```", "");
    return lines.join("\n");
  }
  for (const l of info.libraries) lines.push(`- ${l.kind === "sym" ? "symbols" : "footprints"} **${l.name}**: ${l.path}${l.exists ? "" : "  ⚠ NOT FOUND"}`);
  lines.push("");
  const q = opts.query?.toLowerCase();
  let parts = info.parts.filter((p) => !q || `${p.id} ${p.value} ${p.description}`.toLowerCase().includes(q));
  if (opts.issuesOnly) parts = parts.filter((p) => p.errors || p.warnings);
  const errs = info.parts.reduce((n, p) => n + p.errors, 0), warns = info.parts.reduce((n, p) => n + p.warnings, 0);
  lines.push(`${info.parts.length} parts · ${errs} errors · ${warns} warnings${q ? ` · ${parts.length} match "${opts.query}"` : ""}`, "");
  if (parts.length) {
    lines.push("| part | ref | value | footprint | pins | 3D | issues |", "|---|---|---|---|---|---|---|");
    for (const p of parts) {
      const issues = [p.errors && `${p.errors} err`, p.warnings && `${p.warnings} warn`].filter(Boolean).join(", ");
      lines.push(`| ${p.id} | ${p.reference} | ${p.value} | ${p.power ? "(power)" : p.footprint || "—"} | ${p.pins}${p.units > 1 ? ` (${p.units} units)` : ""} | ${p.power ? "" : p.hasModel ? "✓" : "✗"} | ${issues} |`);
    }
    lines.push("");
  }
  if (info.orphanFootprints.length && !q) {
    lines.push(`Footprints no symbol uses (${info.orphanFootprints.length}): ${info.orphanFootprints.slice(0, 40).join(", ")}${info.orphanFootprints.length > 40 ? ", …" : ""}`, "");
  }
  lines.push("Details and renders: `kretsa lib show <part>`.", "");
  return lines.join("\n");
}

export function footprintMarkdown(fp: FootprintDetail): string[] {
  const lines = [`## Footprint ${fp.id}`, "", `File: ${fp.file}`];
  if (fp.description) lines.push(`Description: ${fp.description}`);
  if (fp.attributes.length) lines.push(`Attributes: ${fp.attributes.join(", ")}`);
  const box = (b?: number[]) => (b ? `${f2(b[2]! - b[0]!)} × ${f2(b[3]! - b[1]!)} mm (x ${f2(b[0]!)}…${f2(b[2]!)}, y ${f2(b[1]!)}…${f2(b[3]!)})` : "none");
  lines.push(`Courtyard: ${box(fp.courtyard)}`, `Fab outline: ${box(fp.fab)}`, "");
  lines.push(`### Pads (${fp.pads.length}), mm, footprint coords (y down)`, "", "| pad | type | shape | x | y | rot | w × h | drill | layers |", "|---|---|---|---|---|---|---|---|---|");
  for (const p of fp.pads) {
    lines.push(`| ${p.number || "—"} | ${p.type} | ${p.shape} | ${f2(p.at[0])} | ${f2(p.at[1])} | ${p.at[2] || ""} | ${f2(p.size[0])} × ${f2(p.size[1])} | ${p.drill?.map(f2).join(" × ") ?? ""} | ${p.layers.join(" ")} |`);
  }
  lines.push("");
  if (fp.models.length) {
    lines.push("### 3D models", "");
    for (const m of fp.models) {
      lines.push(`- ${m.path}${m.exists ? "" : "  ⚠ NOT FOUND"}`, `  offset ${m.offset.join(", ")} mm · rotate ${m.rotate.join(", ")}° · scale ${m.scale.join(", ")}`);
    }
    lines.push("");
  }
  return lines;
}

export function partMarkdown(p: PartDetail, renders?: PartRenders): string {
  const lines = [`# ${p.id}`, "", `Library file: ${p.file}`];
  if (p.extends) lines.push(`Extends: ${p.extends}`);
  lines.push("", "## Fields", "");
  for (const [k, v] of Object.entries(p.fields)) if (v && !k.startsWith("ki_")) lines.push(`- ${k}: ${v}`);
  lines.push("");
  lines.push(p.issues.length ? "## Issues" : "## Issues: none ✓", "");
  for (const i of p.issues) lines.push(fmtIssue(i));
  if (p.issues.length) lines.push("");

  const pads = new Map((p.footprintDetail?.pads ?? []).map((x) => [x.number, x]));
  lines.push(`## Pins (${p.pins}${p.units > 1 ? `, ${p.units} units` : ""})`, "", "| pin | name | type | unit | pad | alternates |", "|---|---|---|---|---|---|");
  const sorted = [...p.pinList].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  for (const pin of sorted) {
    const pad = pads.get(pin.number);
    const alts = pin.alternates.length ? pin.alternates.map((a) => a.name).slice(0, 8).join(", ") + (pin.alternates.length > 8 ? ` (+${pin.alternates.length - 8})` : "") : "";
    lines.push(`| ${pin.number} | ${pin.name}${pin.hidden ? " (hidden)" : ""} | ${pin.type} | ${pin.unit || "all"} | ${p.footprintDetail ? (pad ? pad.type : "**missing**") : ""} | ${alts} |`);
  }
  lines.push("");
  if (p.footprintDetail) lines.push(...footprintMarkdown(p.footprintDetail));
  if (renders) {
    lines.push("## Renders (look at these)", "");
    for (const s of renders.symbol) lines.push(`- symbol: ${s}`);
    if (renders.footprint) lines.push(`- footprint (all layers, pad numbers on fab): ${renders.footprint}`);
    for (const s of renders.threeD) lines.push(`- 3D: ${s}`);
    for (const e of renders.errors) lines.push(`- ⚠ ${e}`);
    lines.push("");
  }
  return lines.join("\n");
}
