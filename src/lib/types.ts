import type { Gpu } from "vgpu";

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;

export interface PaperConfig {
  readonly name: string;
  readonly widthMm: number;
  readonly heightMm: number;
}

export const PaperSize = {
  A4_PORTRAIT: { name: "A4 Portrait", widthMm: 210, heightMm: 297 },
  A4_LANDSCAPE: { name: "A4 Landscape", widthMm: 297, heightMm: 210 },
  A3_PORTRAIT: { name: "A3 Portrait", widthMm: 297, heightMm: 420 },
  A3_LANDSCAPE: { name: "A3 Landscape", widthMm: 420, heightMm: 297 },
  SQUARE_200: { name: "Square 200x200mm", widthMm: 200, heightMm: 200 },
  LETTER_PORTRAIT: { name: "US Letter Portrait", widthMm: 215.9, heightMm: 279.4 },
} as const satisfies Record<string, PaperConfig>;

export interface LayerSpec {
  readonly id: string;
  readonly name?: string;
  readonly color?: string;
  readonly strokeWidthMm?: number;
}

export interface ScreenVertex {
  readonly xPx: number;
  readonly yPx: number;
  readonly z: number; // positive linear camera-space depth
}

export interface GeneratedHatchSegment {
  readonly x0Px: number;
  readonly y0Px: number;
  readonly z0: number;
  readonly x1Px: number;
  readonly y1Px: number;
  readonly z1: number;
}

export interface ParallelHatchStyle {
  readonly kind: "parallel";
  readonly layer?: string;
  readonly angleDeg?: number;
  readonly spacingMm?: number;
  readonly crossHatch?: boolean;
  readonly crossAngleDeg?: number;
  /** Modulate hatch spacing based on surface normal & light direction */
  readonly shadeByLight?: {
    readonly direction: Vec3;
    readonly minSpacingMm: number;
    readonly maxSpacingMm: number;
    /** Skip hatching on faces brighter than this threshold [0..1] */
    readonly highlightCutoff?: number;
    /** Only apply secondary cross-hatching on faces darker than this threshold [0..1] (default: 0.48) */
    readonly crossHatchThreshold?: number;
  };
  /** Inset hatch lines from polygon/face boundary (mm) */
  readonly insetMm?: number;
}

export interface HatchContext {
  /** Vertices of the polygon in screen coordinates with linear camera depth z */
  readonly screenPoly: ScreenVertex[];
  /** Paper pixel density (pixels per mm) */
  readonly pxPerMm: number;
  /** Surface normal in world space (for 3D lighting modulation) */
  readonly worldNormal: Vec3;
  /** Normalized lighting factor [0..1] if lighting is configured, or undefined */
  readonly lightFactor?: number;
  /** Interpolates perspective-correct camera depth z at any screen (x, y) on this face */
  interpolateZ(xPx: number, yPx: number): number;
  /** Tests if a screen point is inside this polygon */
  containsPoint(xPx: number, yPx: number): boolean;
  /** Clips an arbitrary polyline to the polygon boundary */
  clipPolyline(points: ScreenVertex[]): ScreenVertex[][];
}

export type CustomHatchGenerator = (
  ctx: HatchContext
) => GeneratedHatchSegment[] | ScreenVertex[][];

export interface CustomHatchStyle {
  readonly kind: "custom";
  readonly layer?: string;
  readonly generate: CustomHatchGenerator;
}

export type HatchFillStyle = ParallelHatchStyle | CustomHatchStyle;

export const HatchFill = {
  parallel(opts: Omit<ParallelHatchStyle, "kind"> = {}): ParallelHatchStyle {
    return { kind: "parallel", ...opts };
  },
  crossHatch(opts: Omit<ParallelHatchStyle, "kind" | "crossHatch"> = {}): ParallelHatchStyle {
    return { kind: "parallel", crossHatch: true, ...opts };
  },
  custom(
    generate: CustomHatchGenerator,
    opts: { layer?: string } = {}
  ): CustomHatchStyle {
    return { kind: "custom", generate, layer: opts.layer };
  },
};

export interface StrokeStyle {
  readonly layer?: string;
  /** Draw exterior boundary edges (default: true) */
  readonly outlines?: boolean;
  /** Draw silhouette edges where front/back faces meet (default: true) */
  readonly silhouettes?: boolean;
  /** Draw sharp crease edges where face normals differ by more than creaseAngleDeg (default: 25) */
  readonly creaseAngleDeg?: number;
  /** Draw all wireframe triangle/polygon edges (default: false) */
  readonly wireframe?: boolean;
}

export interface CameraConfig {
  readonly type?: "perspective" | "orthographic";
  readonly position: Vec3;
  readonly target: Vec3;
  readonly up?: Vec3;
  readonly fovDeg?: number;
  readonly orthoHeight?: number;
  readonly near?: number;
  readonly far?: number;
}

export interface PlotterOptions {
  readonly gpu?: Gpu;
  readonly paper?: PaperConfig;
  readonly penWidthMm?: number;
  /** Major dimension of the offscreen WebGPU G-Buffer texture (default: 2048) */
  readonly resolution?: number;
}

export interface PlotExecutionOptions {
  /** Merge visible sub-segments along the same source line separated by less than this gap (mm) */
  readonly mergeGapMm?: number;
  /** Chain connected segments into continuous polylines (default: true) */
  readonly chainPolylines?: boolean;
  /**
   * Connect alternating adjacent hatch lines within this distance (mm) into continuous
   * serpentine / meander paths to eliminate pen-lifts (0 = disabled, default: 0)
   */
  readonly hatchJoinDistanceMm?: number;
  /** Optimize pen-up travel order using Greedy Nearest-Neighbor + 2-Opt TSP (default: true) */
  readonly optimizeTravel?: boolean;
  /** Ramer-Douglas-Peucker simplification tolerance in mm (0 = disabled) */
  readonly simplifyToleranceMm?: number;
  /** Override step size in pixels (default: 0.85) */
  readonly stepSizePx?: number;
  /** Override linear depth bias (default: 0.015) */
  readonly depthBias?: number;
  /** Orthogonal edge neighborhood search radius in pixels (default: 1.25) */
  readonly edgeSearchRadiusPx?: number;
  /** Read back a visualizable RGBA debug preview of the G-Buffer (default: false) */
  readonly captureGBufferPreview?: boolean;
  /** Optional light direction for shading the G-Buffer preview */
  readonly previewLightDirection?: Vec3;
}

export type Polyline2D = Vec2[];

export interface PlotLayerOutput {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly strokeWidthMm: number;
  readonly polylines: Polyline2D[];
  readonly drawLengthMm: number;
  readonly travelLengthMm: number;
}

export interface PlotStats {
  readonly triangleCount: number;
  readonly candidateSegmentCount: number;
  readonly rawVisibleSubSegments: number;
  readonly finalPolylineCount: number;
  readonly finalVertexCount: number;
  readonly totalDrawLengthMm: number;
  readonly unoptimizedTravelLengthMm: number;
  readonly optimizedTravelLengthMm: number;
  readonly travelSavingsPercent: number;
  readonly gpuTimeMs: number;
  readonly postProcessTimeMs: number;
  readonly totalTimeMs: number;
  readonly resolution: [number, number];
}

export interface SVGExportOptions {
  readonly includePenTravel?: boolean;
  /** Custom stroke width for debug pen-up travel lines in mm (default: 0.38) */
  readonly penTravelStrokeWidthMm?: number;
  /** Custom color for debug pen-up travel lines (default: "#ef4444") */
  readonly penTravelColor?: string;
  /** Custom opacity for debug pen-up travel lines [0..1] (default: 0.85) */
  readonly penTravelOpacity?: number;
  readonly includePaperBorder?: boolean;
  readonly marginMm?: number;
  readonly backgroundColor?: string;
  readonly precision?: number;
  /**
   * Combine multiple polylines into a single compound `<path d="M...L... M...L..." />` per layer
   * rather than generating separate `<path>` tags for every stroke (default: true).
   * Reduces DOM node count by up to 99% and dramatically speeds up rendering in browsers & Inkscape.
   */
  readonly combinePathsPerLayer?: boolean;
  /** Optional set of layer IDs to hide when exporting/rendering SVG */
  readonly hiddenLayerIds?: ReadonlySet<string> | readonly string[];
}

export type HatchModeOverride =
  | "default"
  | "parallel"
  | "cross-hatch"
  | "none";

export interface SceneStyleOverrides {
  readonly hatchMode?: HatchModeOverride;
  readonly hatchAngleOffsetDeg?: number;
  readonly highlightCutoff?: number;
  readonly crossHatchThreshold?: number;
  readonly lightDirection?: Vec3;
  readonly creaseAngleDeg?: number;
  readonly drawSilhouettes?: boolean;
  readonly drawOutlines?: boolean;
  readonly drawWireframe?: boolean;
  readonly penWidthMm?: number;
}

export interface PlotResult {
  readonly paper: PaperConfig;
  readonly layers: PlotLayerOutput[];
  readonly stats: PlotStats;
  readonly gbufferPreviewRGBA?: Uint8Array;
  toSVG(options?: SVGExportOptions): string;
}

export const CANDIDATE_FLAGS = {
  NONE: 0,
  CLIP_TO_OBJECT: 1 << 0,
  EDGE_KERNEL: 1 << 2,
  IGNORE_OCCLUSION: 1 << 3,
} as const;

export interface ProjectedTriangle {
  readonly v0Clip: [number, number, number, number];
  readonly v1Clip: [number, number, number, number];
  readonly v2Clip: [number, number, number, number];
  readonly z0: number;
  readonly z1: number;
  readonly z2: number;
  readonly objectId: number;
  readonly faceId: number;
  readonly slope: number;
}

export interface ProjectedCandidateSegment {
  readonly x0Px: number;
  readonly y0Px: number;
  readonly z0: number;
  readonly faceId0: number;
  readonly x1Px: number;
  readonly y1Px: number;
  readonly z1: number;
  readonly faceId1: number;
  readonly objectId: number;
  readonly layerId: number;
  readonly lineId: number;
  readonly flags: number;
}

export interface CompiledSceneData {
  readonly triangles: ProjectedTriangle[];
  readonly candidates: ProjectedCandidateSegment[];
  readonly layers: LayerSpec[];
  readonly viewMatrix?: Mat4;
  readonly lightDirection?: Vec3;
}
