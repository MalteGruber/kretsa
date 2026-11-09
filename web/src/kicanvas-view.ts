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
import { buildSheetGroups, groupAt, groupNodes, type NetIndex, type NetSel, type SchGroup } from "./nets";

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
  /** Called when the *user* picks a net (wire/label in the schematic; track, via, zone or pad on the PCB). */
  onNet: ((sel: NetSel) => void) | null = null;
  /** Schematic netlist provider (set by the app; null until /api/netlist has loaded). */
  nets: () => NetIndex | null = () => null;
  /** >0 while we select programmatically (cross-probing, sheet switches): events are not user input. */
  private quiet = 0;
  /** Highlighted net: netlist name (sch) or board net name (pcb). */
  private net: string | null = null;
  private groupsCache: { doc: unknown; nets: unknown; groups: SchGroup[] } | null = null;
  private overlay: SVGSVGElement | null = null;
  private overlayKey = "";

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
      // Replace KiCanvas' click handling: it only picks symbols (sch) and pops a chooser menu for
      // footprint-vs-net (pcb), and ignores wires, labels and zones.
      const orig = v.on_pick.bind(v);
      v.on_pick = (mouse: any, items: Iterable<{ bbox: any }>) => {
        try {
          if (this.kind === "sch" ? this.pickSchNet(mouse) : this.pickPcb(mouse, items)) return;
        } catch (e) { console.warn("pick failed", e); }
        this.clearNet();
        orig(mouse, items);
      };
    }
    return v;
  }

  // ---------------------------------------------------------------------------------------------
  // Nets
  // ---------------------------------------------------------------------------------------------

  /** Schematic: connectivity groups of the displayed sheet (cached per document + netlist). */
  private groups(): SchGroup[] {
    const v = this.viewer;
    if (this.kind !== "sch" || !v) return [];
    const nets = this.nets();
    let c = this.groupsCache;
    if (!c || c.doc !== v.document || c.nets !== nets) {
      const sheet = this.app?.project?.active_page?.sheet_path ?? "/";
      let groups: SchGroup[] = [];
      try { groups = buildSheetGroups(v.document, nets, typeof sheet === "string" ? sheet : "/"); } catch (e) { console.warn("connectivity failed", e); }
      c = this.groupsCache = { doc: v.document, nets, groups };
    }
    return c.groups;
  }

  /** px -> mm at the current zoom. */
  private pxToMm(px: number): number {
    const a = this.screenToWorld(0, 0), b = this.screenToWorld(px, 0);
    return a && b ? Math.abs(b[0] - a[0]) : px * 0.1;
  }

  private pickSchNet(mouse: { x: number; y: number }): boolean {
    const g = groupAt(this.groups(), [mouse.x, mouse.y], Math.max(0.3, this.pxToMm(5)));
    if (!g) return false;
    const groups = g.net ? this.groups().filter((x) => x.net === g.net) : [g];
    const name = g.net ?? "(unnamed net)";
    const nodes = g.net ? this.nets()?.byName.get(g.net) ?? groupNodes(groups) : groupNodes(groups);
    this.quietly(() => this.viewer?.select(null));
    this.showSchNet(g.net, g.net ? undefined : [g]);
    this.onNet?.({ name, nodes });
    return true;
  }

  private pickPcb(mouse: { x: number; y: number }, items: Iterable<{ bbox: any }>): boolean {
    const hits = [...items].map((i) => i.bbox?.context).filter(Boolean);
    const isFp = (i: any) => typeof i.reference === "string" && Array.isArray(i.pads);
    const isPad = (i: any) => Array.isArray(i.parent?.pads) && "number" in i;
    const netOf = (i: any): string => { try { return String(i.netname ?? i.net_name ?? ""); } catch { return ""; } };
    // Priority: track/via (thin: clicking one is deliberate) > footprint > zone fill under the cursor.
    // Clicking a pad of the already-selected footprint selects the pad's net.
    const track = hits.find((i) => !isPad(i) && !isFp(i) && typeof i.net_name !== "string" && netOf(i));
    const fp = hits.find(isFp);
    const pad = hits.find((i) => isPad(i) && netOf(i)) ?? (fp ? this.padAt(fp, mouse) : undefined);
    const fpSelected = fp && this.viewer?.selected?.context === fp;
    const zone = hits.find((i) => typeof i.net_name === "string" && i.net_name && this.zoneContains(i, mouse));
    const netItem = track ?? (fpSelected && pad ? pad : undefined) ?? (fp ? undefined : zone ?? pad);
    if (netItem) {
      const name = netOf(netItem);
      this.quietly(() => this.viewer?.select(null));
      this.showPcbNet(name);
      this.onNet?.({ name, nodes: this.pcbNetNodes(name) });
      return true;
    }
    if (fp) { this.clearNet(); this.viewer.select(fp); return true; }
    return false;
  }

  /** World position of a pad (KiCad: pad `at` is in footprint coords, rotation CCW with y down). */
  private padWorld(fp: any, pad: any): [number, number] {
    const t = ((fp.at?.rotation ?? 0) * Math.PI) / 180;
    const x = pad.at.position.x, y = pad.at.position.y;
    return [fp.at.position.x + x * Math.cos(t) + y * Math.sin(t), fp.at.position.y - x * Math.sin(t) + y * Math.cos(t)];
  }

  /** The pad of `fp` under `m` (with a netname), if any. */
  private padAt(fp: any, m: { x: number; y: number }): any {
    for (const pad of fp.pads ?? []) {
      let n = "";
      try { n = pad.netname ?? ""; } catch {}
      if (!n || !pad.at || !pad.size) continue;
      const [cx, cy] = this.padWorld(fp, pad);
      const t = ((pad.at.rotation ?? 0) * Math.PI) / 180; // absolute pad rotation
      const dx = m.x - cx, dy = m.y - cy;
      const lx = dx * Math.cos(t) - dy * Math.sin(t), ly = dx * Math.sin(t) + dy * Math.cos(t);
      if (Math.abs(lx) <= pad.size.x / 2 && Math.abs(ly) <= pad.size.y / 2) return pad;
    }
    return undefined;
  }

  private zoneContains(z: any, m: { x: number; y: number }): boolean {
    const fills: any[] = z.filled_polygons ?? [];
    if (!fills.length) return false;
    const layers = this.viewer?.layers;
    return fills.some((f) => {
      if (layers?.by_name?.(f.layer)?.visible === false) return false;
      const pts: { x: number; y: number }[] = f.polyline ?? [];
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const a = pts[i]!, b = pts[j]!;
        if (a.y > m.y !== b.y > m.y && m.x < ((b.x - a.x) * (m.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    });
  }

  /** PCB: pads on a net, as "REF.PAD". */
  pcbNetNodes(name: string): string[] {
    const out = new Set<string>();
    for (const fp of this.viewer?.board?.footprints ?? []) {
      for (const pad of fp.pads ?? []) {
        let n = "";
        try { n = pad.netname ?? ""; } catch {}
        if (n === name && pad.number) out.add(`${fp.reference}.${pad.number}`);
      }
    }
    return [...out];
  }

  private quietly(fn: () => void) {
    this.quiet++;
    try { fn(); } finally { this.quiet--; }
  }

  private showPcbNet(name: string | null) {
    const v = this.viewer;
    if (!v) return;
    this.net = name;
    const num = name ? v.board?.nets?.find((n: any) => n.name === name)?.number : undefined;
    // Selection and net highlight share KiCanvas' overlay layer, and select() repaints it on a
    // setTimeout(0), so paint the net after that.
    setTimeout(() => {
      if (this.net !== name || this.viewer !== v) return;
      if (num) v.highlight_net(num);
      else { v.layers.overlay.clear(); v.draw(); }
    }, 0);
  }

  private showSchNet(name: string | null, groups?: SchGroup[]) {
    this.net = name;
    this.schNetGroups = groups ?? null;
    this.overlayKey = "";
    this.ensureOverlay();
  }
  private schNetGroups: SchGroup[] | null = null;

  /** The highlighted net's groups on the displayed sheet. */
  private litGroups(): SchGroup[] {
    if (this.schNetGroups) return this.schNetGroups;
    return this.net ? this.groups().filter((g) => g.net === this.net) : [];
  }

  clearNet() {
    if (this.net == null && !this.schNetGroups) return;
    if (this.kind === "pcb") {
      this.net = null;
      const v = this.viewer;
      if (v && !v.selected) { v.layers.overlay.clear(); v.draw(); }
    } else this.showSchNet(null);
  }

  /**
   * Cross-probe entry point for nets. Schematic: switches to a sheet showing the net if needed.
   * Returns false if the net isn't found in this document.
   */
  async selectNet(sel: NetSel | null, zoom = false): Promise<boolean> {
    if (!sel) { this.clearNet(); return true; }
    this.quiet++;
    try {
      this.viewer?.select(null);
      return this.kind === "pcb" ? this.selectPcbNet(sel, zoom) : await this.selectSchNet(sel, zoom);
    } finally { this.quiet--; }
  }

  private selectPcbNet(sel: NetSel, zoom: boolean): boolean {
    const v = this.viewer;
    if (!v) return false;
    // Majority vote over pins, else by name (also tolerating a leading "/" difference).
    const votes = new Map<string, number>();
    const pads = new Map<string, string>();
    for (const fp of v.board?.footprints ?? []) for (const pad of fp.pads ?? []) {
      try { if (pad.netname) pads.set(`${fp.reference}.${pad.number}`, pad.netname); } catch {}
    }
    for (const n of sel.nodes) { const net = pads.get(n); if (net) votes.set(net, (votes.get(net) ?? 0) + 1); }
    const names: string[] = (v.board?.nets ?? []).map((n: any) => n.name);
    const strip = (s: string) => s.replace(/^\//, "");
    const name = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ??
      names.find((n) => n === sel.name) ?? names.find((n) => n && strip(n) === strip(sel.name));
    if (!name) { this.clearNet(); return false; }
    this.showPcbNet(name);
    if (zoom) this.zoomToBoxes(this.pcbNetBoxes(name));
    return true;
  }

  private pcbNetBoxes(name: string): any[] {
    const out: any[] = [];
    for (const layer of this.viewer?.layers?.in_order?.() ?? []) {
      if (!layer.visible) continue;
      for (const [item, bb] of layer.bboxes ?? []) {
        let n: string | undefined;
        try { n = item?.netname ?? item?.net_name; } catch {}
        if (n === name && bb?.w < 1000) out.push(bb);
      }
    }
    // Pads aren't indexed separately (they're part of the footprint's bbox): add them by geometry.
    const v = this.viewer;
    const BBox = v?.viewport?.camera?.bbox?.constructor;
    if (BBox) for (const fp of v.board?.footprints ?? []) for (const pad of fp.pads ?? []) {
      let n = "";
      try { n = pad.netname ?? ""; } catch {}
      if (n !== name || !pad.at || !pad.size) continue;
      const [x, y] = this.padWorld(fp, pad);
      const r = Math.max(pad.size.x, pad.size.y) / 2;
      out.push(new BBox(x - r, y - r, 2 * r, 2 * r));
    }
    return out;
  }

  private async selectSchNet(sel: NetSel, zoom: boolean): Promise<boolean> {
    const nets = this.nets();
    const name = nets?.resolve(sel) ?? sel.name;
    const onSheet = () => this.groups().some((g) => g.net === name);
    if (!onSheet()) {
      // Find a sheet with a pin or label of this net.
      const project = this.app?.project;
      const refs = new Set((nets?.byName.get(name) ?? sel.nodes).map((n) => n.slice(0, n.lastIndexOf("."))));
      const pages = project ? [...project.pages()].filter((pg: any) => pg.type === "schematic") : [];
      const page = pages.find((pg: any) => [...refs].some((r) => pg.document?.find_symbol?.(r))) ?? null;
      if (page && page !== project.active_page) {
        project.set_active_page(page);
        const t0 = performance.now();
        while (performance.now() - t0 < 3000 && !onSheet()) await new Promise((r) => setTimeout(r, 50));
      }
    }
    this.showSchNet(name);
    const lit = this.litGroups();
    if (!lit.length) return false;
    if (zoom) {
      const v = this.viewer;
      const pts = lit.flatMap((g) => [...g.wires.flat(), ...g.pins.map((p) => p.at), ...g.labels]);
      if (v && pts.length) {
        const BBox = v.viewport.camera.bbox.constructor;
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        const x0 = Math.min(...xs), y0 = Math.min(...ys);
        this.zoomToBoxes([new BBox(x0, y0, Math.max(...xs) - x0, Math.max(...ys) - y0)]);
      }
    }
    return true;
  }

  private zoomToBoxes(boxes: any[]) {
    const v = this.viewer;
    if (!v || !boxes.length) return;
    const BBox = boxes[0].constructor;
    const bb = BBox.combine(boxes);
    const pad = Math.max(bb.w, bb.h, 5) * 0.2 + 2;
    v.viewport.camera.bbox = bb.grow(pad);
    v.draw();
  }

  /** Schematic net highlight: an SVG layer over the canvas, re-projected every frame while active. */
  private ensureOverlay() {
    if (this.kind !== "sch") return;
    if (!this.overlay) {
      this.overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      this.overlay.classList.add("netlayer");
      this.host.appendChild(this.overlay);
    }
    if (this.looping) return;
    this.looping = true;
    let first: unknown = null;
    const tick = () => {
      const lit = this.litGroups();
      if (!lit.length) { this.overlay!.innerHTML = ""; this.overlayKey = ""; this.looping = false; return; }
      if (!this.overlay!.isConnected) this.host.appendChild(this.overlay!);
      const cam = this.viewer?.viewport?.camera;
      const k = cam ? `${cam.center.x},${cam.center.y},${cam.zoom},${this.host.clientWidth},${this.host.clientHeight},${lit.length}` : "";
      if (k && (k !== this.overlayKey || lit[0] !== first)) {
        this.overlayKey = k;
        first = lit[0];
        const s = (p: [number, number]) => this.worldToScreen(p[0], p[1]) ?? [0, 0];
        const w = Math.max(3, Math.min(10, 0.6 / this.pxToMm(1)));
        const lines = lit.flatMap((g) => g.wires.map(([a, b]) => { const [x1, y1] = s(a), [x2, y2] = s(b); return `M${x1} ${y1}L${x2} ${y2}`; })).join("");
        const dots = lit.flatMap((g) => [...g.pins.map((p) => p.at), ...g.labels]).map((p) => { const [x, y] = s(p); return `<circle cx="${x}" cy="${y}" r="${w * 0.9}"/>`; }).join("");
        this.overlay!.innerHTML = `<path d="${lines}" stroke-width="${w}"/>${dots}`;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  private looping = false;

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
    this.clearNet();
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
