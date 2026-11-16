export {
  decimateMeshLOD,
  parseGLB,
  type LoadGLBOptions,
  type ParsedGLBMesh,
} from "./glb-loader.ts";
export { createPlotter, WebGPUPlotter } from "./plotter.ts";
export {
  PlotterScene2D,
  PlotterScene3D,
  type AddBox3DOptions,
  type AddCircle2DOptions,
  type AddGridMesh3DOptions,
  type AddMesh3DOptions,
  type AddPolygon2DOptions,
  type AddPolyline2DOptions,
  type AddPolyline3DOptions,
  type AddRect2DOptions,
  type AddSphere3DOptions,
  type AnyPlotterScene,
  type MeshFaceInput,
} from "./scene.ts";
export {
  fromThreeScene,
  type ThreeAdapterOptions,
  type ThreeObjectPlotConfig,
} from "./three-adapter.ts";
export {
  chainConnectedPolylines,
  connectMeanderHatchPolylines,
  optimizePenTravelOrder,
  simplifyPolylineRDP,
} from "./optimize.ts";
export {
  clipPolylineToPolygon,
  createPlaneZInterpolator,
  generatePolygonHatchSegments,
  getPolygonScanlineChords,
  pointInPolygon,
  type ScanlineChord,
} from "./hatching.ts";
export {
  CANDIDATE_FLAGS,
  HatchFill,
  PaperSize,
  type CameraConfig,
  type CustomHatchGenerator,
  type CustomHatchStyle,
  type GeneratedHatchSegment,
  type HatchContext,
  type HatchFillStyle,
  type HatchModeOverride,
  type LayerSpec,
  type Mat4,
  type PaperConfig,
  type ParallelHatchStyle,
  type PlotExecutionOptions,
  type PlotLayerOutput,
  type PlotResult,
  type PlotStats,
  type PlotterOptions,
  type Polyline2D,
  type SVGExportOptions,
  type SceneStyleOverrides,
  type ScreenVertex,
  type StrokeStyle,
  type Vec2,
  type Vec3,
} from "./types.ts";
