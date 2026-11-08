// 2D schematic / PCB view backed by the vendored KiCanvas web component.
// KiCanvas is built from vendor/kicanvas into web/public/vendor/kicanvas.js (`bun run build:kicanvas`).

import type { Anchor, ProjectInfo } from "../../shared/review";

let loaded: Promise<boolean> | null = null;

function loadKiCanvas(): Promise<boolean> {
  loaded ??= import(/* @vite-ignore */ `${location.origin}/vendor/kicanvas.js`).then(
    () => true,
    (e) => { console.error("KiCanvas failed to load", e); return false; },
  );
  return loaded;
}

/**
 * KiCanvas dispatches a bubbling, composed `kicanvas:select` event whose detail.item is the
 * parsed KiCad object (SchematicSymbol / Footprint / ...). We turn the bits we understand into anchors.
 */
export function onKiCanvasSelect(cb: (a: Anchor) => void) {
  document.addEventListener("kicanvas:select", (e) => {
    const item = (e as CustomEvent<{ item: any }>).detail?.item;
    if (!item) return;
    if (typeof item.reference === "string" && item.reference) {
      cb({ kind: "symbol", ref: item.reference, uuid: item.uuid, value: item.value });
    } else if (item.at?.position) {
      cb({ kind: "point", at_mm: [item.at.position.x, item.at.position.y] });
    }
  });
}

export async function mountKiCanvas(host: HTMLElement, project: ProjectInfo, view: "sch" | "pcb") {
  if (!(await loadKiCanvas())) {
    host.innerHTML = `<div class="notice">KiCanvas bundle not found.\n\nRun:  bun run build:kicanvas</div>`;
    return;
  }
  const files = project.files.filter((f) => f.kind === "pro" || f.kind === view);
  if (!files.some((f) => f.kind === view)) {
    host.innerHTML = `<div class="notice">No .kicad_${view} file in project.</div>`;
    return;
  }
  const embed = document.createElement("kicanvas-embed");
  embed.setAttribute("controls", "full");
  embed.setAttribute("controlslist", "nodownload");
  for (const f of files) {
    const src = document.createElement("kicanvas-source");
    // rev query param busts any caching inside KiCanvas on reload
    src.setAttribute("src", `/project/${f.path}?h=${f.hash}`);
    embed.appendChild(src);
  }
  host.replaceChildren(embed);
}
