import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Netlist, NetlistNet } from "../../shared/netlist";

export const CLI = process.env.KICAD_CLI ?? "kicad-cli";

/** Returns the kicad-cli version string, or null if it isn't installed. */
export async function detectKicadCli(): Promise<string | null> {
  try {
    const p = Bun.spawn([CLI, "version"], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(p.stdout).text()).trim();
    return (await p.exited) === 0 ? out : null;
  } catch {
    return null;
  }
}

const inflight = new Map<string, Promise<string>>();

/**
 * Export a board to GLB, cached by board file hash under <project>/.kretsa/cache/.
 * Concurrent requests for the same hash share one kicad-cli run.
 */
export function exportGlb(projectDir: string, pcbPath: string, pcbHash: string): Promise<string> {
  const out = join(projectDir, ".kretsa", "cache", `${pcbHash}.glb`);
  let job = inflight.get(out);
  if (!job) {
    job = runExport(projectDir, pcbPath, out).finally(() => inflight.delete(out));
    inflight.set(out, job);
  }
  return job;
}

// Matches stock-library model paths (KISYS3DMOD, KICAD6_3DMODEL_DIR, ... KICAD10_3DMODEL_DIR) ending in .wrl.
const STOCK_WRL = /(\(model\s+"\$\{(?:KISYS3DMOD|KICAD\d+_3DMODEL_DIR)\}[^"]*)\.wrl"/g;

/**
 * Recent KiCad builds (e.g. the 10.x AppImage) ship the stock 3D library as STEP only, and kicad-cli's
 * --subst-models does not fall back when the referenced .wrl is missing. So we export from a temp copy of
 * the board with stock .wrl references rewritten to .step. KIPRJMOD is overridden to keep project-local
 * model paths resolving against the real project dir. Project-local models are left untouched.
 */
async function runExport(projectDir: string, pcbPath: string, out: string): Promise<string> {
  if (await stat(out).then(() => true, () => false)) return out;
  await mkdir(dirname(out), { recursive: true });
  const tmpPcb = out.replace(/\.glb$/, ".tmp.kicad_pcb");
  await writeFile(tmpPcb, (await readFile(pcbPath, "utf8")).replace(STOCK_WRL, '$1.step"'));
  const args = [
    CLI, "pcb", "export", "glb",
    "--subst-models",
    "--include-tracks", "--include-pads", "--include-zones",
    "--include-silkscreen", "--include-soldermask",
    "--define-var", `KIPRJMOD=${projectDir}`,
    "--force",
    "-o", out,
    tmpPcb,
  ];
  try {
    const p = Bun.spawn(args, { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    const missing = (stdout + stderr).match(/File not found: .*/g);
    if (missing) console.warn(`[3d] ${missing.length} missing models, e.g. ${missing[0]}`);
    if (code !== 0 || !(await stat(out).then(() => true, () => false))) {
      throw new Error(`kicad-cli glb export failed (exit ${code}):\n${stderr || stdout}`);
    }
    return out;
  } finally {
    // kicad-cli also drops .kicad_prl (and sometimes .kicad_pro) next to the temp board
    const base = tmpPcb.replace(/\.kicad_pcb$/, "");
    await Promise.all(["kicad_pcb", "kicad_prl", "kicad_pro"].map((ext) => rm(`${base}.${ext}`, { force: true })));
  }
}

const netlists = new Map<string, Promise<Netlist>>();

/**
 * Schematic netlist via `kicad-cli sch export netlist --format kicadxml`, cached in memory by `rev`
 * (the netlist depends on every sheet, so the project rev is the key). Takes ~0.5 s.
 */
export function exportNetlist(projectDir: string, schPath: string, rev: string): Promise<Netlist> {
  const key = `${schPath}@${rev}`;
  let job = netlists.get(key);
  if (!job) {
    netlists.clear(); // only the latest rev is ever needed
    job = runNetlist(projectDir, schPath);
    job.catch(() => netlists.delete(key));
    netlists.set(key, job);
  }
  return job;
}

async function runNetlist(projectDir: string, schPath: string): Promise<Netlist> {
  const out = join(projectDir, ".kretsa", "cache", `netlist-${process.pid}-${Date.now()}.xml`);
  await mkdir(dirname(out), { recursive: true });
  try {
    const p = Bun.spawn([CLI, "sch", "export", "netlist", "--format", "kicadxml", "-o", out, schPath], {
      cwd: projectDir, stdout: "pipe", stderr: "pipe",
    });
    const stderr = await new Response(p.stderr).text();
    if ((await p.exited) !== 0) throw new Error(`kicad-cli netlist export failed:\n${stderr}`);
    return parseNetlistXml(await readFile(out, "utf8"));
  } finally {
    await rm(out, { force: true });
  }
}

const unxml = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp);/g, (_, e) => ({ lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" })[e as "lt"]!);

/** The kicadxml netlist is regular enough to read with regexes: <net name=".."> <node ref=".." pin=".."/> */
export function parseNetlistXml(xml: string): Netlist {
  const nets: NetlistNet[] = [];
  const section = xml.slice(xml.indexOf("<nets>"));
  for (const m of section.matchAll(/<net\s[^>]*?name="([^"]*)"[^>]*>([\s\S]*?)<\/net>/g)) {
    const nodes = [...m[2]!.matchAll(/<node\s[^>]*?ref="([^"]*)"[^>]*?pin="([^"]*)"/g)].map((n) => `${unxml(n[1]!)}.${unxml(n[2]!)}`);
    nets.push({ name: unxml(m[1]!), nodes });
  }
  return { nets };
}
