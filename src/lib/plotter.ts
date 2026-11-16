import {
  compute,
  draw,
  effect,
  frame,
  init,
  storage,
  target,
  type Gpu,
  type StorageBuffer,
  type Target,
} from "vgpu";
import { transformDirectionMat4 } from "./math.ts";
import {
  chainConnectedPolylines,
  computeTotalDrawLengthMm,
  computeTotalTravelLengthMm,
  connectMeanderHatchPolylines,
  optimizePenTravelOrder,
  simplifyPolylineRDP,
  stitchSubSegmentsByLineId,
  type RawEmittedSubSegment,
} from "./optimize.ts";
import { PlotterScene2D, PlotterScene3D, type AnyPlotterScene } from "./scene.ts";
import { GBUFFER_SHADER, LINE_MARCHER_SHADER, PREVIEW_SHADER } from "./shaders/index.ts";
import { serializePlotToSVG } from "./svg.ts";
import {
  PaperSize,
  type CameraConfig,
  type PaperConfig,
  type PlotExecutionOptions,
  type PlotLayerOutput,
  type PlotResult,
  type PlotterOptions,
  type SVGExportOptions,
  type Vec3,
} from "./types.ts";

export class WebGPUPlotter {
  readonly gpu: Gpu;
  private readonly ownsGpu: boolean;
  private paper: PaperConfig;
  private penWidthMm: number;
  private majorResolution: number;
  private gbufferTarget: Target;
  private previewTarget?: Target;
  private previewEffect?: ReturnType<typeof effect>;

  private pooledVertexBuffer?: { buffer: StorageBuffer; capacity: number };
  private pooledCandidatesBuffer?: { buffer: StorageBuffer; capacity: number };
  private pooledOutSegmentsBuffer?: { buffer: StorageBuffer; capacity: number };
  private pooledCounterBuffer?: StorageBuffer;
  private gbufferDraw?: ReturnType<typeof draw>;
  private marchCompute?: ReturnType<typeof compute>;

  constructor(gpu: Gpu, ownsGpu: boolean, opts: PlotterOptions = {}) {
    this.gpu = gpu;
    this.ownsGpu = ownsGpu;
    this.paper = opts.paper ?? PaperSize.A4_PORTRAIT;
    this.penWidthMm = opts.penWidthMm ?? 0.2;
    this.majorResolution = opts.resolution ?? 2048;

    const size = this.computeTargetResolution();
    this.gbufferTarget = target(this.gpu, {
      label: "plotter-gbuffer",
      size,
      format: "rgba32float",
      depth: "depth32float",
      clearColor: [0, 0, 0, 1e9],
    });
  }

  private acquirePooledBuffer(
    current: { buffer: StorageBuffer; capacity: number } | undefined,
    requiredBytes: number,
    access: "read" | "read-write"
  ): { pooled: { buffer: StorageBuffer; capacity: number }; reallocated: boolean } {
    const minBytes = Math.max(64, requiredBytes);
    if (current && current.capacity >= minBytes) {
      return { pooled: current, reallocated: false };
    }
    if (current) {
      (current.buffer as unknown as { destroy?(): void })?.destroy?.();
    }
    // 1.5x exponential growth aligned to 256 bytes
    const targetBytes = current
      ? Math.max(minBytes, Math.ceil((current.capacity * 1.5) / 256) * 256)
      : Math.max(minBytes, Math.ceil(minBytes / 256) * 256);
    const newBuffer = storage(this.gpu, targetBytes, access);
    return {
      pooled: { buffer: newBuffer, capacity: targetBytes },
      reallocated: true,
    };
  }

  private acquireCounterBuffer(): StorageBuffer {
    if (!this.pooledCounterBuffer) {
      this.pooledCounterBuffer = storage(this.gpu, 16, "read-write");
    }
    return this.pooledCounterBuffer;
  }

  private computeTargetResolution(): [number, number] {
    const aspect = this.paper.widthMm / this.paper.heightMm;
    if (aspect >= 1) {
      const w = this.majorResolution;
      const h = Math.max(64, Math.round(this.majorResolution / aspect));
      return [w, h];
    } else {
      const h = this.majorResolution;
      const w = Math.max(64, Math.round(this.majorResolution * aspect));
      return [w, h];
    }
  }

  getPaper(): PaperConfig {
    return this.paper;
  }

  setPaper(paper: PaperConfig, resolution?: number): this {
    this.paper = paper;
    if (resolution !== undefined) {
      this.majorResolution = resolution;
    }
    const size = this.computeTargetResolution();
    this.gbufferTarget.resize(size);
    this.previewTarget?.resize(size);
    return this;
  }

  createScene3D(camera?: Partial<CameraConfig>): PlotterScene3D {
    return new PlotterScene3D(camera);
  }

  createScene2D(): PlotterScene2D {
    return new PlotterScene2D();
  }

  /**
   * Executes the WebGPU G-Buffer occlusion pass, single-pass WGSL compute line marcher,
   * and CPU vector stitching / TSP path optimization.
   */
  async plot(scene: AnyPlotterScene, options: PlotExecutionOptions = {}): Promise<PlotResult> {
    const totalStart = performance.now();
    const res: [number, number] = [this.gbufferTarget.size[0], this.gbufferTarget.size[1]];
    const compiled = scene.compile(this.paper, res);

    const gpuStart = performance.now();

    // 1. Pack G-Buffer triangles (3 vertices per triangle, 8 floats = 32 bytes per vertex)
    const triCount = compiled.triangles.length;
    const vertCount = triCount * 3;
    const vertFloats = new Float32Array(Math.max(1, vertCount) * 8);

    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < triCount; i++) {
      const t = compiled.triangles[i];
      const base = i * 24;

      if (t.z0 < minZ) minZ = t.z0;
      if (t.z0 > maxZ) maxZ = t.z0;
      if (t.z1 < minZ) minZ = t.z1;
      if (t.z1 > maxZ) maxZ = t.z1;
      if (t.z2 < minZ) minZ = t.z2;
      if (t.z2 > maxZ) maxZ = t.z2;

      // Vertex 0
      vertFloats[base + 0] = t.v0Clip[0];
      vertFloats[base + 1] = t.v0Clip[1];
      vertFloats[base + 2] = t.v0Clip[2];
      vertFloats[base + 3] = t.v0Clip[3];
      vertFloats[base + 4] = t.objectId;
      vertFloats[base + 5] = t.faceId;
      vertFloats[base + 6] = t.slope;
      vertFloats[base + 7] = t.z0;

      // Vertex 1
      vertFloats[base + 8] = t.v1Clip[0];
      vertFloats[base + 9] = t.v1Clip[1];
      vertFloats[base + 10] = t.v1Clip[2];
      vertFloats[base + 11] = t.v1Clip[3];
      vertFloats[base + 12] = t.objectId;
      vertFloats[base + 13] = t.faceId;
      vertFloats[base + 14] = t.slope;
      vertFloats[base + 15] = t.z1;

      // Vertex 2
      vertFloats[base + 16] = t.v2Clip[0];
      vertFloats[base + 17] = t.v2Clip[1];
      vertFloats[base + 18] = t.v2Clip[2];
      vertFloats[base + 19] = t.v2Clip[3];
      vertFloats[base + 20] = t.objectId;
      vertFloats[base + 21] = t.faceId;
      vertFloats[base + 22] = t.slope;
      vertFloats[base + 23] = t.z2;
    }

    if (!Number.isFinite(minZ)) {
      minZ = 1;
      maxZ = 100;
    }

    // 2. Pack Candidate Segments (48 bytes = 12 words per segment)
    const candCount = compiled.candidates.length;
    const maxOutSegments = Math.max(1024, candCount * 12);

    const candArrayBuf = new ArrayBuffer(Math.max(1, candCount) * 48);
    const candF32 = new Float32Array(candArrayBuf);
    const candU32 = new Uint32Array(candArrayBuf);

    for (let i = 0; i < candCount; i++) {
      const c = compiled.candidates[i];
      const base = i * 12;
      candF32[base + 0] = c.x0Px;
      candF32[base + 1] = c.y0Px;
      candF32[base + 2] = c.z0;
      candF32[base + 3] = c.faceId0;

      candF32[base + 4] = c.x1Px;
      candF32[base + 5] = c.y1Px;
      candF32[base + 6] = c.z1;
      candF32[base + 7] = c.faceId1;

      candU32[base + 8] = c.objectId >>> 0;
      candU32[base + 9] = c.layerId >>> 0;
      candU32[base + 10] = c.lineId >>> 0;
      candU32[base + 11] = c.flags >>> 0;
    }

    const vertAcq = this.acquirePooledBuffer(
      this.pooledVertexBuffer,
      vertFloats.byteLength,
      "read"
    );
    this.pooledVertexBuffer = vertAcq.pooled;
    this.pooledVertexBuffer.buffer.write(vertFloats);

    const candAcq = this.acquirePooledBuffer(
      this.pooledCandidatesBuffer,
      candArrayBuf.byteLength,
      "read"
    );
    this.pooledCandidatesBuffer = candAcq.pooled;
    this.pooledCandidatesBuffer.buffer.write(candArrayBuf);

    const outAcq = this.acquirePooledBuffer(
      this.pooledOutSegmentsBuffer,
      maxOutSegments * 48,
      "read-write"
    );
    this.pooledOutSegmentsBuffer = outAcq.pooled;

    const counterBuffer = this.acquireCounterBuffer();
    counterBuffer.write(new Uint32Array([0, 0, 0, 0]));

    let rawCount = 0;
    let outBytes: ArrayBuffer | null = null;
    let gbufferPreviewRGBA: Uint8Array | undefined;

    if (vertCount > 0) {
      if (!this.gbufferDraw) {
        this.gbufferDraw = draw(this.gpu, {
          label: "plotter-gbuffer-pass",
          shader: GBUFFER_SHADER,
          set: { vertices: this.pooledVertexBuffer.buffer },
          cull: "none",
          depth: { write: true, compare: "less-equal" },
        });
      } else if (vertAcq.reallocated) {
        this.gbufferDraw.set({ vertices: this.pooledVertexBuffer.buffer });
      }

      // Execute Pass 1: Rasterize occluding surfaces into rgba32float + depth32float G-Buffer
      this.gbufferDraw.draw({ target: this.gbufferTarget, vertices: vertCount });
    } else {
      // For 2D scenes without 3D geometry, clear G-buffer without emitting a vertex draw of 0
      frame(this.gpu, (f) => {
        f.pass({ target: this.gbufferTarget }, () => {});
      });
    }

    if (!this.marchCompute) {
      this.marchCompute = compute(this.gpu, LINE_MARCHER_SHADER, {
        label: "plotter-line-marcher",
        set: {
          params: {
            resolution: [res[0], res[1]],
            paperSizeMm: [this.paper.widthMm, this.paper.heightMm],
            stepSizePx: options.stepSizePx ?? 0.85,
            depthBias: options.depthBias ?? 0.025,
            edgeSearchRadiusPx: options.edgeSearchRadiusPx ?? 1.25,
            segmentCount: candCount,
            maxOutSegments,
          },
          gbuffer: this.gbufferTarget.color,
          candidates: this.pooledCandidatesBuffer.buffer,
          outSegments: this.pooledOutSegmentsBuffer.buffer,
          counter: counterBuffer,
        },
      });
    } else {
      this.marchCompute.set({
        params: {
          resolution: [res[0], res[1]],
          paperSizeMm: [this.paper.widthMm, this.paper.heightMm],
          stepSizePx: options.stepSizePx ?? 0.85,
          depthBias: options.depthBias ?? 0.025,
          edgeSearchRadiusPx: options.edgeSearchRadiusPx ?? 1.25,
          segmentCount: candCount,
          maxOutSegments,
        },
        gbuffer: this.gbufferTarget.color,
        candidates: this.pooledCandidatesBuffer.buffer,
        outSegments: this.pooledOutSegmentsBuffer.buffer,
        counter: counterBuffer,
      });
    }

    if (candCount > 0) {
      const workgroups = Math.ceil(candCount / 64);
      this.marchCompute.dispatch(workgroups);
    }

    // 3. Read back atomic counter and emitted visible segments
    const counterBytes = await counterBuffer.read();
    rawCount = Math.min(new Uint32Array(counterBytes)[0], maxOutSegments);

    if (rawCount > 0) {
      outBytes = await this.pooledOutSegmentsBuffer.buffer.read();
    }

    // Optional G-Buffer visual preview rendered via fullscreen GPU fragment effect
    if (options.captureGBufferPreview) {
      if (!this.previewTarget) {
        this.previewTarget = target(this.gpu, {
          label: "plotter-preview-target",
          size: res,
          format: "rgba8unorm",
        });
      }

      const rawLight = options.previewLightDirection ?? compiled.lightDirection;
      let viewLightDir: [number, number, number] | undefined;
      if (rawLight) {
        if (compiled.viewMatrix) {
          viewLightDir = transformDirectionMat4(rawLight, compiled.viewMatrix);
        } else {
          viewLightDir = [rawLight[0], rawLight[1], rawLight[2]];
        }
      }

      let lx = -0.52;
      let ly = 0.64;
      let lz = 0.56;
      if (viewLightDir) {
        const len = Math.hypot(viewLightDir[0], viewLightDir[1], viewLightDir[2]) || 1;
        lx = viewLightDir[0] / len;
        ly = viewLightDir[1] / len;
        lz = Math.max(0.15, viewLightDir[2] / len);
        const normL = Math.hypot(lx, ly, lz) || 1;
        lx /= normL;
        ly /= normL;
        lz /= normL;
      }

      const previewParams = {
        resolution: [res[0], res[1]],
        minZ,
        maxZ,
        lightDir: [lx, ly, lz],
        _pad: 0,
      };

      if (!this.previewEffect) {
        this.previewEffect = effect(this.gpu, PREVIEW_SHADER, {
          label: "plotter-preview-effect",
          set: {
            params: previewParams,
            gbuffer: this.gbufferTarget.color,
          },
        });
      } else {
        this.previewEffect.set({
          params: previewParams,
          gbuffer: this.gbufferTarget.color,
        });
      }

      this.previewEffect.draw(this.previewTarget);
      gbufferPreviewRGBA = await this.previewTarget.color.read({
        mipLevel: 0,
        region: "all",
      });
    }

    const gpuTimeMs = performance.now() - gpuStart;
    const postStart = performance.now();

    // 4. Unpack GPU segments per layer and run vector stitching + TSP optimization
    const rawByLayer = new Map<number, RawEmittedSubSegment[]>();
    if (outBytes && rawCount > 0) {
      const outF32 = new Float32Array(outBytes, 0, rawCount * 12);
      const outU32 = new Uint32Array(outBytes, 0, rawCount * 12);

      for (let i = 0; i < rawCount; i++) {
        const base = i * 12;
        const layerId = outU32[base + 8];
        let bucket = rawByLayer.get(layerId);
        if (!bucket) {
          bucket = [];
          rawByLayer.set(layerId, bucket);
        }
        bucket.push({
          x0Mm: outF32[base + 0],
          y0Mm: outF32[base + 1],
          x1Mm: outF32[base + 2],
          y1Mm: outF32[base + 3],
          tStart: outF32[base + 4],
          tEnd: outF32[base + 5],
          layerId,
          lineId: outU32[base + 9],
          objectId: outU32[base + 10],
        });
      }
    }

    const mergeGapMm = options.mergeGapMm ?? Math.max(0.25, this.penWidthMm * 1.4);
    const simplifyTol = options.simplifyToleranceMm ?? 0;

    const layerOutputs: PlotLayerOutput[] = [];
    let finalPolylineCount = 0;
    let finalVertexCount = 0;
    let totalDrawLengthMm = 0;
    let unoptimizedTravelLengthMm = 0;
    let optimizedTravelLengthMm = 0;

    for (let layerIdx = 0; layerIdx < compiled.layers.length; layerIdx++) {
      const spec = compiled.layers[layerIdx];
      const rawSegs = rawByLayer.get(layerIdx) ?? [];

      let polylines = stitchSubSegmentsByLineId(rawSegs, mergeGapMm);
      if (options.chainPolylines ?? true) {
        polylines = chainConnectedPolylines(polylines, mergeGapMm);
      }
      if ((options.hatchJoinDistanceMm ?? 0) > 0) {
        polylines = connectMeanderHatchPolylines(polylines, options.hatchJoinDistanceMm!);
      }
      if (simplifyTol > 0) {
        polylines = polylines.map((p) => simplifyPolylineRDP(p, simplifyTol));
      }

      const unoptTravel = computeTotalTravelLengthMm(polylines);
      unoptimizedTravelLengthMm += unoptTravel;

      if (options.optimizeTravel ?? true) {
        polylines = optimizePenTravelOrder(polylines);
      }

      const optTravel = computeTotalTravelLengthMm(polylines);
      const drawLen = computeTotalDrawLengthMm(polylines);

      optimizedTravelLengthMm += optTravel;
      totalDrawLengthMm += drawLen;
      finalPolylineCount += polylines.length;
      for (const p of polylines) {
        finalVertexCount += p.length;
      }

      if (polylines.length > 0) {
        layerOutputs.push({
          id: spec.id,
          name: spec.name ?? spec.id,
          color: spec.color ?? "#141413",
          strokeWidthMm: spec.strokeWidthMm ?? this.penWidthMm,
          polylines,
          drawLengthMm: drawLen,
          travelLengthMm: optTravel,
        });
      }
    }

    const postProcessTimeMs = performance.now() - postStart;
    const totalTimeMs = performance.now() - totalStart;
    const travelSavingsPercent =
      unoptimizedTravelLengthMm > 1e-3
        ? Math.max(
            0,
            ((unoptimizedTravelLengthMm - optimizedTravelLengthMm) / unoptimizedTravelLengthMm) *
              100
          )
        : 0;

    const paperSnapshot = this.paper;
    return {
      paper: paperSnapshot,
      layers: layerOutputs,
      gbufferPreviewRGBA,
      stats: {
        triangleCount: triCount,
        candidateSegmentCount: candCount,
        rawVisibleSubSegments: rawCount,
        finalPolylineCount,
        finalVertexCount,
        totalDrawLengthMm,
        unoptimizedTravelLengthMm,
        optimizedTravelLengthMm,
        travelSavingsPercent,
        gpuTimeMs,
        postProcessTimeMs,
        totalTimeMs,
        resolution: res,
      },
      toSVG(svgOpts?: SVGExportOptions): string {
        return serializePlotToSVG(paperSnapshot, layerOutputs, svgOpts);
      },
    };
  }

  dispose(): void {
    this.gbufferDraw?.dispose();
    this.gbufferDraw = undefined;
    this.marchCompute?.dispose();
    this.marchCompute = undefined;
    this.previewEffect?.dispose();
    this.previewEffect = undefined;
    this.previewTarget = undefined;

    if (this.pooledVertexBuffer) {
      (this.pooledVertexBuffer.buffer as unknown as { destroy?(): void })?.destroy?.();
      this.pooledVertexBuffer = undefined;
    }
    if (this.pooledCandidatesBuffer) {
      (this.pooledCandidatesBuffer.buffer as unknown as { destroy?(): void })?.destroy?.();
      this.pooledCandidatesBuffer = undefined;
    }
    if (this.pooledOutSegmentsBuffer) {
      (this.pooledOutSegmentsBuffer.buffer as unknown as { destroy?(): void })?.destroy?.();
      this.pooledOutSegmentsBuffer = undefined;
    }
    if (this.pooledCounterBuffer) {
      (this.pooledCounterBuffer as unknown as { destroy?(): void })?.destroy?.();
      this.pooledCounterBuffer = undefined;
    }

    if (this.ownsGpu) {
      this.gpu.dispose();
    }
  }
}

export async function createPlotter(options: PlotterOptions = {}): Promise<WebGPUPlotter> {
  if (options.gpu) {
    return new WebGPUPlotter(options.gpu, false, options);
  }
  const gpu = await init();
  return new WebGPUPlotter(gpu, true, options);
}
