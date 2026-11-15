// `kretsa guide`: the agent's entry point. The text lives in docs/agent-guide.md (one source for the repo docs and the CLI).

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
export const AGENT_GUIDE_PATH = join(ROOT, "docs", "agent-guide.md");

export function agentGuide(): string {
  try { return readFileSync(AGENT_GUIDE_PATH, "utf8"); }
  catch { return `# kretsa\n\n(${AGENT_GUIDE_PATH} is missing; run \`kretsa help\` for the commands.)\n`; }
}
