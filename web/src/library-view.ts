// Library browser: parts (symbol + footprint + 3D model) of the project's libraries, with their checks.
// Same data the agent gets from `kretsa lib` / `kretsa lib show`.

import type { LibraryInfo, PartDetail, PartSummary } from "../../shared/library";
import type { Anchor, Aspect, Comment } from "../../shared/review";
import type { ThreeView } from "./three-view";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const f2 = (n: number) => +n.toFixed(3);

async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json().catch(() => ({ error: r.statusText }))).error);
  return r.json() as Promise<T>;
}

/** How the library view talks to the comment panel (main.ts). */
export interface LibraryHooks {
  /** A pin or pad row was clicked: attach it to the comment being written. */
  onAnchor(a: Anchor): void;
  /** "Comment" on a tile, or "Request a new part": open the composer. */
  onCompose(): void;
  /** The comments to list under the part. */
  comments(): Comment[];
  onOpenComment(id: string): void;
  /** The part or aspect being commented on changed. */
  onSelection(): void;
}

/** What a comment written now is about. part undefined = a request for a new part. */
export interface LibrarySelection { part?: string; aspect?: Aspect; request: boolean }

export interface LibraryView {
  refresh(): Promise<void>;
  dispose(): void;
  select(id: string): Promise<void>;
  selection(): LibrarySelection;
  /** PNG data URL of the 3D tile (for comments on the 3D model). */
  snapshot3d(): string | undefined;
  /** Comments changed: redraw the per-part list. */
  reviewChanged(): void;
}

export function mountLibrary(host: HTMLElement, hooks: LibraryHooks): LibraryView {
  host.innerHTML = `
    <div class="libview">
      <aside class="liblist">
        <input class="search" placeholder="Search parts…" />
        <div class="cfilter"><button data-lf="all" class="active">All</button><button data-lf="issues">Issues</button><span class="libcount muted"></span></div>
        <button class="secondary libnew" title="Ask the agent to make a part: symbol, footprint and 3D model">+ Request a new part</button>
        <ul class="list"></ul>
      </aside>
      <section class="libdetail"><div class="empty">Loading libraries…</div></section>
    </div>`;
  const list = host.querySelector<HTMLUListElement>(".liblist ul")!;
  const search = host.querySelector<HTMLInputElement>(".liblist .search")!;
  const detail = host.querySelector<HTMLElement>(".libdetail")!;
  let info: LibraryInfo | null = null;
  let filter: "all" | "issues" = "all";
  let selected = sessionStorage.getItem("kretsa:lib:part");
  let three: ThreeView | null = null;
  let seq = 0;
  let aspect: Aspect | undefined;
  let request = false;

  const setAspect = (a: Aspect | undefined) => {
    aspect = a;
    detail.querySelectorAll<HTMLElement>(".tile[data-aspect]").forEach((t) => t.classList.toggle("active", t.dataset.aspect === a));
    hooks.onSelection();
  };

  const renderPartComments = () => {
    const box = detail.querySelector<HTMLElement>(".partcomments");
    if (!box || !selected) return;
    const mine = hooks.comments().filter((c) => c.view === "lib" && c.part === selected);
    box.innerHTML = mine.length
      ? `<h3>Comments on this part (${mine.length})</h3>` + mine.map((c) => `
        <div class="pcomment" data-cid="${esc(c.id)}"><span class="status-pill ${c.status}${c.status === "open" && !c.sent ? " draft" : ""}">${c.status === "open" && !c.sent ? "draft" : c.status}</span>
        ${c.aspect ? `<span class="muted">${c.aspect}</span>` : ""} ${esc(c.text)}${c.thread.length ? ` <span class="muted">· ${c.thread.length} repl${c.thread.length === 1 ? "y" : "ies"}</span>` : ""}</div>`).join("")
      : "";
    box.querySelectorAll<HTMLElement>("[data-cid]").forEach((el) => (el.onclick = () => hooks.onOpenComment(el.dataset.cid!)));
  };

  function showRequest() {
    request = true;
    selected = null;
    sessionStorage.removeItem("kretsa:lib:part");
    three?.dispose();
    three = null;
    renderList();
    hooks.onSelection();
    detail.innerHTML = `<div class="libempty">
      <h3>Request a new part</h3>
      <p>Describe the part in the comment box: manufacturer part number, package, a datasheet link, and anything
      special about the pinout or footprint. Then <b>Send to AI</b>. The agent makes the symbol, footprint and 3D model in the
      project libraries, and the part shows up here for you to review.</p>
      <p class="muted">The agent sees this as a <i>new part request</i> in <code>kretsa wait</code> / <code>kretsa review</code>.</p></div>`;
    hooks.onCompose();
  }

  const renderList = () => {
    if (!info) return;
    const q = search.value.toLowerCase();
    const parts = info.parts.filter((p) => (!q || `${p.id} ${p.value} ${p.description}`.toLowerCase().includes(q)) && (filter === "all" || p.errors || p.warnings));
    host.querySelector(".libcount")!.textContent = `${parts.length} / ${info.parts.length}`;
    list.innerHTML = parts.map((p) => `
      <li data-id="${esc(p.id)}" class="${p.id === selected ? "active" : ""}">
        <span class="ref">${esc(p.name)}</span>
        <span class="val">${esc(p.lib)}${p.power ? " · power" : ""}</span>
        <span class="badges">${p.errors ? `<b class="e">${p.errors}</b>` : ""}${p.warnings ? `<b class="w">${p.warnings}</b>` : ""}</span>
      </li>`).join("") || `<li class="group">No parts</li>`;
    list.querySelectorAll<HTMLLIElement>("li[data-id]").forEach((li) => (li.onclick = () => select(li.dataset.id!)));
  };

  const noLibs = () => {
    detail.innerHTML = `<div class="libempty">
      <h3>No libraries</h3>
      <p>This project (and the workspace root) has no <code>sym-lib-table</code> / <code>fp-lib-table</code>.
      kretsa only shows libraries registered there, never KiCad's stock libraries, because in this workflow the agent makes every part.</p>
      <p>Ask the agent to create project libraries, e.g. <code>lib/Project.kicad_sym</code> and <code>lib/Project.pretty/</code>,
      registered with <code>\${KIPRJMOD}</code>-relative URIs.</p></div>`;
  };

  async function select(id: string) {
    request = false;
    setAspect(undefined);
    selected = id;
    sessionStorage.setItem("kretsa:lib:part", id);
    hooks.onSelection();
    renderList();
    const my = ++seq;
    three?.dispose();
    three = null;
    detail.innerHTML = `<div class="empty">Loading ${esc(id)}…</div>`;
    let p: PartDetail;
    try { p = await get<PartDetail>(`/api/lib/part?id=${encodeURIComponent(id)}`); }
    catch (e) { detail.innerHTML = `<div class="empty">${esc(String((e as Error).message))}</div>`; return; }
    if (my !== seq) return;
    const asset = (f: string) => `/api/lib/asset?id=${encodeURIComponent(p.id)}&f=${f}&t=${Date.now()}`;
    const fp = p.footprintDetail;
    const pads = new Map((fp?.pads ?? []).map((x) => [x.number, x]));
    const units = Array.from({ length: Math.max(1, p.units) }, (_, i) => i + 1);
    detail.innerHTML = `
      <header class="parthead">
        <h2>${esc(p.name)} <span class="muted">${esc(p.lib)}</span></h2>
        <div class="sub">${esc(p.reference)} · ${esc(p.value)}${p.description ? ` · ${esc(p.description)}` : ""}</div>
        <div class="sub">Footprint: ${p.footprint ? `<code>${esc(p.footprint)}</code>` : "none"}${fp?.models.length ? ` · 3D: <code>${esc(fp.models[0]!.path)}</code>` : ""}</div>
      </header>
      ${p.issues.length ? `<ul class="partissues">${p.issues.map((i) => `<li class="${i.level}"><b>${i.level}</b> <code>${esc(i.code)}</code> ${esc(i.text)}</li>`).join("")}</ul>`
        : `<div class="partok">✓ No issues</div>`}
      <div class="tiles">
        <figure class="tile paper" data-aspect="symbol"><figcaption>Symbol${p.units > 1 ? ` (${p.units} units)` : ""}<button class="tilec" title="Comment on the symbol">Comment</button></figcaption>
          <div class="symunits">${units.map((u) => `<img alt="unit ${u}" src="${asset(`symbol_unit${u}.svg`)}" />`).join("")}</div></figure>
        ${fp ? `<figure class="tile paper" data-aspect="footprint"><figcaption>Footprint<button class="tilec" title="Comment on the footprint">Comment</button></figcaption><img alt="footprint" src="${asset("footprint.svg")}" /></figure>
        <figure class="tile dark3d" data-aspect="3d"><figcaption>3D<button class="tilec" title="Comment on the 3D model (the current view is attached)">Comment</button></figcaption><div class="three"></div></figure>` : ""}
      </div>
      <div class="partcomments"></div>
      <p class="muted small">Click pin or pad rows to point at them in your comment.</p>
      <h3>Pins (${p.pins})</h3>
      <table class="ptable"><tr><th>pin</th><th>name</th><th>type</th><th>unit</th>${fp ? "<th>pad</th>" : ""}<th>alternates</th></tr>
        ${[...p.pinList].sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true })).map((pin) => `
          <tr class="pick" data-pin="${esc(pin.number)}" data-name="${esc(pin.name)}"><td>${esc(pin.number)}</td><td>${esc(pin.name)}${pin.hidden ? " <span class='muted'>(hidden)</span>" : ""}</td><td>${esc(pin.type)}</td><td>${pin.unit || "all"}</td>
          ${fp ? `<td>${pads.has(pin.number) ? esc(pads.get(pin.number)!.type) : `<b class="missing">missing</b>`}</td>` : ""}
          <td class="muted">${esc(pin.alternates.map((a) => a.name).join(", "))}</td></tr>`).join("")}
      </table>
      ${fp ? `<h3>Pads (${fp.pads.length}) <span class="muted">mm, y down</span></h3>
      <table class="ptable"><tr><th>pad</th><th>type</th><th>shape</th><th>x</th><th>y</th><th>w × h</th><th>drill</th><th>layers</th></tr>
        ${fp.pads.map((d) => `<tr class="pick" data-pad="${esc(d.number)}"><td>${esc(d.number || "—")}</td><td>${esc(d.type)}</td><td>${esc(d.shape)}</td><td>${f2(d.at[0])}</td><td>${f2(d.at[1])}</td>
          <td>${f2(d.size[0])} × ${f2(d.size[1])}</td><td>${d.drill?.map(f2).join(" × ") ?? ""}</td><td class="muted">${esc(d.layers.join(" "))}</td></tr>`).join("")}
      </table>` : ""}
      <h3>Fields</h3>
      <table class="ptable">${Object.entries(p.fields).filter(([k, v]) => v && !k.startsWith("ki_")).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>
      <p class="muted small">Agent: <code>kretsa lib show ${esc(p.id)}</code></p>`;
    detail.querySelectorAll<HTMLElement>(".tile[data-aspect]").forEach((t) => (t.onclick = (e) => {
      setAspect(t.dataset.aspect as Aspect);
      if ((e.target as HTMLElement).closest(".tilec")) hooks.onCompose();
    }));
    detail.querySelectorAll<HTMLTableRowElement>("tr.pick").forEach((tr) => (tr.onclick = () => {
      if (tr.dataset.pin !== undefined) { setAspect("symbol"); hooks.onAnchor({ kind: "pin", pin: tr.dataset.pin, ...(tr.dataset.name && tr.dataset.name !== "~" && { name: tr.dataset.name }) }); }
      else if (tr.dataset.pad) { setAspect("footprint"); hooks.onAnchor({ kind: "pad", ref: fp!.id, pad: tr.dataset.pad }); }
      tr.classList.add("picked");
    }));
    renderPartComments();
    const threeHost = detail.querySelector<HTMLElement>(".three");
    if (threeHost) {
      const { mountThree } = await import("./three-view");
      const tv = await mountThree(threeHost, asset("part.glb"), () => {});
      if (my !== seq) tv?.dispose();
      else three = tv;
    }
  }

  async function refresh() {
    try { info = await get<LibraryInfo>("/api/lib"); }
    catch (e) { detail.innerHTML = `<div class="empty">${esc(String((e as Error).message))}</div>`; return; }
    renderList();
    if (!info.libraries.length) return noLibs();
    const keep = selected && info.parts.some((p: PartSummary) => p.id === selected) ? selected : info.parts.find((p) => !p.power)?.id ?? info.parts[0]?.id;
    if (keep) await select(keep);
    else detail.innerHTML = `<div class="empty">The libraries are empty.</div>`;
  }

  search.oninput = renderList;
  host.querySelector<HTMLButtonElement>(".libnew")!.onclick = showRequest;
  host.querySelectorAll<HTMLButtonElement>("[data-lf]").forEach((b) => (b.onclick = () => {
    filter = b.dataset.lf as "all" | "issues";
    host.querySelectorAll("[data-lf]").forEach((x) => x.classList.toggle("active", x === b));
    renderList();
  }));
  refresh();
  return {
    refresh, select,
    dispose: () => { three?.dispose(); host.innerHTML = ""; },
    selection: () => ({ part: request ? undefined : selected ?? undefined, aspect: request ? undefined : aspect, request }),
    snapshot3d: () => three?.snapshot(),
    reviewChanged: renderPartComments,
  };
}
