// ERC + DRC via kicad-cli, normalized into a CheckReport, with diffs and LLM-friendly markdown.

import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CheckDiff, CheckItem, CheckReport, CheckSource, Severity, Violation } from "../../shared/check";
import type { ProjectInfo } from "../../shared/review";
import { CLI } from "./kicad";
import { mainPcb, rootSchematic } from "./project";

/** KiCad checks that only say "differs from / missing in the library". Noisy without the user's libraries. */
const LIBRARY_TYPES = new Set(["lib_symbol_issues", "lib_symbol_mismatch", "footprint_link_issues", "lib_footprint_issues", "lib_footprint_mismatch"]);

const exists = (p: string) => stat(p).then(() => true, () => false);

/**
 * Run kicad-cli in the project dir. kicad-cli writes a .kicad_prl next to the input if there is none;
 * remove it again so we never leave files in the user's project.
 */
async function runCli(args: string[], projectDir: string, input: string): Promise<{ code: number; out: string }> {
  const prl = input.replace(/\.kicad_(sch|pcb)$/, ".kicad_prl");
  const hadPrl = await exists(prl);
  try {
    const p = Bun.spawn([CLI, ...args, input], { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
    const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out: o + e };
  } finally {
    if (!hadPrl) await rm(prl, { force: true });
  }
}

const REF = /\b(?:Symbol|of|Footprint)\s+([A-Za-z#]+[\w]*\d+[A-Za-z]?)\b/;

function item(raw: any): CheckItem {
  const text = String(raw?.description ?? "");
  const ref = text.match(REF)?.[1];
  const at = raw?.pos && typeof raw.pos.x === "number" ? [round(raw.pos.x), round(raw.pos.y)] as [number, number] : undefined;
  return { text, ...(ref && { ref }), ...(at && { at_mm: at }), ...(raw?.uuid && { uuid: raw.uuid }) };
}
const round = (n: number) => Math.round(n * 1000) / 1000;

function violation(raw: any, source: CheckSource, sheet?: string, sheetUuid?: string): Violation {
  const items: CheckItem[] = (raw?.items ?? []).map(item);
  const type = String(raw?.type ?? "unknown");
  return {
    key: [source, type, ...items.map((i) => i.text).sort()].join("|"),
    source, type,
    severity: (raw?.severity ?? "error") as Severity,
    text: String(raw?.description ?? type),
    library: LIBRARY_TYPES.has(type),
    ...(sheet && { sheet }),
    ...(sheetUuid && { sheet_uuid: sheetUuid }),
    items,
  };
}

async function erc(projectDir: string, sch: string, tmp: string): Promise<Violation[]> {
  const out = join(tmp, `erc-${process.pid}-${Date.now()}.json`);
  try {
    const r = await runCli(["sch", "erc", "--format", "json", "--units", "mm", "--severity-all", "-o", out], projectDir, sch);
    if (!(await exists(out))) throw new Error(`kicad-cli sch erc failed (exit ${r.code}): ${r.out.trim()}`);
    const j = JSON.parse(await readFile(out, "utf8"));
    return (j.sheets ?? []).flatMap((s: any) => (s.violations ?? []).map((v: any) => violation(v, "erc", s.path, s.uuid_path)));
  } finally { await rm(out, { force: true }); }
}

async function drc(projectDir: string, pcb: string, parity: boolean, tmp: string): Promise<Violation[]> {
  const out = join(tmp, `drc-${process.pid}-${Date.now()}.json`);
  try {
    const args = ["pcb", "drc", "--format", "json", "--units", "mm", "--severity-all", ...(parity ? ["--schematic-parity"] : []), "-o", out];
    const r = await runCli(args, projectDir, pcb);
    if (!(await exists(out))) throw new Error(`kicad-cli pcb drc failed (exit ${r.code}): ${r.out.trim()}`);
    const j = JSON.parse(await readFile(out, "utf8"));
    return [
      ...(j.violations ?? []).map((v: any) => violation(v, "drc")),
      ...(j.unconnected_items ?? []).map((v: any) => violation(v, "unconnected")),
      ...(j.schematic_parity ?? []).map((v: any) => violation(v, "parity")),
    ];
  } finally { await rm(out, { force: true }); }
}

/** Bump when the report format changes, so cached reports are not reused. */
export const REPORT_VERSION = 2;

const inflight = new Map<string, Promise<CheckReport>>();

/**
 * ERC on the root schematic + DRC (with schematic parity when there is a schematic) on the board.
 * Cached per project rev in <project>/.kretsa/check/<rev>.json; concurrent calls share one run.
 */
export function runChecks(project: ProjectInfo, kicad: string | null, opts: { erc?: boolean; drc?: boolean } = {}): Promise<CheckReport> {
  const want = { erc: opts.erc ?? true, drc: opts.drc ?? true };
  const key = `${project.dir}@${project.rev}:${want.erc}${want.drc}`;
  let job = inflight.get(key);
  if (!job) {
    job = doRun(project, kicad, want).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return job;
}

async function doRun(project: ProjectInfo, kicad: string | null, want: { erc: boolean; drc: boolean }): Promise<CheckReport> {
  const dir = join(project.dir, ".kretsa", "check");
  const cacheFile = join(dir, `${project.rev}.v${REPORT_VERSION}.json`);
  if (want.erc && want.drc) {
    const cached = await readFile(cacheFile, "utf8").then((s) => JSON.parse(s) as CheckReport, () => null);
    if (cached) return cached;
  }
  await mkdir(dir, { recursive: true });
  const report: CheckReport = { rev: project.rev, at: new Date().toISOString(), kicad, ran: { erc: false, drc: false }, errors: [], violations: [] };
  if (!kicad) {
    report.errors.push("kicad-cli not found (set KICAD_CLI)");
    return report;
  }
  const sch = rootSchematic(project), pcb = mainPcb(project);
  const jobs: Promise<void>[] = [];
  if (want.erc) {
    if (!sch) report.errors.push("ERC skipped: no .kicad_sch");
    else jobs.push(erc(project.dir, join(project.dir, sch), dir).then(
      (v) => { report.violations.push(...v); report.ran.erc = true; },
      (e) => { report.errors.push(String(e.message ?? e)); }));
  }
  if (want.drc) {
    if (!pcb) report.errors.push("DRC skipped: no .kicad_pcb");
    else jobs.push(drc(project.dir, join(project.dir, pcb), !!sch, dir).then(
      (v) => { report.violations.push(...v); report.ran.drc = true; },
      (e) => { report.errors.push(String(e.message ?? e)); }));
  }
  await Promise.all(jobs);
  const order: CheckSource[] = ["erc", "drc", "unconnected", "parity"];
  report.violations.sort((a, b) => order.indexOf(a.source) - order.indexOf(b.source) || sevRank(a) - sevRank(b) || a.type.localeCompare(b.type));
  if (want.erc && want.drc && !report.errors.length) await Bun.write(cacheFile, JSON.stringify(report, null, 1));
  return report;
}

const sevRank = (v: Violation) => ["error", "warning", "info", "exclusion"].indexOf(v.severity);

export function diffChecks(prev: CheckReport | null, cur: CheckReport): CheckDiff {
  if (!prev) return { added: [], fixed: [], since: null };
  const before = new Set(prev.violations.map((v) => v.key));
  const after = new Set(cur.violations.map((v) => v.key));
  return {
    added: cur.violations.filter((v) => !before.has(v.key)),
    fixed: prev.violations.filter((v) => !after.has(v.key)),
    since: prev.rev,
  };
}

// ---------- markdown for agents ----------

const SOURCE_TITLE: Record<CheckSource, string> = {
  erc: "Schematic (ERC)",
  drc: "PCB design rules (DRC)",
  unconnected: "PCB unrouted connections",
  parity: "Schematic ↔ PCB mismatches (update PCB from schematic)",
};

function fmtItem(i: CheckItem): string {
  return i.at_mm ? `${i.text} @ (${i.at_mm[0]}, ${i.at_mm[1]})` : i.text;
}

function fmtViolation(v: Violation, times = 1): string {
  const where = v.items.map(fmtItem).join("; ");
  return `- **${v.severity}** \`${v.type}\` ${v.text}${where ? ` — ${where}` : ""}${times > 1 ? ` (×${times} identical, first position shown)` : ""}`;
}

/** Collapse violations whose message and items are identical apart from position (e.g. the 12 vias of one thermal pad). */
function collapse(vs: Violation[]): [Violation, number][] {
  const groups = new Map<string, [Violation, number]>();
  for (const v of vs) {
    const refs = v.items.map((i) => i.text).sort().join(",");
    const k = `${v.type}|${v.text}|${refs}`;
    const g = groups.get(k);
    if (g) g[1]++;
    else groups.set(k, [v, 1]);
  }
  return [...groups.values()];
}

export interface MarkdownOpts {
  /** Max violations listed per section (rest summarized). */
  limit?: number;
  /** List library-lookup warnings individually instead of only counting them. */
  library?: boolean;
  diff?: CheckDiff;
}

export function checkMarkdown(r: CheckReport, opts: MarkdownOpts = {}): string {
  const limit = opts.limit ?? 25;
  const real = r.violations.filter((v) => !v.library);
  const lib = r.violations.filter((v) => v.library);
  const count = (vs: Violation[], s: Severity) => vs.filter((v) => v.severity === s).length;
  const lines = [
    `# Design check · rev ${r.rev}`,
    "",
    `ERC: ${r.ran.erc ? "ran" : "not run"} · DRC: ${r.ran.drc ? "ran" : "not run"} · ` +
      `**${count(real, "error")} errors, ${count(real, "warning")} warnings**` +
      (lib.length ? ` · ${lib.length} library-lookup warnings (hidden${opts.library ? "" : "; --library to list"})` : ""),
    "",
  ];
  for (const e of r.errors) lines.push(`> ⚠ ${e}`, "");

  const d = opts.diff;
  if (d && d.since) {
    const addedReal = d.added.filter((v) => !v.library), fixedReal = d.fixed.filter((v) => !v.library);
    lines.push(`## Since last check (rev ${d.since}): ${addedReal.length} new, ${fixedReal.length} fixed`, "");
    for (const v of addedReal.slice(0, limit)) lines.push(`${fmtViolation(v)}  ← NEW`);
    for (const v of fixedReal.slice(0, limit)) lines.push(`- FIXED \`${v.type}\` ${v.text} — ${v.items.map((i) => i.text).join("; ")}`);
    if (addedReal.length + fixedReal.length) lines.push("");
  }

  const shown = opts.library ? r.violations : real;
  for (const source of ["erc", "drc", "unconnected", "parity"] as CheckSource[]) {
    const vs = shown.filter((v) => v.source === source);
    if (!vs.length) continue;
    const byType = new Map<string, number>();
    for (const v of vs) byType.set(v.type, (byType.get(v.type) ?? 0) + 1);
    lines.push(`## ${SOURCE_TITLE[source]}: ${vs.length}`, "");
    lines.push(`By type: ${[...byType].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ×${n}`).join(", ")}`, "");
    const rows = collapse(vs);
    for (const [v, n] of rows.slice(0, limit)) lines.push(fmtViolation(v, n));
    if (rows.length > limit) lines.push(`- … ${rows.length - limit} more (--limit N or --json for all)`);
    lines.push("");
  }
  if (!shown.length && !r.errors.length) lines.push("No violations. ✓", "");
  return lines.join("\n");
}
