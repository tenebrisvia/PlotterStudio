import type { Vec3 } from "./types.ts";

export interface ParsedGLBMesh {
  readonly name: string;
  readonly vertices: Vec3[];
  readonly faces: [number, number, number][];
  readonly boundsMin: Vec3;
  readonly boundsMax: Vec3;
}

export interface LoadGLBOptions {
  /** Center the model's bounding box at [0, 0, 0] (default: true) */
  readonly center?: boolean;
  /** Normalize the longest bounding-box dimension to this size in world units (e.g. 8.0) */
  readonly normalizeSize?: number;
}

/**
 * Lightweight zero-dependency binary GLTF 2.0 (`.glb`) mesh extractor.
 * Works identically in browsers (`fetch(...).then(r => r.arrayBuffer())`) and Node.js (`readFileSync`).
 */
export function parseGLB(
  buffer: ArrayBuffer | Uint8Array,
  options: LoadGLBOptions = {}
): ParsedGLBMesh[] {
  const bytes =
    buffer instanceof Uint8Array
      ? buffer
      : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = view.getUint32(0, true);
  if (magic !== 0x46546c67) {
    throw new Error("Invalid GLB file: missing glTF magic header");
  }

  const jsonChunkLength = view.getUint32(12, true);
  const jsonChunkType = view.getUint32(16, true);
  if (jsonChunkType !== 0x4e4f534a) {
    throw new Error("Invalid GLB file: first chunk is not JSON");
  }

  const jsonBytes = bytes.subarray(20, 20 + jsonChunkLength);
  const jsonText = new TextDecoder("utf-8").decode(jsonBytes);
  const gltf = JSON.parse(jsonText);

  const binChunkOffset = 20 + jsonChunkLength;
  const binStart = binChunkOffset + 8;

  const accessors = gltf.accessors ?? [];
  const bufferViews = gltf.bufferViews ?? [];
  const meshes = gltf.meshes ?? [];

  const readAccessorVec3 = (accIdx: number): Vec3[] => {
    const acc = accessors[accIdx];
    const bv = bufferViews[acc.bufferView];
    const byteOffset = binStart + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const count = acc.count as number;
    const stride = bv.byteStride ?? 12;
    const out: Vec3[] = new Array(count);

    for (let i = 0; i < count; i++) {
      const off = byteOffset + i * stride;
      out[i] = [
        view.getFloat32(off, true),
        view.getFloat32(off + 4, true),
        view.getFloat32(off + 8, true),
      ];
    }
    return out;
  };

  const readAccessorScalarIndices = (accIdx: number): Uint32Array => {
    const acc = accessors[accIdx];
    const bv = bufferViews[acc.bufferView];
    const byteOffset = binStart + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const count = acc.count as number;
    const compType = acc.componentType as number;
    const out = new Uint32Array(count);

    if (compType === 5125) {
      // UNSIGNED_INT
      for (let i = 0; i < count; i++) {
        out[i] = view.getUint32(byteOffset + i * 4, true);
      }
    } else if (compType === 5123) {
      // UNSIGNED_SHORT
      for (let i = 0; i < count; i++) {
        out[i] = view.getUint16(byteOffset + i * 2, true);
      }
    } else if (compType === 5121) {
      // UNSIGNED_BYTE
      for (let i = 0; i < count; i++) {
        out[i] = view.getUint8(byteOffset + i);
      }
    } else {
      throw new Error(`Unsupported GLB index componentType: ${compType}`);
    }
    return out;
  };

  interface RawPrimitive {
    name: string;
    vertices: Vec3[];
    faces: [number, number, number][];
  }

  const rawPrimitives: RawPrimitive[] = [];
  let globalMinX = Infinity, globalMinY = Infinity, globalMinZ = Infinity;
  let globalMaxX = -Infinity, globalMaxY = -Infinity, globalMaxZ = -Infinity;

  for (const mesh of meshes) {
    for (const prim of mesh.primitives ?? []) {
      if (prim.mode !== undefined && prim.mode !== 4) continue; // Only TRIANGLES (mode 4)
      const posAccIdx = prim.attributes?.POSITION;
      if (posAccIdx === undefined) continue;

      const vertices = readAccessorVec3(posAccIdx);
      const faces: [number, number, number][] = [];

      if (prim.indices !== undefined) {
        const idxArray = readAccessorScalarIndices(prim.indices);
        for (let i = 0; i + 2 < idxArray.length; i += 3) {
          faces.push([idxArray[i], idxArray[i + 1], idxArray[i + 2]]);
        }
      } else {
        for (let i = 0; i + 2 < vertices.length; i += 3) {
          faces.push([i, i + 1, i + 2]);
        }
      }

      for (const [x, y, z] of vertices) {
        if (x < globalMinX) globalMinX = x;
        if (y < globalMinY) globalMinY = y;
        if (z < globalMinZ) globalMinZ = z;
        if (x > globalMaxX) globalMaxX = x;
        if (y > globalMaxY) globalMaxY = y;
        if (z > globalMaxZ) globalMaxZ = z;
      }

      rawPrimitives.push({
        name: mesh.name ?? "glb-mesh",
        vertices,
        faces,
      });
    }
  }

  const shouldCenter = options.center ?? true;
  const targetSize = options.normalizeSize;
  const cx = shouldCenter ? 0.5 * (globalMinX + globalMaxX) : 0;
  const cy = shouldCenter ? 0.5 * (globalMinY + globalMaxY) : 0;
  const cz = shouldCenter ? 0.5 * (globalMinZ + globalMaxZ) : 0;
  const maxExtent = Math.max(
    globalMaxX - globalMinX,
    globalMaxY - globalMinY,
    globalMaxZ - globalMinZ,
    1e-6
  );
  const scale = targetSize !== undefined ? targetSize / maxExtent : 1.0;

  const parsedMeshes: ParsedGLBMesh[] = [];

  for (const raw of rawPrimitives) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    const vertices: Vec3[] = raw.vertices.map(([x, y, z]) => {
      const tx = (x - cx) * scale;
      const ty = (y - cy) * scale;
      const tz = (z - cz) * scale;
      if (tx < minX) minX = tx;
      if (ty < minY) minY = ty;
      if (tz < minZ) minZ = tz;
      if (tx > maxX) maxX = tx;
      if (ty > maxY) maxY = ty;
      if (tz > maxZ) maxZ = tz;
      return [tx, ty, tz];
    });

    parsedMeshes.push({
      name: raw.name,
      vertices,
      faces: raw.faces,
      boundsMin: [minX, minY, minZ],
      boundsMax: [maxX, maxY, maxZ],
    });
  }

  return parsedMeshes;
}

/**
 * Fast spatial vertex-clustering mesh decimator for interactive Level-of-Detail (LOD).
 * At `lodRatio = 1.0`, returns the original mesh untouched.
 * At `lodRatio < 1.0` (e.g. 0.2 .. 0.95), clusters vertices on a uniform 3D grid,
 * averages cluster centroids, and filters out degenerate triangles while preserving winding.
 */
export function decimateMeshLOD(
  mesh: ParsedGLBMesh,
  lodRatio: number
): ParsedGLBMesh {
  if (lodRatio >= 0.99) {
    return mesh;
  }

  const clamped = Math.max(0.1, Math.min(1.0, lodRatio));
  const [minX, minY, minZ] = mesh.boundsMin;
  const [maxX, maxY, maxZ] = mesh.boundsMax;
  const spanX = Math.max(1e-5, maxX - minX);
  const spanY = Math.max(1e-5, maxY - minY);
  const spanZ = Math.max(1e-5, maxZ - minZ);
  const maxSpan = Math.max(spanX, spanY, spanZ);

  // Target grid resolution scales with sqrt(targetVertexCount)
  const targetVerts = Math.max(40, Math.round(mesh.vertices.length * clamped * clamped));
  const gridRes = Math.max(6, Math.min(160, Math.round(Math.pow(targetVerts, 0.46) * 1.35)));
  const cellSize = maxSpan / gridRes;

  const clusterMap = new Map<
    string,
    { id: number; sumX: number; sumY: number; sumZ: number; count: number }
  >();
  const oldToNew = new Uint32Array(mesh.vertices.length);
  let nextId = 0;

  for (let i = 0; i < mesh.vertices.length; i++) {
    const [x, y, z] = mesh.vertices[i];
    const gx = Math.floor((x - minX) / cellSize);
    const gy = Math.floor((y - minY) / cellSize);
    const gz = Math.floor((z - minZ) / cellSize);
    const key = `${gx}_${gy}_${gz}`;

    let cluster = clusterMap.get(key);
    if (!cluster) {
      cluster = { id: nextId++, sumX: 0, sumY: 0, sumZ: 0, count: 0 };
      clusterMap.set(key, cluster);
    }
    cluster.sumX += x;
    cluster.sumY += y;
    cluster.sumZ += z;
    cluster.count++;
    oldToNew[i] = cluster.id;
  }

  const newVertices: Vec3[] = new Array(nextId);
  for (const c of clusterMap.values()) {
    newVertices[c.id] = [c.sumX / c.count, c.sumY / c.count, c.sumZ / c.count];
  }

  const newFaces: [number, number, number][] = [];
  const seenTri = new Set<string>();

  for (const [i0, i1, i2] of mesh.faces) {
    const a = oldToNew[i0];
    const b = oldToNew[i1];
    const c = oldToNew[i2];
    if (a === b || b === c || c === a) continue;

    // Deduplicate identical triangles regardless of cyclic shift
    const minIdx = Math.min(a, b, c);
    const maxIdx = Math.max(a, b, c);
    const midIdx = a + b + c - minIdx - maxIdx;
    const key = `${minIdx}_${midIdx}_${maxIdx}`;
    if (seenTri.has(key)) continue;
    seenTri.add(key);

    newFaces.push([a, b, c]);
  }

  return {
    name: mesh.name,
    vertices: newVertices,
    faces: newFaces,
    boundsMin: mesh.boundsMin,
    boundsMax: mesh.boundsMax,
  };
}
