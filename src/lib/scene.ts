import { parseGLB, type LoadGLBOptions } from "./glb-loader.ts";
import { generatePolygonHatchSegments, sampleCatmullRom2D, type ScreenVertex } from "./hatching.ts";
import {
  clipViewSegmentNear,
  cross3,
  dot3,
  mat4FromTRS,
  mat4Identity,
  mat4LookAt,
  mat4Multiply,
  mat4OrthoZO,
  mat4PerspectiveZO,
  normalize3,
  sub3,
  transformDirectionMat4,
  transformPointMat4,
  transformVec4Mat4,
  triangulatePolygon2D,
} from "./math.ts";
import {
  CANDIDATE_FLAGS,
  type CameraConfig,
  type CompiledSceneData,
  type HatchFillStyle,
  type LayerSpec,
  type Mat4,
  type PaperConfig,
  type ProjectedCandidateSegment,
  type ProjectedTriangle,
  type SceneStyleOverrides,
  type StrokeStyle,
  type Vec2,
  type Vec3,
} from "./types.ts";

export interface MeshFaceInput {
  readonly indices: number[];
  readonly fill?: HatchFillStyle | null;
}

export interface AddMesh3DOptions {
  readonly vertices: Vec3[];
  /** Each entry is a triangle [i0,i1,i2], quad [i0,i1,i2,i3], or n-gon index list */
  readonly faces: (number[] | MeshFaceInput)[];
  readonly position?: Vec3;
  readonly rotationDeg?: Vec3;
  readonly scale?: Vec3;
  readonly transform?: Mat4;
  readonly stroke?: StrokeStyle | false;
  readonly fill?: HatchFillStyle;
  /** Whether this mesh writes to the G-Buffer to occlude lines behind it (default: true) */
  readonly occlude?: boolean;
  /** Treat open surfaces (like cloth sheets) as two-sided so both sides draw strokes/fills (default: false) */
  readonly doubleSided?: boolean;
}

export interface AddBox3DOptions {
  readonly size?: Vec3;
  readonly position?: Vec3;
  readonly rotationDeg?: Vec3;
  readonly transform?: Mat4;
  readonly stroke?: StrokeStyle | false;
  readonly fill?: HatchFillStyle;
  /** Optional per-face fill override (+X, -X, +Y, -Y, +Z, -Z) */
  readonly faceFills?: Partial<Record<"px" | "nx" | "py" | "ny" | "pz" | "nz", HatchFillStyle | null>>;
  readonly occlude?: boolean;
}

export interface AddGridMesh3DOptions {
  readonly cols: number;
  readonly rows: number;
  readonly vertexFn: (u: number, v: number, col: number, row: number) => Vec3;
  readonly position?: Vec3;
  readonly rotationDeg?: Vec3;
  readonly stroke?: StrokeStyle | false;
  readonly fill?: HatchFillStyle;
  /** Draw quad grid lines (default: true) */
  readonly drawGridLines?: boolean;
  readonly occlude?: boolean;
}

export interface AddSphere3DOptions {
  readonly radius?: number;
  readonly position?: Vec3;
  readonly rotationDeg?: Vec3;
  readonly latSegments?: number;
  readonly lonSegments?: number;
  readonly stroke?: StrokeStyle | false;
  readonly fill?: HatchFillStyle;
  readonly occlude?: boolean;
}

export interface AddPolyline3DOptions {
  readonly points: Vec3[];
  readonly layer?: string;
  readonly closed?: boolean;
  readonly clipToObjectId?: number;
}

interface StoredMesh3D {
  readonly objectId: number;
  readonly vertices: Vec3[];
  readonly faces: { indices: number[]; fill?: HatchFillStyle | null }[];
  readonly modelMatrix: Mat4;
  readonly stroke: StrokeStyle | false;
  readonly fill?: HatchFillStyle;
  readonly occlude: boolean;
  readonly forceDrawInternalEdges: boolean;
  readonly doubleSided: boolean;
}

interface StoredPolyline3D {
  readonly objectId: number;
  readonly points: Vec3[];
  readonly layer: string;
  readonly closed: boolean;
  readonly clipToObjectId?: number;
}

const DEFAULT_LAYERS: LayerSpec[] = [
  { id: "default", name: "01-Primary-Ink", color: "#141413", strokeWidthMm: 0.22 },
  { id: "hatch", name: "02-Hatch-Fill", color: "#1d4ed8", strokeWidthMm: 0.18 },
  { id: "accent", name: "03-Accent-Ink", color: "#c2410c", strokeWidthMm: 0.22 },
  { id: "secondary", name: "04-Secondary-Ink", color: "#047857", strokeWidthMm: 0.2 },
];

export class PlotterScene3D {
  private camera: CameraConfig;
  private meshes: StoredMesh3D[] = [];
  private polylines: StoredPolyline3D[] = [];
  private layers = new Map<string, LayerSpec>();
  private nextObjectId = 1;

  constructor(camera?: Partial<CameraConfig>) {
    this.camera = {
      type: camera?.type ?? "perspective",
      position: camera?.position ?? [12, 10, 16],
      target: camera?.target ?? [0, 0, 0],
      up: camera?.up ?? [0, 1, 0],
      fovDeg: camera?.fovDeg ?? 42,
      orthoHeight: camera?.orthoHeight ?? 20,
      near: camera?.near ?? 0.2,
      far: camera?.far ?? 500,
    };
    for (const l of DEFAULT_LAYERS) {
      this.layers.set(l.id, l);
    }
  }

  registerLayer(spec: LayerSpec): this {
    this.layers.set(spec.id, {
      id: spec.id,
      name: spec.name ?? spec.id,
      color: spec.color ?? "#141413",
      strokeWidthMm: spec.strokeWidthMm ?? 0.2,
    });
    return this;
  }

  setCamera(camera: Partial<CameraConfig>): this {
    this.camera = { ...this.camera, ...camera };
    return this;
  }

  getCamera(): CameraConfig {
    return this.camera;
  }

  /**
   * Applies global studio UI overrides (hatch mode, angle offset, light direction,
   * highlight/shadow cutoffs, crease angle, edge toggles, and pen width) across all meshes in the scene.
   */
  applyOverrides(overrides: SceneStyleOverrides): this {
    if (overrides.penWidthMm !== undefined) {
      const scale = overrides.penWidthMm / 0.2;
      for (const [id, spec] of this.layers.entries()) {
        this.layers.set(id, {
          ...spec,
          strokeWidthMm: Number(((spec.strokeWidthMm ?? 0.2) * scale).toFixed(3)),
        });
      }
    }

    this.meshes = this.meshes.map((m) => {
      let stroke = m.stroke;
      if (stroke !== false) {
        stroke = {
          ...stroke,
          creaseAngleDeg: overrides.creaseAngleDeg ?? stroke.creaseAngleDeg,
          silhouettes: overrides.drawSilhouettes ?? stroke.silhouettes,
          outlines: overrides.drawOutlines ?? stroke.outlines,
          wireframe:
            overrides.drawWireframe !== undefined
              ? overrides.drawWireframe || stroke.wireframe
              : stroke.wireframe,
        };
      }

      const faces = m.faces.map((f) => ({
        indices: f.indices,
        fill:
          f.fill === undefined
            ? undefined
            : f.fill === null
              ? null
              : transformHatchFill(f.fill, overrides),
      }));

      return {
        ...m,
        stroke,
        fill: m.fill ? transformHatchFill(m.fill, overrides) : undefined,
        faces,
      };
    });

    return this;
  }

  addMesh(opts: AddMesh3DOptions & { forceDrawInternalEdges?: boolean }): number {
    const objectId = this.nextObjectId++;
    const rotRad: Vec3 = opts.rotationDeg
      ? [
          (opts.rotationDeg[0] * Math.PI) / 180,
          (opts.rotationDeg[1] * Math.PI) / 180,
          (opts.rotationDeg[2] * Math.PI) / 180,
        ]
      : [0, 0, 0];

    const trs = mat4FromTRS(opts.position ?? [0, 0, 0], rotRad, opts.scale ?? [1, 1, 1]);
    const modelMatrix = opts.transform ? mat4Multiply(opts.transform, trs) : trs;

    const normalizedFaces = opts.faces.map((f) =>
      Array.isArray(f) ? { indices: f } : { indices: f.indices, fill: f.fill }
    );

    this.meshes.push({
      objectId,
      vertices: opts.vertices,
      faces: normalizedFaces,
      modelMatrix,
      stroke:
        opts.stroke === false
          ? false
          : {
              layer: opts.stroke?.layer ?? "default",
              outlines: opts.stroke?.outlines ?? true,
              silhouettes: opts.stroke?.silhouettes ?? true,
              creaseAngleDeg: opts.stroke?.creaseAngleDeg ?? 25,
              wireframe: opts.stroke?.wireframe ?? false,
            },
      fill: opts.fill,
      occlude: opts.occlude ?? true,
      forceDrawInternalEdges: opts.forceDrawInternalEdges ?? false,
      doubleSided: opts.doubleSided ?? false,
    });

    return objectId;
  }

  addBox(opts: AddBox3DOptions = {}): number {
    const [sx, sy, sz] = opts.size ?? [2, 2, 2];
    const hx = sx * 0.5;
    const hy = sy * 0.5;
    const hz = sz * 0.5;

    const vertices: Vec3[] = [
      [-hx, -hy, -hz], // 0
      [hx, -hy, -hz],  // 1
      [hx, hy, -hz],   // 2
      [-hx, hy, -hz],  // 3
      [-hx, -hy, hz],  // 4
      [hx, -hy, hz],   // 5
      [hx, hy, hz],    // 6
      [-hx, hy, hz],   // 7
    ];

    // Counter-clockwise outward-facing winding (right-hand rule) for all 6 box faces:
    const faces: MeshFaceInput[] = [
      { indices: [5, 1, 2, 6], fill: opts.faceFills?.px }, // +X
      { indices: [0, 4, 7, 3], fill: opts.faceFills?.nx }, // -X
      { indices: [7, 6, 2, 3], fill: opts.faceFills?.py }, // +Y
      { indices: [0, 1, 5, 4], fill: opts.faceFills?.ny }, // -Y
      { indices: [4, 5, 6, 7], fill: opts.faceFills?.pz }, // +Z
      { indices: [1, 0, 3, 2], fill: opts.faceFills?.nz }, // -Z
    ];

    return this.addMesh({
      vertices,
      faces,
      position: opts.position,
      rotationDeg: opts.rotationDeg,
      transform: opts.transform,
      stroke: opts.stroke,
      fill: opts.fill,
      occlude: opts.occlude,
    });
  }

  addGridMesh(opts: AddGridMesh3DOptions): number {
    const { cols, rows, vertexFn } = opts;
    const vertices: Vec3[] = [];
    for (let r = 0; r <= rows; r++) {
      const v = r / rows;
      for (let c = 0; c <= cols; c++) {
        const u = c / cols;
        vertices.push(vertexFn(u, v, c, r));
      }
    }

    const stride = cols + 1;
    const faces: number[][] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i00 = r * stride + c;
        const i10 = i00 + 1;
        const i11 = (r + 1) * stride + c + 1;
        const i01 = (r + 1) * stride + c;
        // Counter-clockwise when viewed from +Y so surface normal points upward (+Y)
        faces.push([i00, i01, i11, i10]);
      }
    }

    return this.addMesh({
      vertices,
      faces,
      position: opts.position,
      rotationDeg: opts.rotationDeg,
      stroke: opts.stroke,
      fill: opts.fill,
      occlude: opts.occlude,
      forceDrawInternalEdges: opts.drawGridLines ?? true,
      doubleSided: true,
    });
  }

  addSphere(opts: AddSphere3DOptions = {}): number {
    const radius = opts.radius ?? 2.0;
    const latSegs = Math.max(4, opts.latSegments ?? 18);
    const lonSegs = Math.max(6, opts.lonSegments ?? 28);

    const vertices: Vec3[] = [];
    const northPoleIdx = 0;
    vertices.push([0, radius, 0]);

    // Intermediate latitude rings (lat = 1 to latSegs - 1)
    for (let lat = 1; lat < latSegs; lat++) {
      const theta = (lat * Math.PI) / latSegs;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      for (let lon = 0; lon < lonSegs; lon++) {
        const phi = (lon * 2 * Math.PI) / lonSegs;
        vertices.push([
          radius * sinT * Math.cos(phi),
          radius * cosT,
          radius * sinT * Math.sin(phi),
        ]);
      }
    }

    const southPoleIdx = vertices.length;
    vertices.push([0, -radius, 0]);

    const faces: number[][] = [];

    // 1. Top cap triangle fan connected to North Pole (outward counter-clockwise winding)
    for (let lon = 0; lon < lonSegs; lon++) {
      const nextLon = (lon + 1) % lonSegs;
      const v0 = 1 + lon;
      const v1 = 1 + nextLon;
      faces.push([northPoleIdx, v1, v0]);
    }

    // 2. Intermediate quad bands (outward counter-clockwise winding)
    for (let lat = 0; lat < latSegs - 2; lat++) {
      const row0 = 1 + lat * lonSegs;
      const row1 = 1 + (lat + 1) * lonSegs;
      for (let lon = 0; lon < lonSegs; lon++) {
        const nextLon = (lon + 1) % lonSegs;
        const i00 = row0 + lon;
        const i10 = row0 + nextLon;
        const i11 = row1 + nextLon;
        const i01 = row1 + lon;
        faces.push([i00, i10, i11, i01]);
      }
    }

    // 3. Bottom cap triangle fan connected to South Pole (outward counter-clockwise winding)
    const lastRow = 1 + (latSegs - 2) * lonSegs;
    for (let lon = 0; lon < lonSegs; lon++) {
      const nextLon = (lon + 1) % lonSegs;
      const v0 = lastRow + lon;
      const v1 = lastRow + nextLon;
      faces.push([southPoleIdx, v0, v1]);
    }

    return this.addMesh({
      vertices,
      faces,
      position: opts.position,
      rotationDeg: opts.rotationDeg,
      stroke: opts.stroke,
      fill: opts.fill,
      occlude: opts.occlude,
    });
  }

  addPolyline3D(opts: AddPolyline3DOptions): number {
    const objectId = this.nextObjectId++;
    this.polylines.push({
      objectId,
      points: opts.points,
      layer: opts.layer ?? "default",
      closed: opts.closed ?? false,
      clipToObjectId: opts.clipToObjectId,
    });
    return objectId;
  }

  /**
   * Parses and adds all triangle meshes from a binary glTF 2.0 (`.glb`) buffer.
   */
  addGLB(
    buffer: ArrayBuffer | Uint8Array,
    opts: Omit<AddMesh3DOptions, "vertices" | "faces"> & LoadGLBOptions = {}
  ): number[] {
    const meshes = parseGLB(buffer, {
      center: opts.center ?? true,
      normalizeSize: opts.normalizeSize,
    });

    const ids: number[] = [];
    for (const m of meshes) {
      ids.push(
        this.addMesh({
          vertices: m.vertices,
          faces: m.faces,
          position: opts.position,
          rotationDeg: opts.rotationDeg,
          scale: opts.scale,
          transform: opts.transform,
          stroke: opts.stroke,
          fill: opts.fill,
          occlude: opts.occlude,
          doubleSided: opts.doubleSided,
        })
      );
    }
    return ids;
  }

  /**
   * Compiles the 3D scene into projected G-Buffer triangles and candidate 2D/3D segments.
   */
  compile(paper: PaperConfig, resolution: [number, number]): CompiledSceneData {
    const [resW, resH] = resolution;
    const aspect = paper.widthMm / paper.heightMm;
    const near = this.camera.near ?? 0.2;
    const far = this.camera.far ?? 500;

    const viewMat = mat4LookAt(
      this.camera.position,
      this.camera.target,
      this.camera.up ?? [0, 1, 0]
    );

    const projMat =
      this.camera.type === "orthographic"
        ? mat4OrthoZO(
            -(this.camera.orthoHeight ?? 20) * 0.5 * aspect,
            (this.camera.orthoHeight ?? 20) * 0.5 * aspect,
            -(this.camera.orthoHeight ?? 20) * 0.5,
            (this.camera.orthoHeight ?? 20) * 0.5,
            near,
            far
          )
        : mat4PerspectiveZO(((this.camera.fovDeg ?? 42) * Math.PI) / 180, aspect, near, far);

    const layerList = Array.from(this.layers.values());
    const layerIndexMap = new Map<string, number>();
    layerList.forEach((l, idx) => layerIndexMap.set(l.id, idx));

    const getLayerIdx = (id?: string): number => {
      if (!id) return 0;
      const existing = layerIndexMap.get(id);
      if (existing !== undefined) return existing;
      const newIdx = layerList.length;
      const spec: LayerSpec = { id, name: id, color: "#141413", strokeWidthMm: 0.2 };
      layerList.push(spec);
      layerIndexMap.set(id, newIdx);
      return newIdx;
    };

    const triangles: ProjectedTriangle[] = [];
    const candidates: ProjectedCandidateSegment[] = [];
    const pxPerMm = resW / paper.widthMm;

    let nextFaceId = 1;
    let nextLineId = 1;

    const viewToScreen = (vView: Vec3): { clip: [number, number, number, number]; xPx: number; yPx: number; z: number } => {
      const clip = transformVec4Mat4(vView, projMat);
      const invW = 1.0 / (Math.abs(clip[3]) > 1e-7 ? clip[3] : 1e-7);
      const ndcX = clip[0] * invW;
      const ndcY = clip[1] * invW;
      const xPx = (ndcX * 0.5 + 0.5) * resW;
      const yPx = (0.5 - ndcY * 0.5) * resH;
      const linearZ = Math.max(near * 0.5, -vView[2]);
      return { clip, xPx, yPx, z: linearZ };
    };

    for (const mesh of this.meshes) {
      const worldVerts = mesh.vertices.map((v) => transformPointMat4(v, mesh.modelMatrix));
      const viewVerts = worldVerts.map((v) => transformPointMat4(v, viewMat));

      interface CompiledFace {
        readonly faceId: number;
        readonly indices: number[];
        readonly worldNormal: Vec3;
        readonly viewNormal: Vec3;
        readonly frontFacing: boolean;
        readonly slope: number;
        readonly screenPoly: ScreenVertex[];
        readonly fill?: HatchFillStyle | null;
      }

      const compiledFaces: CompiledFace[] = [];
      // Map canonical edge key "minIdx_maxIdx" -> adjacent faces
      const edgeMap = new Map<
        string,
        { vA: number; vB: number; faces: CompiledFace[] }
      >();

      for (const faceDef of mesh.faces) {
        const idxs = faceDef.indices;
        if (idxs.length < 3) continue;

        const faceId = nextFaceId++;
        const p0w = worldVerts[idxs[0]];
        const p1w = worldVerts[idxs[1]];
        const p2w = worldVerts[idxs[2]];
        const worldNormal = normalize3(cross3(sub3(p1w, p0w), sub3(p2w, p0w)));

        const p0v = viewVerts[idxs[0]];
        const p1v = viewVerts[idxs[1]];
        const p2v = viewVerts[idxs[2]];
        const viewNormal = normalize3(cross3(sub3(p1v, p0v), sub3(p2v, p0v)));

        // View vector from surface point to camera origin (0,0,0) in view space is -p0v
        const toCam =
          this.camera.type === "orthographic"
            ? ([0, 0, 1] as Vec3)
            : normalize3([-p0v[0], -p0v[1], -p0v[2]]);
        const facingDot = dot3(viewNormal, toCam);
        const frontFacing = facingDot >= -0.02;
        const slope = Math.max(0.08, Math.abs(facingDot));

        // Project polygon vertices for hatching (if all vertices are in front of near plane)
        const screenPoly: ScreenVertex[] = [];
        let allInFront = true;
        const projectedVerts = idxs.map((vi) => {
          const vv = viewVerts[vi];
          if (vv[2] > -near * 0.8) allInFront = false;
          return viewToScreen(vv);
        });

        if (allInFront) {
          for (const pv of projectedVerts) {
            screenPoly.push({ xPx: pv.xPx, yPx: pv.yPx, z: pv.z });
          }
        }

        // Emit G-Buffer triangles via fan triangulation of the polygon
        if (mesh.occlude && allInFront) {
          for (let t = 1; t < projectedVerts.length - 1; t++) {
            const tv0 = projectedVerts[0];
            const tv1 = projectedVerts[t];
            const tv2 = projectedVerts[t + 1];
            triangles.push({
              v0Clip: tv0.clip,
              v1Clip: tv1.clip,
              v2Clip: tv2.clip,
              z0: tv0.z,
              z1: tv1.z,
              z2: tv2.z,
              objectId: mesh.objectId,
              faceId,
              slope,
            });
          }
        }

        const compiledFace: CompiledFace = {
          faceId,
          indices: idxs,
          worldNormal,
          viewNormal,
          frontFacing,
          slope,
          screenPoly,
          fill: faceDef.fill,
        };
        compiledFaces.push(compiledFace);

        // Record polygon boundary edges (skipping internal fan diagonals!)
        for (let e = 0; e < idxs.length; e++) {
          const va = idxs[e];
          const vb = idxs[(e + 1) % idxs.length];
          const minV = Math.min(va, vb);
          const maxV = Math.max(va, vb);
          const key = `${minV}_${maxV}`;
          const existing = edgeMap.get(key);
          if (existing) {
            existing.faces.push(compiledFace);
          } else {
            edgeMap.set(key, { vA: va, vB: vb, faces: [compiledFace] });
          }
        }
      }

      // 1. Emit feature / wireframe edges for this mesh
      if (mesh.stroke !== false) {
        const stroke = mesh.stroke;
        const strokeLayerIdx = getLayerIdx(stroke.layer);
        const creaseCos = Math.cos(((stroke.creaseAngleDeg ?? 25) * Math.PI) / 180);
        const baseFlags = CANDIDATE_FLAGS.EDGE_KERNEL;

        for (const edge of edgeMap.values()) {
          const f0 = edge.faces[0];
          const f1 = edge.faces[1];

          let shouldDraw = false;
          if (stroke.wireframe || mesh.forceDrawInternalEdges) {
            // Draw if at least one adjacent face faces the camera (or mesh is doubleSided / non-occluding)
            shouldDraw =
              !mesh.occlude ||
              mesh.doubleSided ||
              f0.frontFacing ||
              (f1 ? f1.frontFacing : false);
          } else if (!f1) {
            // Open boundary edge
            shouldDraw =
              (stroke.outlines ?? true) &&
              (!mesh.occlude || mesh.doubleSided || f0.frontFacing);
          } else {
            // Shared edge between f0 and f1
            const isSilhouette = f0.frontFacing !== f1.frontFacing;
            const normalDot = dot3(f0.worldNormal, f1.worldNormal);
            const isCrease =
              normalDot < creaseCos &&
              (mesh.doubleSided || f0.frontFacing || f1.frontFacing);

            if ((stroke.silhouettes ?? true) && isSilhouette) shouldDraw = true;
            if ((stroke.outlines ?? true) && isCrease) shouldDraw = true;
          }

          if (!shouldDraw) continue;

          const clipped = clipViewSegmentNear(viewVerts[edge.vA], viewVerts[edge.vB], near);
          if (!clipped) continue;

          const s0 = viewToScreen(clipped[0]);
          const s1 = viewToScreen(clipped[1]);

          candidates.push({
            x0Px: s0.xPx,
            y0Px: s0.yPx,
            z0: s0.z,
            faceId0: f0.faceId,
            x1Px: s1.xPx,
            y1Px: s1.yPx,
            z1: s1.z,
            faceId1: f1 ? f1.faceId : 0,
            objectId: mesh.objectId,
            layerId: strokeLayerIdx,
            lineId: nextLineId++,
            flags: baseFlags,
          });
        }
      }

      // 2. Emit surface hatch fills (replacing solid fills on visible faces!)
      for (const face of compiledFaces) {
        if ((!face.frontFacing && !mesh.doubleSided) || face.screenPoly.length < 3) continue;
        const fillStyle = face.fill === null ? undefined : (face.fill ?? mesh.fill);
        if (!fillStyle) continue;

        const effectiveNormal: Vec3 =
          !face.frontFacing && mesh.doubleSided
            ? [-face.worldNormal[0], -face.worldNormal[1], -face.worldNormal[2]]
            : face.worldNormal;

        const hatchLayerIdx = getLayerIdx(fillStyle.layer ?? "hatch");
        const hatchSegs = generatePolygonHatchSegments(
          face.screenPoly,
          fillStyle,
          pxPerMm,
          effectiveNormal
        );

        for (const hs of hatchSegs) {
          candidates.push({
            x0Px: hs.x0Px,
            y0Px: hs.y0Px,
            z0: hs.z0,
            faceId0: face.faceId,
            x1Px: hs.x1Px,
            y1Px: hs.y1Px,
            z1: hs.z1,
            faceId1: 0,
            objectId: mesh.objectId,
            layerId: hatchLayerIdx,
            lineId: nextLineId++,
            flags: CANDIDATE_FLAGS.NONE,
          });
        }
      }
    }

    // 3. Emit standalone 3D polylines
    for (const poly of this.polylines) {
      const pts = poly.points;
      if (pts.length < 2) continue;
      const layerIdx = getLayerIdx(poly.layer);
      const lineId = nextLineId++;
      const count = poly.closed ? pts.length : pts.length - 1;
      let flags = 0;
      if (poly.clipToObjectId !== undefined) {
        flags |= CANDIDATE_FLAGS.CLIP_TO_OBJECT;
      }

      for (let i = 0; i < count; i++) {
        const v0 = transformPointMat4(pts[i], viewMat);
        const v1 = transformPointMat4(pts[(i + 1) % pts.length], viewMat);
        const clipped = clipViewSegmentNear(v0, v1, near);
        if (!clipped) continue;

        const s0 = viewToScreen(clipped[0]);
        const s1 = viewToScreen(clipped[1]);

        candidates.push({
          x0Px: s0.xPx,
          y0Px: s0.yPx,
          z0: s0.z,
          faceId0: 0,
          x1Px: s1.xPx,
          y1Px: s1.yPx,
          z1: s1.z,
          faceId1: 0,
          objectId: poly.clipToObjectId ?? poly.objectId,
          layerId: layerIdx,
          lineId,
          flags,
        });
      }
    }

    const firstLight = this.meshes.find(
      (m) => m.fill && m.fill.kind === "parallel" && m.fill.shadeByLight?.direction
    )?.fill;
    const lightDir = firstLight && firstLight.kind === "parallel" ? firstLight.shadeByLight?.direction : undefined;

    return {
      triangles,
      candidates,
      layers: layerList,
      viewMatrix: viewMat,
      lightDirection: lightDir,
    };
  }
}

export interface AddPolygon2DOptions {
  /** Polygon vertices in physical paper millimeters [xMm, yMm] */
  readonly points: Vec2[];
  /** Higher zIndex occludes lower zIndex (if omitted, uses painter's draw order) */
  readonly zIndex?: number;
  /**
   * "normal": occludes shapes behind it and optionally draws stroke/fill
   * "erase": negative mask that hides strokes behind it without drawing outlines
   * "transparent": draws stroke/fill without blocking shapes behind it
   */
  readonly mode?: "normal" | "erase" | "transparent";
  readonly stroke?: {
    readonly layer?: string;
  } | false;
  readonly fill?: HatchFillStyle;
  /** Optional positive clip mask ID: only draw where G-Buffer matches clipToObjectId */
  readonly clipToObjectId?: number;
}

export interface AddRect2DOptions extends Omit<AddPolygon2DOptions, "points"> {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotationDeg?: number;
}

export interface AddCircle2DOptions extends Omit<AddPolygon2DOptions, "points"> {
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  readonly ry?: number;
  readonly rotationDeg?: number;
  readonly segments?: number;
}

export interface AddRibbonBlade2DOptions {
  readonly spinePoints: Vec2[];
  readonly baseWidthMm: number;
  readonly tipWidthMm?: number;
  readonly zIndex?: number;
  readonly strokeLayer?: string;
  readonly drawCenterVein?: boolean;
  readonly fill?: HatchFillStyle;
}

export interface AddPolyline2DOptions {
  readonly points: Vec2[];
  readonly zIndex?: number;
  readonly layer?: string;
  readonly closed?: boolean;
  readonly smoothSpline?: boolean;
  readonly clipToObjectId?: number;
  readonly ignoreOcclusion?: boolean;
}

interface StoredItem2D {
  readonly objectId: number;
  readonly kind: "polygon" | "polyline";
  readonly points: Vec2[];
  readonly zIndex: number;
  readonly mode: "normal" | "erase" | "transparent";
  readonly stroke: { layer: string } | false;
  readonly fill?: HatchFillStyle;
  readonly closed: boolean;
  readonly clipToObjectId?: number;
  readonly ignoreOcclusion: boolean;
}

/**
 * First-class 2D Scene builder working directly in physical paper millimeters [0..widthMm, 0..heightMm].
 * Supports painter's order / zIndex occlusion, positive & negative masks, and 2D procedural fills.
 */
export class PlotterScene2D {
  private items: StoredItem2D[] = [];
  private layers = new Map<string, LayerSpec>();
  private nextObjectId = 1;
  private autoZCounter = 1;

  constructor() {
    for (const l of DEFAULT_LAYERS) {
      this.layers.set(l.id, l);
    }
  }

  registerLayer(spec: LayerSpec): this {
    this.layers.set(spec.id, {
      id: spec.id,
      name: spec.name ?? spec.id,
      color: spec.color ?? "#141413",
      strokeWidthMm: spec.strokeWidthMm ?? 0.2,
    });
    return this;
  }

  applyOverrides(overrides: SceneStyleOverrides): this {
    if (overrides.penWidthMm !== undefined) {
      const scale = overrides.penWidthMm / 0.2;
      for (const [id, spec] of this.layers.entries()) {
        this.layers.set(id, {
          ...spec,
          strokeWidthMm: Number(((spec.strokeWidthMm ?? 0.2) * scale).toFixed(3)),
        });
      }
    }

    this.items = this.items.map((item) => ({
      ...item,
      fill: item.fill ? transformHatchFill(item.fill, overrides) : undefined,
    }));

    return this;
  }

  addPolygon(opts: AddPolygon2DOptions): number {
    const objectId = this.nextObjectId++;
    const zIndex = opts.zIndex ?? this.autoZCounter++;
    const mode = opts.mode ?? "normal";

    this.items.push({
      objectId,
      kind: "polygon",
      points: opts.points,
      zIndex,
      mode,
      stroke:
        mode === "erase" || opts.stroke === false
          ? false
          : {
              layer: opts.stroke?.layer ?? "default",
            },
      fill: mode === "erase" ? undefined : opts.fill,
      closed: true,
      clipToObjectId: opts.clipToObjectId,
      ignoreOcclusion: false,
    });

    return objectId;
  }

  addRect(opts: AddRect2DOptions): number {
    const { x, y, width, height, rotationDeg = 0 } = opts;
    const cx = x + width * 0.5;
    const cy = y + height * 0.5;
    const hw = width * 0.5;
    const hh = height * 0.5;
    const rad = (rotationDeg * Math.PI) / 180;
    const cosA = Math.cos(rad);
    const sinA = Math.sin(rad);

    const corners: Vec2[] = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ].map(([dx, dy]) => [cx + dx * cosA - dy * sinA, cy + dx * sinA + dy * cosA]);

    return this.addPolygon({ ...opts, points: corners });
  }

  addCircle(opts: AddCircle2DOptions): number {
    const rx = opts.radius;
    const ry = opts.ry ?? opts.radius;
    const segs = Math.max(12, opts.segments ?? 48);
    const rot = ((opts.rotationDeg ?? 0) * Math.PI) / 180;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);

    const points: Vec2[] = [];
    for (let i = 0; i < segs; i++) {
      const a = (i * 2 * Math.PI) / segs;
      const lx = Math.cos(a) * rx;
      const ly = Math.sin(a) * ry;
      points.push([
        opts.cx + lx * cosR - ly * sinR,
        opts.cy + lx * sinR + ly * cosR,
      ]);
    }

    return this.addPolygon({ ...opts, points });
  }

  /**
   * Adds an organic 2D tapered blade / ribbon (such as Gábor Ugray's Generative Grass blades)
   * that blocks shapes behind it and draws its outline + optional center vein or hatch.
   */
  addRibbonBlade(opts: AddRibbonBlade2DOptions): number {
    const spine =
      opts.spinePoints.length >= 3
        ? sampleCatmullRom2D(opts.spinePoints, 8, false)
        : opts.spinePoints;
    if (spine.length < 2) return -1;

    const zIndex = opts.zIndex ?? this.autoZCounter++;
    const tipWidth = opts.tipWidthMm ?? 0.0;
    const leftPts: Vec2[] = [];
    const rightPts: Vec2[] = [];

    for (let i = 0; i < spine.length; i++) {
      const t = i / (spine.length - 1);
      // Smooth taper curve from base to tip
      const halfW = 0.5 * (opts.baseWidthMm * Math.pow(1 - t, 0.75) + tipWidth * t);
      const prev = spine[Math.max(0, i - 1)];
      const next = spine[Math.min(spine.length - 1, i + 1)];
      const dx = next[0] - prev[0];
      const dy = next[1] - prev[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;

      leftPts.push([spine[i][0] + nx * halfW, spine[i][1] + ny * halfW]);
      rightPts.push([spine[i][0] - nx * halfW, spine[i][1] - ny * halfW]);
    }

    const polygonPoints: Vec2[] = [...leftPts];
    for (let i = rightPts.length - 1; i >= 0; i--) {
      if (i === rightPts.length - 1 && tipWidth <= 0.05) continue;
      polygonPoints.push(rightPts[i]);
    }

    const objId = this.addPolygon({
      points: polygonPoints,
      zIndex,
      mode: "normal",
      stroke: {
        layer: opts.strokeLayer ?? "default",
      },
      fill: opts.fill,
    });

    if (opts.drawCenterVein && spine.length >= 3) {
      const veinPts = spine.slice(0, Math.max(2, Math.floor(spine.length * 0.82)));
      this.addPolyline({
        points: veinPts,
        zIndex: zIndex + 0.05,
        layer: opts.strokeLayer ?? "default",
      });
    }

    return objId;
  }

  addPolyline(opts: AddPolyline2DOptions): number {
    const objectId = this.nextObjectId++;
    const zIndex = opts.zIndex ?? this.autoZCounter++;
    const pts =
      opts.smoothSpline && opts.points.length >= 3
        ? sampleCatmullRom2D(opts.points, 10, opts.closed ?? false)
        : opts.points;

    this.items.push({
      objectId,
      kind: "polyline",
      points: pts,
      zIndex,
      mode: "transparent",
      stroke: {
        layer: opts.layer ?? "default",
      },
      closed: opts.closed ?? false,
      clipToObjectId: opts.clipToObjectId,
      ignoreOcclusion: opts.ignoreOcclusion ?? false,
    });

    return objectId;
  }

  compile(paper: PaperConfig, resolution: [number, number]): CompiledSceneData {
    const [resW, resH] = resolution;
    const pxPerMmX = resW / paper.widthMm;
    const pxPerMmY = resH / paper.heightMm;

    const layerList = Array.from(this.layers.values());
    const layerIndexMap = new Map<string, number>();
    layerList.forEach((l, idx) => layerIndexMap.set(l.id, idx));

    const getLayerIdx = (id?: string): number => {
      if (!id) return 0;
      const existing = layerIndexMap.get(id);
      if (existing !== undefined) return existing;
      const newIdx = layerList.length;
      layerList.push({ id, name: id, color: "#141413", strokeWidthMm: 0.2 });
      layerIndexMap.set(id, newIdx);
      return newIdx;
    };

    // Map zIndex to positive linear depth Z in [1.0 .. 100.0] where higher zIndex = smaller Z (closer to camera!)
    let minZIdx = 0;
    let maxZIdx = 1;
    for (const item of this.items) {
      if (item.zIndex < minZIdx) minZIdx = item.zIndex;
      if (item.zIndex > maxZIdx) maxZIdx = item.zIndex;
    }
    const zSpan = Math.max(1, maxZIdx - minZIdx + 2);

    const zIndexToLinearZ = (zIdx: number): number => {
      const norm = (maxZIdx + 1 - zIdx) / zSpan; // in (0, 1]
      return 1.0 + norm * 90.0;
    };

    const mmToClipAndPx = (pt: Vec2, linearZ: number) => {
      const xPx = pt[0] * pxPerMmX;
      const yPx = pt[1] * pxPerMmY;
      const ndcX = (pt[0] / paper.widthMm) * 2.0 - 1.0;
      const ndcY = 1.0 - (pt[1] / paper.heightMm) * 2.0;
      const clipZ = (linearZ - 1.0) / 100.0; // in [0, 1]
      return {
        clip: [ndcX, ndcY, clipZ, 1.0] as [number, number, number, number],
        xPx,
        yPx,
        z: linearZ,
      };
    };

    const triangles: ProjectedTriangle[] = [];
    const candidates: ProjectedCandidateSegment[] = [];
    let nextFaceId = 1;
    let nextLineId = 1;

    for (const item of this.items) {
      const linearZ = zIndexToLinearZ(item.zIndex);

      if (item.kind === "polygon") {
        if (item.points.length < 3) continue;
        const faceId = nextFaceId++;
        const projPts = item.points.map((pt) => mmToClipAndPx(pt, linearZ));

        // 1. Triangulate interior into G-Buffer if mode is "normal" or "erase"
        if (item.mode === "normal" || item.mode === "erase") {
          const triIndices = triangulatePolygon2D(item.points);
          const encodedObjId = item.mode === "erase" ? -item.objectId : item.objectId;
          for (const [i0, i1, i2] of triIndices) {
            const p0 = projPts[i0];
            const p1 = projPts[i1];
            const p2 = projPts[i2];
            triangles.push({
              v0Clip: p0.clip,
              v1Clip: p1.clip,
              v2Clip: p2.clip,
              z0: linearZ,
              z1: linearZ,
              z2: linearZ,
              objectId: encodedObjId,
              faceId,
              slope: 1.0,
            });
          }
        }

        // 2. Emit polygon outline segments
        if (item.stroke !== false) {
          const layerIdx = getLayerIdx(item.stroke.layer);
          const lineId = nextLineId++;
          let flags: number = CANDIDATE_FLAGS.EDGE_KERNEL;
          if (item.clipToObjectId !== undefined) {
            flags |= CANDIDATE_FLAGS.CLIP_TO_OBJECT;
          }

          for (let i = 0; i < projPts.length; i++) {
            const a = projPts[i];
            const b = projPts[(i + 1) % projPts.length];
            candidates.push({
              x0Px: a.xPx,
              y0Px: a.yPx,
              z0: linearZ,
              faceId0: item.mode === "transparent" ? 0 : faceId,
              x1Px: b.xPx,
              y1Px: b.yPx,
              z1: linearZ,
              faceId1: 0,
              objectId: item.clipToObjectId ?? item.objectId,
              layerId: layerIdx,
              lineId,
              flags,
            });
          }
        }

        // 3. Emit interior 2D hatch fill
        if (item.fill) {
          const hatchLayerIdx = getLayerIdx(item.fill.layer ?? "hatch");
          const screenPoly: ScreenVertex[] = projPts.map((p) => ({
            xPx: p.xPx,
            yPx: p.yPx,
            z: linearZ,
          }));
          const hatchSegs = generatePolygonHatchSegments(
            screenPoly,
            item.fill,
            pxPerMmX,
            [0, 0, 1]
          );

          let hatchFlags = CANDIDATE_FLAGS.NONE;
          if (item.clipToObjectId !== undefined) {
            hatchFlags |= CANDIDATE_FLAGS.CLIP_TO_OBJECT;
          }

          for (const hs of hatchSegs) {
            candidates.push({
              x0Px: hs.x0Px,
              y0Px: hs.y0Px,
              z0: linearZ,
              faceId0: item.mode === "transparent" ? 0 : faceId,
              x1Px: hs.x1Px,
              y1Px: hs.y1Px,
              z1: linearZ,
              faceId1: 0,
              objectId: item.clipToObjectId ?? item.objectId,
              layerId: hatchLayerIdx,
              lineId: nextLineId++,
              flags: hatchFlags,
            });
          }
        }
      } else if (item.kind === "polyline" && item.stroke !== false) {
        if (item.points.length < 2) continue;
        const projPts = item.points.map((pt) => mmToClipAndPx(pt, linearZ));
        const layerIdx = getLayerIdx(item.stroke.layer);
        const lineId = nextLineId++;
        const count = item.closed ? projPts.length : projPts.length - 1;

        let flags = 0;
        if (item.clipToObjectId !== undefined) {
          flags |= CANDIDATE_FLAGS.CLIP_TO_OBJECT;
        }
        if (item.ignoreOcclusion) {
          flags |= CANDIDATE_FLAGS.IGNORE_OCCLUSION;
        }

        for (let i = 0; i < count; i++) {
          const a = projPts[i];
          const b = projPts[(i + 1) % projPts.length];
          candidates.push({
            x0Px: a.xPx,
            y0Px: a.yPx,
            z0: linearZ,
            faceId0: 0,
            x1Px: b.xPx,
            y1Px: b.yPx,
            z1: linearZ,
            faceId1: 0,
            objectId: item.clipToObjectId ?? item.objectId,
            layerId: layerIdx,
            lineId,
            flags,
          });
        }
      }
    }

    return { triangles, candidates, layers: layerList };
  }
}

function transformHatchFill(
  fill: HatchFillStyle,
  overrides: SceneStyleOverrides
): HatchFillStyle | undefined {
  const mode = overrides.hatchMode ?? "default";
  if (mode === "none") {
    return undefined;
  }

  // Preserve custom user-provided hatching routines unless mode is none
  if (fill.kind === "custom") {
    return fill;
  }

  const angleOffset = overrides.hatchAngleOffsetDeg ?? 0;
  const baseSpacing = fill.spacingMm ?? 0.85;
  const baseAngle = fill.angleDeg ?? 40;
  const prevShade = fill.shadeByLight;

  if (mode === "parallel" || mode === "cross-hatch") {
    return {
      kind: "parallel",
      layer: fill.layer,
      angleDeg: baseAngle + angleOffset,
      crossHatch: mode === "cross-hatch",
      crossAngleDeg: (fill.crossAngleDeg ?? baseAngle + 90) + angleOffset,
      spacingMm: baseSpacing,
      insetMm: fill.insetMm,
      shadeByLight:
        prevShade || overrides.lightDirection || overrides.highlightCutoff !== undefined
          ? {
              direction: overrides.lightDirection ?? prevShade?.direction ?? [0.7, 0.9, 0.5],
              minSpacingMm: prevShade?.minSpacingMm ?? baseSpacing * 0.55,
              maxSpacingMm: prevShade?.maxSpacingMm ?? baseSpacing * 2.1,
              highlightCutoff: overrides.highlightCutoff ?? prevShade?.highlightCutoff ?? 0.78,
              crossHatchThreshold:
                overrides.crossHatchThreshold ?? prevShade?.crossHatchThreshold ?? 0.48,
            }
          : undefined,
    };
  }

  // mode === "default": keep original parallel/cross-hatch setting, applying angle offset & light overrides
  return {
    ...fill,
    angleDeg: (fill.angleDeg ?? 45) + angleOffset,
    crossAngleDeg:
      fill.crossAngleDeg !== undefined ? fill.crossAngleDeg + angleOffset : undefined,
    shadeByLight: fill.shadeByLight
      ? {
          ...fill.shadeByLight,
          direction: overrides.lightDirection ?? fill.shadeByLight.direction,
          highlightCutoff:
            overrides.highlightCutoff ?? fill.shadeByLight.highlightCutoff,
          crossHatchThreshold:
            overrides.crossHatchThreshold ?? fill.shadeByLight.crossHatchThreshold,
        }
      : undefined,
  };
}

export type AnyPlotterScene = PlotterScene3D | PlotterScene2D;
