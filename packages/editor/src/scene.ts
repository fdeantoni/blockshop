import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GRID, type PaletteEntry } from "@blockshop/schema";
import { CELL_CENTER_OFFSET, type Cell, type VoxelModel } from "./model.js";

export type ViewName = "iso" | "front" | "side" | "top";
export interface Hit { cell: Cell; normal: { x: number; y: number; z: number }; kind: "voxel" | "floor" }

const CENTER = new THREE.Vector3(GRID / 2, GRID / 3, GRID / 2);
/** Camera positions per view; "front" is on +z looking toward -z (see model.ts). */
const VIEWS: Record<ViewName, THREE.Vector3> = {
  iso: new THREE.Vector3(GRID / 2 + 17, GRID / 3 + 14, GRID / 2 + 21),
  front: new THREE.Vector3(GRID / 2, GRID / 2, GRID / 2 + 32),
  side: new THREE.Vector3(GRID / 2 + 32, GRID / 2, GRID / 2),
  top: new THREE.Vector3(GRID / 2, 42, GRID / 2 + 0.01),
};
const MAX_INSTANCES = GRID * GRID * GRID;

/** One long-lived renderer and scene; the model is swapped when another piece is opened. */
export class Scene3D {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
  private meshes = new Map<string, THREE.InstancedMesh>();
  private instanceCells = new Map<string, Cell[]>();
  private helpers = new THREE.Group();
  private seatMarker: THREE.Mesh;
  private model: VoxelModel | null = null;
  private unsubscribe: (() => void) | null = null;
  private dirty = true;
  private raf = 0;
  private raycaster = new THREE.Raycaster();
  private floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private box = new THREE.BoxGeometry(1, 1, 1);

  constructor(readonly canvas: HTMLCanvasElement, palette: readonly PaletteEntry[]) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x1b2230);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300);
    this.camera.position.copy(VIEWS.iso);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(CENTER);
    this.controls.minDistance = 10;
    this.controls.maxDistance = 90;
    this.controls.enableDamping = false;
    this.controls.addEventListener("change", () => this.invalidate());

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x556070, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(14, 30, 20);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-20, 10, -12);
    this.scene.add(fill);

    const grid = new THREE.GridHelper(GRID, GRID, 0x6c7a90, 0x3a4658);
    grid.position.set(GRID / 2, 0, GRID / 2);
    this.helpers.add(grid);
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(GRID, GRID, GRID)), new THREE.LineBasicMaterial({ color: 0x8fa3c4 }));
    outline.position.set(GRID / 2, GRID / 2, GRID / 2);
    this.helpers.add(outline);
    // Front marker: a small bar on the +z edge so kids know where "front" is.
    const front = new THREE.Mesh(new THREE.BoxGeometry(GRID, 0.15, 0.15), new THREE.MeshBasicMaterial({ color: 0xffd166 }));
    front.position.set(GRID / 2, 0.05, GRID + 0.1);
    this.helpers.add(front);
    this.scene.add(this.helpers);

    this.seatMarker = new THREE.Mesh(new THREE.BoxGeometry(GRID, 0.08, GRID), new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.35, depthWrite: false }));
    this.seatMarker.visible = false;
    this.scene.add(this.seatMarker);

    this.setPalette(palette);
    window.addEventListener("resize", this.resize);
    this.resize();
    this.loop();
  }

  setPalette(palette: readonly PaletteEntry[]): void {
    for (const m of this.meshes.values()) { this.scene.remove(m); (m.material as THREE.Material).dispose(); m.dispose(); }
    this.meshes.clear();
    this.instanceCells.clear();
    for (const p of palette) {
      const [r, g, b, a] = p.rgba;
      const translucent = p.translucent === true || a < 255;
      const material = new THREE.MeshLambertMaterial({ color: new THREE.Color(r / 255, g / 255, b / 255), transparent: translucent, opacity: translucent ? Math.max(0.25, a / 255) : 1, depthWrite: !translucent });
      const mesh = new THREE.InstancedMesh(this.box, material, MAX_INSTANCES);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.userData["paletteId"] = p.id;
      this.scene.add(mesh);
      this.meshes.set(p.id, mesh);
      this.instanceCells.set(p.id, []);
    }
    this.rebuild();
  }

  setModel(model: VoxelModel): void {
    this.unsubscribe?.();
    this.model = model;
    this.unsubscribe = model.onChange(() => this.rebuild());
    this.rebuild();
  }

  rebuild(): void {
    const m = new THREE.Matrix4();
    const counts = new Map<string, number>();
    for (const cells of this.instanceCells.values()) cells.length = 0;
    if (this.model) {
      for (const [cell, color] of this.model.entries()) {
        const mesh = this.meshes.get(color);
        const cells = this.instanceCells.get(color);
        if (!mesh || !cells) continue; // unknown palette id: not drawn
        const i = counts.get(color) ?? 0;
        m.makeTranslation(cell.x + CELL_CENTER_OFFSET, cell.y + CELL_CENTER_OFFSET, cell.z + CELL_CENTER_OFFSET);
        mesh.setMatrixAt(i, m);
        cells[i] = cell;
        counts.set(color, i + 1);
      }
    }
    for (const [id, mesh] of this.meshes) {
      mesh.count = counts.get(id) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      // Raycasting tests the bounding sphere first; it is computed from the instances
      // present at the time, so it must be refreshed whenever the instances change.
      if (mesh.count > 0) mesh.computeBoundingSphere();
    }
    this.invalidate();
  }

  /** What is under a screen point: a voxel (with face normal) or a floor cell. */
  raycast(clientX: number, clientY: number): Hit | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.meshes.values()].filter((mm) => mm.count > 0);
    const hits = this.raycaster.intersectObjects(meshes, false);
    const hit = hits[0];
    if (hit && hit.instanceId !== undefined && hit.face) {
      const id = (hit.object as THREE.InstancedMesh).userData["paletteId"] as string;
      const cell = this.instanceCells.get(id)?.[hit.instanceId];
      if (cell) {
        const n = hit.face.normal; // instances are translation-only, so object normal == world normal
        return { cell, normal: { x: n.x, y: n.y, z: n.z }, kind: "voxel" };
      }
    }
    const p = new THREE.Vector3();
    if (this.raycaster.ray.intersectPlane(this.floor, p) && p.x >= 0 && p.x < GRID && p.z >= 0 && p.z < GRID) {
      return { cell: { x: Math.floor(p.x), y: 0, z: Math.floor(p.z) }, normal: { x: 0, y: 1, z: 0 }, kind: "floor" };
    }
    return null;
  }

  setView(view: ViewName): void {
    this.camera.position.copy(VIEWS[view]);
    this.controls.target.copy(CENTER);
    this.controls.update();
    this.invalidate();
  }

  setSeatMarker(height: number | null): void {
    this.seatMarker.visible = height !== null;
    if (height !== null) this.seatMarker.position.set(GRID / 2, height + 0.02, GRID / 2);
    this.invalidate();
  }

  /** Hide grid, outline and seat marker (thumbnails); returns a restore function. */
  hideHelpers(): () => void {
    const seat = this.seatMarker.visible;
    this.helpers.visible = false;
    this.seatMarker.visible = false;
    return () => { this.helpers.visible = true; this.seatMarker.visible = seat; this.invalidate(); };
  }

  invalidate(): void { this.dirty = true; }

  private resize = (): void => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  };

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (!this.dirty) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    this.unsubscribe?.();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
