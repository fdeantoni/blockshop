import * as THREE from "three";
import { GRID } from "@blockshop/schema";
import type { Scene3D } from "./scene.js";
import type { Cell } from "./model.js";

const SIZE = 128;

/**
 * Renders the live scene from a fixed three-quarter front view into a small
 * offscreen renderer with preserveDrawingBuffer, so toDataURL is reliable.
 */
export class ThumbnailRenderer {
  private renderer: THREE.WebGLRenderer;
  private camera: THREE.OrthographicCamera;

  constructor() {
    const canvas = document.createElement("canvas");
    canvas.width = SIZE; canvas.height = SIZE;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(SIZE, SIZE, false);
    this.renderer.setClearColor(0x000000, 0);
    // Same "front on +z" convention as the editor: camera in the +x/+z quadrant, looking at the piece.
    this.camera = new THREE.OrthographicCamera(-GRID, GRID, GRID, -GRID, 0.1, 200);
  }

  /** Frame the piece's bounds (cells, inclusive) rather than the whole grid. */
  render(scene: Scene3D, bounds: { min: Cell; max: Cell } | null): string {
    const c = bounds
      ? new THREE.Vector3((bounds.min.x + bounds.max.x + 1) / 2, (bounds.min.y + bounds.max.y + 1) / 2, (bounds.min.z + bounds.max.z + 1) / 2)
      : new THREE.Vector3(GRID / 2, GRID / 2, GRID / 2);
    const extent = bounds ? Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z) + 1 : GRID;
    const half = Math.max(2, extent * 0.78);
    this.camera.left = -half; this.camera.right = half; this.camera.top = half; this.camera.bottom = -half;
    this.camera.position.set(c.x + 30, c.y + 26, c.z + 34);
    this.camera.lookAt(c);
    this.camera.updateProjectionMatrix();
    const restore = scene.hideHelpers();
    this.renderer.render(scene.scene, this.camera);
    restore();
    return this.renderer.domElement.toDataURL("image/png");
  }

  dispose(): void { this.renderer.dispose(); }
}
