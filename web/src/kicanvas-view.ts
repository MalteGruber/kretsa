// 2D schematic / PCB view backed by the vendored KiCanvas web component.
// KiCanvas is built from vendor/kicanvas into web/public/vendor/kicanvas.js (`bun run build:kicanvas`).
//
// We run <kicanvas-embed controls="basic"> and drive KiCanvas' internal viewer object directly
// (reached through the embed's shadow DOM) so the surrounding chrome is entirely ours.
// Internal API used (see vendor/kicanvas/src/viewers/...):
//   viewer.select(ref|uuid|null), zoom_to_page(), zoom_to_selection(), draw()
//   viewer.viewport.camera.world_to_screen / screen_to_world (Vec2, document mm <-> canvas px)
//   viewer.schematic.symbols (Map) / viewer.board.footprints (Array)
//   viewer.layers.in_ui_order(), layer.visible, layer.color, layers.highlight()
//   app.project.pages(), project.set_active_page(page)

import type { Anchor, ProjectInfo } from "../../shared/review";

let loaded: Promise<boolean> | null = null;

export function loadKiCanvas(): Promise<boolean> {
  // KiCanvas reads its preferences from localStorage at module load (the embed's `theme` attribute is
  // not propagated to the viewers). "kicad" = KiCad's classic colors: cream schematic paper, navy board.
  // alignControlsWithKiCad = mouse wheel zooms (like KiCad / most EDA viewers) instead of panning.
  localStorage.setItem("kc:prefs:theme", JSON.stringify({ val: "kicad" }));
  localStorage.setItem("kc:prefs:alignControlsWithKiCad", JSON.stringify({ val: true }));
  loaded ??= import(/* @vite-ignore */ `${location.origin}/vendor/kicanvas.js`).then(
    () => true,
    (e) => { console.error("KiCanvas failed to load", e); return false; },
  );
  return loaded;
}

export interface Component {
  isNet?: boolean;
  ref: string;
  value: string;
  footprint: string;
  uuid?: string;
  lib?: string;
  layer?: string;
  props: [string, string][];
}

export interface Page { path: string; name: string; active: boolean }
export interface Layer { name: string; color: string; visible: boolean; highlighted: boolean }

const colorCss = (c: any): string =>
  c && typeof c.r === "number" ? `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})` : "#888";

/** Turn a KiCanvas selection item into an anchor, if we understand it. */
export function itemToAnchor(item: any): Anchor | null {
  if (!item) return null;
  if (typeof item.reference === "string" && item.reference) {
    return { kind: "symbol", ref: item.reference, uuid: item.uuid, value: item.value };
  }
  if (typeof item.netname === "string" && item.netname) return { kind: "net", name: item.netname };
  if (item.at?.position) return { kind: "point", at_mm: [item.at.position.x, item.at.position.y] };
  return null;
}

export function itemToComponent(item: any): Component | null {
  if (item && typeof item.netname === "string" && item.netname) {
    return { isNet: true, ref: item.netname, value: "Net", footprint: "", props: [] };
  }
  if (!item || typeof item.reference !== "string") return null;
  const props: [string, string][] = [];
  if (item.properties instanceof Map) {
    for (const [k, p] of item.properties) props.push([k, String(p?.text ?? p?.value ?? "")]);
  } else if (item.properties && typeof item.properties === "object") {
    for (const [k, p] of Object.entries<any>(item.properties)) props.push([k, String(p?.value ?? p?.text ?? p ?? "")]);
  }
  return {
    ref: item.reference,
    value: item.value ?? "",
    footprint: item.footprint ?? item.library_link ?? "",
    uuid: item.uuid,
    lib: item.lib_id,
    layer: item.layer,
    props: props.filter(([k, v]) => v !== "" && !k.startsWith("ki_")),
  };
}

export class KiCanvasView {
  readonly embed: HTMLElement;
  private listenedViewer: any = null;
  /** Called with the raw KiCanvas item (or null) when the *user* selects something. */
  onSelect: ((item: any) => void) | null = null;
  /** >0 while we select programmatically (cross-probing, sheet switches): events are not user input. */
  private quiet = 0;

  constructor(
    readonly host: HTMLElement,
    readonly kind: "sch" | "pcb",
  ) {
    this.embed = document.createElement("kicanvas-embed");
  }

  async mount(project: ProjectInfo): Promise<boolean> {
    if (!(await loadKiCanvas())) {
      this.host.innerHTML = `<div class="notice">KiCanvas bundle not found.\n\nRun:  bun run build:kicanvas</div>`;
      return false;
    }
    const files = project.files.filter((f) => f.kind === "pro" || f.kind === this.kind);
    if (!files.some((f) => f.kind === this.kind)) {
      this.host.innerHTML = `<div class="notice">No .kicad_${this.kind} file in project.</div>`;
      return false;
    }
    // "basic" keeps pan/zoom/select; "none" would disable interaction entirely.
    // KiCanvas' own buttons are switched off; its bottom toolbar is hidden after mount.
    this.embed.setAttribute("controls", "basic");
    this.embed.setAttribute("controlslist", "nodownload nofullscreen noflipview");
    for (const f of files) {
      const src = document.createElement("kicanvas-source");
      src.setAttribute("src", `/project/${f.path}?h=${f.hash}`);
      this.embed.appendChild(src);
    }
    this.host.replaceChildren(this.embed);
    const ok = (await this.waitViewer()) != null;
    // Hide (don't remove: that breaks KiCanvas' disposal bookkeeping) its built-in bottom toolbar.
    this.app?.shadowRoot?.querySelectorAll("kc-viewer-bottom-toolbar").forEach((el: HTMLElement) => (el.style.display = "none"));
    if (ok && this.kind === "pcb") setTimeout(() => this.zoomFit(), 50);
    return ok;
  }

  private get app(): any {
    return this.embed.shadowRoot?.querySelector(this.kind === "sch" ? "kc-schematic-app" : "kc-board-app");
  }

  get viewer(): any {
    // Always read fresh: KiCanvas may replace the viewer object after its first render.
    let v: any = null;
    try { v = this.app?.viewer ?? null; } catch { v = null; }
    if (!v?.document) return null;
    // The viewer is a plain EventTarget (not a DOM node), so its events never reach `document`.
    if (v && v !== this.listenedViewer) {
      this.listenedViewer = v;
      v.addEventListener("kicanvas:select", (e: CustomEvent) => { if (!this.quiet) this.onSelect?.(e.detail?.item ?? null); });
      if (this.kind === "pcb") {
        // A click usually hits a footprint *and* a net; KiCanvas would pop a chooser menu.
        // Prefer the footprint (component selection), fall back to the net.
        v.contextMenuCallback = (_x: number, _y: number, items: Map<string, unknown>, choose: (i: unknown) => void) => {
          const entries = [...items];
          choose((entries.find(([k]) => k.startsWith("Footprint")) ?? entries[0])![1]);
        };
        // Net clicks only highlight the net (no select event), so surface them ourselves.
        const orig = v.handleItemClick.bind(v);
        v.handleItemClick = (item: any) => {
          orig(item);
          if (item && typeof item.netname === "string") this.onSelect?.(item);
        };
      }
    }
    return v;
  }

  async waitViewer(timeoutMs = 20000): Promise<any> {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      const v = this.viewer;
      if (v) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  }

  components(): Component[] {
    const v = this.viewer;
    if (!v) return [];
    const items: any[] = this.kind === "sch" ? [...(v.schematic?.symbols?.values() ?? [])] : [...(v.board?.footprints ?? [])];
    return items
      .map(itemToComponent)
      .filter((c): c is Component => !!c && !!c.ref && !c.ref.startsWith("#"))
      .sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }));
  }

  /**
   * Cross-probe entry point: select a part by refdes, switching schematic sheet if needed.
   * Returns false if the part doesn't exist in this document (e.g. schematic-only symbols on the PCB).
   */
  async selectRef(ref: string | null, zoom = false): Promise<boolean> {
    this.quiet++;
    try { return await this.selectRefInner(ref, zoom); } finally { this.quiet--; }
  }

  private async selectRefInner(ref: string | null, zoom: boolean): Promise<boolean> {
    let v = this.viewer;
    if (!v) return false;
    if (!ref) { this.select(null); return true; }
    const find = (vv: any) => this.kind === "sch" ? vv?.schematic?.find_symbol?.(ref) : vv?.board?.find_footprint?.(ref);
    if (!find(v) && this.kind === "sch") {
      const project = this.app?.project;
      const page = project && [...project.pages()].find((pg: any) => pg.type === "schematic" && pg.document?.find_symbol?.(ref));
      if (!page) { this.select(null); return false; }
      project.set_active_page(page);
      const t0 = performance.now();
      while (performance.now() - t0 < 3000 && !find(this.viewer)) await new Promise((r) => setTimeout(r, 50));
      v = this.viewer;
    }
    if (!find(v)) { this.select(null); return false; }
    this.select(ref);
    if (zoom) v.zoom_to_selection();
    return true;
  }

  select(refOrUuid: string | null) {
    try { this.viewer?.select(refOrUuid); } catch (e) { console.warn(e); }
  }
  /** Schematic: fit the page. PCB: fit the board outline (Edge.Cuts), not the drawing sheet. */
  zoomFit() {
    const v = this.viewer;
    if (!v) return;
    if (this.kind === "pcb") {
      const edges = (v.board?.drawings ?? []).filter((d: any) => d.layer === "Edge.Cuts" && d.bbox);
      const items = edges.length ? edges : (v.board?.footprints ?? []);
      if (items.length) {
        const BBox = items[0].bbox.constructor;
        const bb = BBox.combine(items.map((i: any) => i.bbox));
        v.viewport.camera.bbox = bb.grow(Math.max(bb.w, bb.h) * 0.15);
        v.draw();
        return;
      }
    }
    v.zoom_to_page();
  }
  zoomSelection() { this.viewer?.zoom_to_selection(); }

  pages(): Page[] {
    const p = this.app?.project;
    if (!p) return [];
    const active = p.active_page?.project_path;
    return [...p.pages()]
      .filter((pg: any) => pg.type === (this.kind === "sch" ? "schematic" : "pcb"))
      .map((pg: any) => ({ path: pg.project_path, name: pg.name || pg.filename, active: pg.project_path === active }));
  }
  setPage(path: string) { this.app?.project?.set_active_page(path); }

  layers(): Layer[] {
    const v = this.viewer;
    if (this.kind !== "pcb" || !v?.layers?.in_ui_order) return [];
    return [...v.layers.in_ui_order()].map((l: any) => ({
      name: l.name, color: colorCss(l.color), visible: !!l.visible, highlighted: !!l.highlighted,
    }));
  }
  toggleLayer(name: string) {
    const l = this.viewer?.layers?.by_name(name);
    if (!l) return;
    l.visible = !l.visible;
    this.viewer.draw();
  }
  highlightLayer(name: string | null) {
    const v = this.viewer;
    if (!v) return;
    const l = name ? v.layers.by_name(name) : null;
    if (l?.highlighted) v.layers.highlight(null);
    else { v.layers.highlight(l); if (l) l.visible = true; }
    v.draw();
  }

  /** Document mm -> CSS px relative to the canvas host, or null if not ready. */
  worldToScreen(x: number, y: number): [number, number] | null {
    const v = this.viewer;
    const cam = v?.viewport?.camera;
    if (!cam) return null;
    const Vec2 = v.mouse_position.constructor;
    const s = cam.world_to_screen(new Vec2(x, y));
    return [s.x, s.y];
  }
  screenToWorld(x: number, y: number): [number, number] | null {
    const v = this.viewer;
    const cam = v?.viewport?.camera;
    if (!cam) return null;
    const Vec2 = v.mouse_position.constructor;
    const w = cam.screen_to_world(new Vec2(x, y));
    return [w.x, w.y];
  }
  centerOn(x: number, y: number) {
    const v = this.viewer;
    const cam = v?.viewport?.camera;
    if (!cam) return;
    cam.center.set(x, y);
    v.draw();
  }
  /** Position of a symbol/footprint by ref, in document mm. */
  positionOf(ref: string): [number, number] | null {
    const v = this.viewer;
    if (!v) return null;
    const item = this.kind === "sch" ? v.schematic?.find_symbol?.(ref) : v.board?.find_footprint?.(ref);
    const p = item?.at?.position;
    return p ? [p.x, p.y] : null;
  }
}
