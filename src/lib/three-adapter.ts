import type * as THREE from "three";
import { cross3, dot3, normalize3, sub3 } from "./math.ts";
import { PlotterScene3D } from "./scene.ts";
import type { HatchFillStyle, StrokeStyle, Vec3 } from "./types.ts";

export interface ThreeObjectPlotConfig {
  readonly stroke?: StrokeStyle | false;
  readonly fill?: HatchFillStyle;
  readonly occlude?: boolean;
}

export interface ThreeAdapterOptions {
  readonly defaultStroke?: StrokeStyle;
  readonly defaultFill?: HatchFillStyle;
  /** Optional callback to customize stroke/fill per THREE.Mesh */
  readonly resolveMeshStyle?: (mesh: THREE.Mesh) => ThreeObjectPlotConfig | null;
}

/**
 * Converts a Three.js Scene (or Object3D hierarchy) and Camera into a `PlotterScene3D`.
 * Automatically welds coincident vertices and merges coplanar triangle pairs into quads
 * so Three.js BufferGeometries produce clean feature outlines and continuous hatch lines.
 */
export function fromThreeScene(
  root: THREE.Object3D,
  camera: THREE.Camera,
  options: ThreeAdapterOptions = {}
): PlotterScene3D {
  root.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);

  const camPos = camera.position;
  const forward: Vec3 = [0, 0, -1];
  const worldQuat = camera.quaternion;
  // Apply quaternion to (0, 0, -1)
  const qx = worldQuat.x, qy = worldQuat.y, qz = worldQuat.z, qw = worldQuat.w;
  const ix = qw * forward[0] + qy * forward[2] - qz * forward[1];
  const iy = qw * forward[1] + qz * forward[0] - qx * forward[2];
  const iz = qw * forward[2] + qx * forward[1] - qy * forward[0];
  const iw = -qx * forward[0] - qy * forward[1] - qz * forward[2];
  const fx = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  const fy = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  const fz = iz * qw + iw * -qz + ix * -qy - iy * -qx;

  const isPerspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera;
  const fovDeg = isPerspective ? (camera as THREE.PerspectiveCamera).fov : 42;
  const near = (camera as THREE.PerspectiveCamera).near ?? 0.2;
  const far = (camera as THREE.PerspectiveCamera).far ?? 500;

  const scene = new PlotterScene3D({
    type: isPerspective ? "perspective" : "orthographic",
    position: [camPos.x, camPos.y, camPos.z],
    target: [camPos.x + fx * 10, camPos.y + fy * 10, camPos.z + fz * 10],
    up: [camera.up.x, camera.up.y, camera.up.z],
    fovDeg,
    near,
    far,
  });

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;

    const customCfg =
      options.resolveMeshStyle?.(mesh) ??
      (mesh.userData?.plotter as ThreeObjectPlotConfig | undefined);
    if (customCfg === null) return;

    const geom = mesh.geometry as THREE.BufferGeometry;
    const posAttr = geom.getAttribute("position");
    if (!posAttr) return;

    const e = mesh.matrixWorld.elements;
    const mat = new Float32Array(e);

    // Weld vertices by quantized local position so indexed/non-indexed BufferGeometries share topology
    const vertices: Vec3[] = [];
    const weldMap = new Map<string, number>();

    const getWeldedIndex = (idx: number): number => {
      const x = posAttr.getX(idx);
      const y = posAttr.getY(idx);
      const z = posAttr.getZ(idx);
      const key = `${Math.round(x * 1e4)}_${Math.round(y * 1e4)}_${Math.round(z * 1e4)}`;
      const existing = weldMap.get(key);
      if (existing !== undefined) return existing;
      const newIdx = vertices.length;
      vertices.push([x, y, z]);
      weldMap.set(key, newIdx);
      return newIdx;
    };

    const rawTriangles: [number, number, number][] = [];
    const indexAttr = geom.getIndex();
    if (indexAttr) {
      for (let i = 0; i + 2 < indexAttr.count; i += 3) {
        const a = getWeldedIndex(indexAttr.getX(i));
        const b = getWeldedIndex(indexAttr.getX(i + 1));
        const c = getWeldedIndex(indexAttr.getX(i + 2));
        if (a !== b && b !== c && c !== a) {
          rawTriangles.push([a, b, c]);
        }
      }
    } else {
      for (let i = 0; i + 2 < posAttr.count; i += 3) {
        const a = getWeldedIndex(i);
        const b = getWeldedIndex(i + 1);
        const c = getWeldedIndex(i + 2);
        if (a !== b && b !== c && c !== a) {
          rawTriangles.push([a, b, c]);
        }
      }
    }

    const faces = mergeCoplanarTrianglesToQuads(vertices, rawTriangles);

    scene.addMesh({
      vertices,
      faces,
      transform: mat,
      stroke: customCfg?.stroke ?? options.defaultStroke,
      fill: customCfg?.fill ?? options.defaultFill,
      occlude: customCfg?.occlude ?? true,
    });
  });

  return scene;
}

/**
 * Merges pairs of adjacent triangles with identical normals into 4-vertex quads
 * so internal diagonal triangulation edges are not treated as polygon boundaries.
 */
function mergeCoplanarTrianglesToQuads(
  vertices: Vec3[],
  triangles: [number, number, number][]
): number[][] {
  const normals: Vec3[] = triangles.map(([a, b, c]) =>
    normalize3(cross3(sub3(vertices[b], vertices[a]), sub3(vertices[c], vertices[a])))
  );

  const used = new Uint8Array(triangles.length);
  const faces: number[][] = [];

  for (let i = 0; i < triangles.length; i++) {
    if (used[i]) continue;
    const tA = triangles[i];
    const nA = normals[i];

    // Check next triangle first (most Three.js generators emit quad pairs consecutively)
    let merged = false;
    const limit = Math.min(triangles.length, i + 6);
    for (let j = i + 1; j < limit; j++) {
      if (used[j]) continue;
      if (dot3(nA, normals[j]) < 0.9995) continue;

      const quad = tryCombineTrianglePair(tA, triangles[j], vertices, nA);
      if (quad) {
        used[i] = 1;
        used[j] = 1;
        faces.push(quad);
        merged = true;
        break;
      }
    }

    if (!merged) {
      used[i] = 1;
      faces.push(tA);
    }
  }

  return faces;
}

function isQuadConvex(
  q: [number, number, number, number],
  vertices: Vec3[],
  normal: Vec3
): boolean {
  const p0 = vertices[q[0]];
  const p1 = vertices[q[1]];
  const p2 = vertices[q[2]];
  const p3 = vertices[q[3]];

  const e0 = sub3(p1, p0);
  const e1 = sub3(p2, p1);
  const e2 = sub3(p3, p2);
  const e3 = sub3(p0, p3);

  const eps = 1e-6;
  return (
    dot3(cross3(e0, e1), normal) > eps &&
    dot3(cross3(e1, e2), normal) > eps &&
    dot3(cross3(e2, e3), normal) > eps &&
    dot3(cross3(e3, e0), normal) > eps
  );
}

function tryCombineTrianglePair(
  t0: [number, number, number],
  t1: [number, number, number],
  vertices: Vec3[],
  normal: Vec3
): number[] | null {
  for (let e0 = 0; e0 < 3; e0++) {
    const a0 = t0[e0];
    const b0 = t0[(e0 + 1) % 3];
    const opp0 = t0[(e0 + 2) % 3];

    for (let e1 = 0; e1 < 3; e1++) {
      const a1 = t1[e1];
      const b1 = t1[(e1 + 1) % 3];
      const opp1 = t1[(e1 + 2) % 3];

      if (a0 === b1 && b0 === a1) {
        const candidateQuad: [number, number, number, number] = [opp0, a0, opp1, b0];
        if (isQuadConvex(candidateQuad, vertices, normal)) {
          return candidateQuad;
        }
        return null;
      }
    }
  }
  return null;
}
