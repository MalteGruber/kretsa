import { mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const CLI = process.env.KICAD_CLI ?? "kicad-cli";

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
 * Export a board to GLB, cached by board file hash under <project>/.wiber/cache/.
 * Concurrent requests for the same hash share one kicad-cli run.
 */
export function exportGlb(projectDir: string, pcbPath: string, pcbHash: string): Promise<string> {
  const out = join(projectDir, ".wiber", "cache", `${pcbHash}.glb`);
  let job = inflight.get(out);
  if (!job) {
    job = runExport(projectDir, pcbPath, out).finally(() => inflight.delete(out));
    inflight.set(out, job);
  }
  return job;
}

async function runExport(projectDir: string, pcbPath: string, out: string): Promise<string> {
  if (await stat(out).then(() => true, () => false)) return out;
  await mkdir(dirname(out), { recursive: true });
  const args = [
    CLI, "pcb", "export", "glb",
    "--subst-models",
    "--include-tracks", "--include-pads", "--include-zones",
    "--include-silkscreen", "--include-soldermask",
    "--define-var", `KIPRJMOD=${projectDir}`,
    "--force",
    "-o", out,
    pcbPath,
  ];
  const p = Bun.spawn(args, { cwd: projectDir, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0 || !(await stat(out).then(() => true, () => false))) {
    throw new Error(`kicad-cli glb export failed (exit ${code}):\n${stderr || stdout}`);
  }
  return out;
}
