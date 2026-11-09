// 3D board view: GLB generated server-side by `kicad-cli pcb export glb`, rendered with three.js.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Anchor } from "../../shared/review";

const REFDES = /^[A-Z]{1,4}\d+[A-Z]?$/;

export interface ThreeView {
  snapshot(): string;
  /** Tint the part(s) with this refdes (null clears) and optionally frame the camera on them. */
  highlight(ref: string | string[] | null, frame?: boolean): void;
  /** Reset the camera to frame the whole board. */
  fit(): void;
  dispose(): void;
}

const HIGHLIGHT = new THREE.Color(0xff7a1a);

export async function mountThree(
  host: HTMLElement,
  rev: string,
  onPick: (a: Anchor | null) => void,
): Promise<ThreeView | null> {
  host.innerHTML = `<div class="notice">Generating 3D model with kicad-cli…</div>`;
  const res = await fetch(`/api/3d.glb?rev=${rev}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    host.innerHTML = `<div class="notice">3D unavailable:\n\n${err.error}</div>`;
    return null;
  }
  const buf = await res.arrayBuffer();

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(devicePixelRatio);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1f1f1f);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 2));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(1, 2, 1.5);
  scene.add(sun);

  const gltf = await new GLTFLoader().parseAsync(buf, "");
  const model = gltf.scene;
  scene.add(model);

  // Frame the board.
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  const center = box.getCenter(new THREE.Vector3());
  const camera = new THREE.PerspectiveCamera(35, 1, size / 1000, size * 100);
  camera.position.copy(center).add(new THREE.Vector3(0, size * 1.1, size * 0.8));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.update();
  const home = { pos: camera.position.clone(), target: controls.target.clone() };
  const fit = () => { camera.position.copy(home.pos); controls.target.copy(home.target); controls.update(); };

  host.replaceChildren(renderer.domElement);

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = host;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  // Click (without drag) to pick: walk up the node tree looking for a refdes-like name.
  // NOTE: depends on how kicad-cli names GLB nodes; verify against real exports and adjust.
  const ray = new THREE.Raycaster();
  let down: [number, number] | null = null;
  renderer.domElement.addEventListener("pointerdown", (e) => (down = [e.clientX, e.clientY]));
  renderer.domElement.addEventListener("pointerup", (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(
      new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1),
      camera,
    );
    const hit = ray.intersectObject(model, true)[0];
    for (let o: THREE.Object3D | null = hit?.object ?? null; o; o = o.parent) {
      const name = o.name.split(/[\s_:]/)[0] ?? "";
      if (REFDES.test(name)) return onPick({ kind: "symbol", ref: name });
    }
    onPick(null);
  });

  // kicad-cli names each part's GLB node by its bare refdes (verified on KiCad 10).
  const nodesByRef = new Map<string, THREE.Object3D>();
  model.traverse((o) => { if (REFDES.test(o.name) && !nodesByRef.has(o.name)) nodesByRef.set(o.name, o); });
  let highlighted: THREE.Mesh[] = [];

  const highlight = (ref: string | string[] | null, frame = false) => {
    for (const m of highlighted) m.material = m.userData.origMaterial;
    highlighted = [];
    const nodes = (ref == null ? [] : Array.isArray(ref) ? ref : [ref]).map((r) => nodesByRef.get(r)).filter((n): n is THREE.Object3D => !!n);
    if (!nodes.length) return;
    for (const node of nodes) node.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.userData.origMaterial ??= m.material;
      const tint = (mat: THREE.Material) => {
        const c = mat.clone() as THREE.MeshStandardMaterial;
        if (c.emissive) { c.emissive = HIGHLIGHT.clone(); c.emissiveIntensity = 0.6; }
        else if ((c as any).color) (c as any).color = HIGHLIGHT.clone();
        return c;
      };
      m.material = Array.isArray(m.material) ? m.material.map(tint) : tint(m.material);
      highlighted.push(m);
    });
    if (frame) {
      const b = new THREE.Box3();
      for (const node of nodes) b.expandByObject(node);
      const c = b.getCenter(new THREE.Vector3());
      const dist = Math.max(b.getSize(new THREE.Vector3()).length() * 4, size * 0.25);
      const dir = camera.position.clone().sub(controls.target).normalize();
      controls.target.copy(c);
      camera.position.copy(c).add(dir.multiplyScalar(dist));
      controls.update();
    }
  };

  let running = true;
  const loop = () => {
    if (!running) return;
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  loop();

  return {
    snapshot: () => renderer.domElement.toDataURL("image/png"),
    highlight,
    fit,
    dispose: () => {
      running = false;
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
    },
  };
}
