import {
  createPlotter,
  PaperSize,
  parseGLB,
  PlotterScene2D,
  PlotterScene3D,
  type HatchModeOverride,
  type PaperConfig,
  type ParsedGLBMesh,
  type PlotResult,
  type Vec3,
  type WebGPUPlotter,
} from "../lib/index.ts";
import { cross3, normalize3, sub3 } from "../lib/math.ts";
import { buildAlpineMountainsScene2D } from "../scenes/alpine-mountains.ts";
import { buildRandomSquaresScene2D } from "../scenes/random-squares.ts";
import { buildSkullScene, ensureSkullLoaded } from "../scenes/skull-scene.ts";
import { buildThreeAdapterDemoScene } from "../scenes/three-demo.ts";

type ScenePresetId =
  | "alpine-mountains"
  | "random-squares"
  | "three-demo"
  | "skull-glb"
  | "custom-glb";
type ViewMode = "svg" | "split" | "gbuffer";
type PaperSelectionKey = keyof typeof PaperSize | "AUTO_PANEL";
type ViewportZoomMode = "fit" | "fill" | "1:1" | "2x" | "custom";

interface PlaygroundState {
  sceneId: ScenePresetId;
  viewMode: ViewMode;
  paperKey: PaperSelectionKey;
  zoomMode: ViewportZoomMode;
  customZoomScale: number; // Multiplier relative to Fit size
  azimuthDeg: number;
  elevationDeg: number;
  distance: number;
  pan3DX: number;
  pan3DY: number;
  pan2DX: number;
  pan2DY: number;
  zoom2D: number;
  lodPercent: number;
  creaseAngleDeg: number;
  drawSilhouettes: boolean;
  drawOutlines: boolean;
  drawWireframe: boolean;
  hatchMode: HatchModeOverride;
  hatchDensity: number;
  hatchAngleOffsetDeg: number;
  highlightCutoff: number;
  crossHatchThreshold: number;
  lightAzimuthDeg: number;
  lightElevationDeg: number;
  penWidthMm: number;
  hatchJoinDistMm: number;
  simplifyTolMm: number;
  resolution: number;
  optimizeTravel: boolean;
  showTravel: boolean;
  showBorder: boolean;
  hiddenLayers: Set<string>;
}

const state: PlaygroundState = {
  sceneId: "alpine-mountains",
  viewMode: "split",
  paperKey: "A4_PORTRAIT",
  zoomMode: "fit",
  customZoomScale: 1.0,
  azimuthDeg: 28,
  elevationDeg: 24,
  distance: 19.0,
  pan3DX: 0,
  pan3DY: 0,
  pan2DX: 0,
  pan2DY: 0,
  zoom2D: 1.0,
  lodPercent: 100,
  creaseAngleDeg: 22,
  drawSilhouettes: true,
  drawOutlines: true,
  drawWireframe: false,
  hatchMode: "default",
  hatchDensity: 1.0,
  hatchAngleOffsetDeg: 0,
  highlightCutoff: 0.78,
  crossHatchThreshold: 0.48,
  lightAzimuthDeg: 35,
  lightElevationDeg: 48,
  penWidthMm: 0.2,
  hatchJoinDistMm: 0,
  simplifyTolMm: 0.02,
  resolution: 2048,
  optimizeTravel: true,
  showTravel: false,
  showBorder: true,
  hiddenLayers: new Set(),
};

const CSS_PX_PER_MM = 96 / 25.4; // 3.779527559 px/mm at 1:1 physical scale

let plotter: WebGPUPlotter | null = null;
let latestResult: PlotResult | null = null;
let customGlbMeshes: ParsedGLBMesh[] | null = null;
let customGlbName = "Custom GLB";
let renderQueued = false;
let isRendering = false;
let isSyncingScroll = false;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const elSceneRadioList = $<HTMLDivElement>("#scene-radio-list");
const elCustomGlbRadioRow = $<HTMLLabelElement>("#custom-glb-radio-row");
const elCustomGlbRadioLabel = $<HTMLSpanElement>("#custom-glb-radio-label");
const elGlbFileInput = $<HTMLInputElement>("#glb-file-input");
const elViewMode = $<HTMLDivElement>("#view-mode");
const elCamGroup = $<HTMLElement>("#camera-controls");
const elBtnResetCam = $<HTMLButtonElement>("#btn-reset-cam");
const elAzimuth = $<HTMLInputElement>("#cam-azimuth");
const elAzimuthVal = $<HTMLOutputElement>("#cam-azimuth-val");
const elElevation = $<HTMLInputElement>("#cam-elevation");
const elElevationVal = $<HTMLOutputElement>("#cam-elevation-val");
const elDistance = $<HTMLInputElement>("#cam-distance");
const elDistanceVal = $<HTMLOutputElement>("#cam-distance-val");

const elMeshLod = $<HTMLInputElement>("#mesh-lod");
const elMeshLodVal = $<HTMLOutputElement>("#mesh-lod-val");
const elCreaseAngle = $<HTMLInputElement>("#crease-angle");
const elCreaseAngleVal = $<HTMLOutputElement>("#crease-angle-val");
const elEdgeSilhouettes = $<HTMLInputElement>("#edge-silhouettes");
const elEdgeOutlines = $<HTMLInputElement>("#edge-outlines");
const elEdgeWireframe = $<HTMLInputElement>("#edge-wireframe");

const elHatchMode = $<HTMLSelectElement>("#hatch-mode");
const elHatchDensity = $<HTMLInputElement>("#hatch-density");
const elHatchDensityVal = $<HTMLOutputElement>("#hatch-density-val");
const elHatchAngle = $<HTMLInputElement>("#hatch-angle");
const elHatchAngleVal = $<HTMLOutputElement>("#hatch-angle-val");
const elHighlightCutoff = $<HTMLInputElement>("#highlight-cutoff");
const elHighlightCutoffVal = $<HTMLOutputElement>("#highlight-cutoff-val");
const elCrossThreshold = $<HTMLInputElement>("#cross-threshold");
const elCrossThresholdVal = $<HTMLOutputElement>("#cross-threshold-val");
const elLightAzimuth = $<HTMLInputElement>("#light-azimuth");
const elLightAzimuthVal = $<HTMLOutputElement>("#light-azimuth-val");
const elLightElevation = $<HTMLInputElement>("#light-elevation");
const elLightElevationVal = $<HTMLOutputElement>("#light-elevation-val");

const elPaperSize = $<HTMLSelectElement>("#paper-size");
const elPenWidth = $<HTMLInputElement>("#pen-width");
const elPenWidthVal = $<HTMLOutputElement>("#pen-width-val");
const elGbufferRes = $<HTMLSelectElement>("#gbuffer-res");
const elLayerToggles = $<HTMLDivElement>("#layer-toggles");

const elHatchJoinDist = $<HTMLInputElement>("#hatch-join-dist");
const elHatchJoinDistVal = $<HTMLOutputElement>("#hatch-join-dist-val");
const elSimplifyTol = $<HTMLInputElement>("#simplify-tol");
const elSimplifyTolVal = $<HTMLOutputElement>("#simplify-tol-val");
const elOptTravel = $<HTMLInputElement>("#opt-travel");
const elShowTravel = $<HTMLInputElement>("#show-travel");
const elShowBorder = $<HTMLInputElement>("#show-border");
const elBtnDownload = $<HTMLButtonElement>("#btn-download-svg");

const elWorkspace = $<HTMLElement>("#workspace");
const elStageContainer = $<HTMLDivElement>("#stage-container");
const elDropOverlay = $<HTMLDivElement>("#drop-overlay");
const elViewportToolbar = $<HTMLDivElement>("#viewport-toolbar");
const elBtnZoomOut = $<HTMLButtonElement>("#btn-zoom-out");
const elBtnZoomIn = $<HTMLButtonElement>("#btn-zoom-in");
const elZoomReadout = $<HTMLElement>("#zoom-readout");

const elGbufferViewport = $<HTMLDivElement>("#gbuffer-viewport");
const elSvgViewport = $<HTMLDivElement>("#svg-viewport");
const elGbufferScroll = $<HTMLDivElement>("#gbuffer-scroll");
const elSvgScroll = $<HTMLDivElement>("#svg-scroll");
const elSvgCard = $<HTMLDivElement>("#svg-card");
const elGbufferCard = $<HTMLDivElement>("#gbuffer-card");
const elSvgMount = $<HTMLDivElement>("#svg-mount");
const elGbufferCanvas = $<HTMLCanvasElement>("#gbuffer-canvas");

const elStatGpu = $<HTMLElement>("#stat-gpu");
const elStatTotal = $<HTMLElement>("#stat-total");
const elStatPaths = $<HTMLElement>("#stat-paths");
const elStatSavings = $<HTMLElement>("#stat-savings");
const elStatDraw = $<HTMLElement>("#stat-draw");
const elStatTravel = $<HTMLElement>("#stat-travel");

function getSlotDimensionsPx(): { slotW: number; slotH: number } {
  const rect = elStageContainer.getBoundingClientRect();
  const totalW = Math.max(320, rect.width);
  const totalH = Math.max(320, rect.height);
  const isSplit = state.viewMode === "split";
  const gap = isSplit ? 10 : 0;
  const slotW = isSplit ? (totalW - gap) / 2 : totalW;
  const slotH = totalH;
  return { slotW, slotH };
}

function getActivePaperConfig(): PaperConfig {
  if (state.paperKey === "AUTO_PANEL") {
    const { slotW, slotH } = getSlotDimensionsPx();
    const aspect = slotW / Math.max(1, slotH);
    if (aspect >= 1) {
      const hMm = 210;
      const wMm = Math.round(hMm * aspect);
      return { name: "Auto Panel", widthMm: wMm, heightMm: hMm };
    } else {
      const wMm = 210;
      const hMm = Math.round(wMm / aspect);
      return { name: "Auto Panel", widthMm: wMm, heightMm: hMm };
    }
  }
  return PaperSize[state.paperKey];
}

function computeLightDirectionVec3(): Vec3 {
  const az = (state.lightAzimuthDeg * Math.PI) / 180;
  const el = (state.lightElevationDeg * Math.PI) / 180;
  return [
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    Math.cos(el) * Math.cos(az),
  ];
}

function is2DScene(sceneId: ScenePresetId): boolean {
  return sceneId === "alpine-mountains" || sceneId === "random-squares";
}

function applyPresetCameraDefaults(sceneId: ScenePresetId) {
  state.pan3DX = 0;
  state.pan3DY = 0;
  state.pan2DX = 0;
  state.pan2DY = 0;
  state.zoom2D = 1.0;

  if (sceneId === "three-demo") {
    state.azimuthDeg = 28;
    state.elevationDeg = 24;
    state.distance = 19.0;
    state.creaseAngleDeg = 20;
  } else if (sceneId === "skull-glb" || sceneId === "custom-glb") {
    state.azimuthDeg = -28;
    state.elevationDeg = 12;
    state.distance = 22.0;
    state.creaseAngleDeg = 15;
  }

  elCreaseAngle.value = String(state.creaseAngleDeg);
  elCreaseAngleVal.textContent = `${state.creaseAngleDeg}°`;
  syncCameraSlidersUI();
  apply2DTransformUI();
}

function syncCameraSlidersUI() {
  elAzimuth.value = String(Math.round(state.azimuthDeg));
  elAzimuthVal.textContent = `${Math.round(state.azimuthDeg)}°`;
  elElevation.value = String(Math.round(state.elevationDeg));
  elElevationVal.textContent = `${Math.round(state.elevationDeg)}°`;
  elDistance.value = String(state.distance.toFixed(1));
  elDistanceVal.textContent = `${state.distance.toFixed(1)}`;
}

function apply2DTransformUI() {
  if (is2DScene(state.sceneId)) {
    const transform = `translate(${state.pan2DX.toFixed(1)}px, ${state.pan2DY.toFixed(1)}px) scale(${state.zoom2D.toFixed(3)})`;
    elSvgMount.style.transform = transform;
    elGbufferCanvas.style.transform = transform;
  } else {
    elSvgMount.style.transform = "";
    elGbufferCanvas.style.transform = "";
  }
}

/**
 * Computes exact pixel dimensions for the paper cards based on the available workspace
 * and the selected Viewport Zoom mode (`fit`, `fill`, `1:1`, `2x`, or `custom`).
 */
function updateViewportLayoutUI() {
  for (const btn of elViewMode.querySelectorAll("button")) {
    btn.classList.toggle("active", btn.dataset.view === state.viewMode);
  }
  elSvgViewport.classList.toggle("hidden", state.viewMode === "gbuffer");
  elGbufferViewport.classList.toggle("hidden", state.viewMode === "svg");
  elCamGroup.style.opacity = is2DScene(state.sceneId) ? "0.65" : "1.0";

  const paper = getActivePaperConfig();
  const paperAspect = paper.widthMm / paper.heightMm;
  const { slotW, slotH } = getSlotDimensionsPx();

  // 1. Base "Fit" dimensions (uses 100% of slot height or width with no artificial cap)
  const fitH = Math.min(slotH, slotW / paperAspect);
  const fitW = fitH * paperAspect;

  // 2. "Fill Space" dimensions (expands card to cover 100% of slot width AND height)
  const fillH = Math.max(slotH, slotW / paperAspect);
  const fillW = fillH * paperAspect;

  // 3. "1:1 Actual" physical print dimensions on screen (96 DPI = 3.7795 px/mm)
  const oneToOneW = paper.widthMm * CSS_PX_PER_MM;
  const oneToOneH = paper.heightMm * CSS_PX_PER_MM;

  let cardW = fitW;
  let cardH = fitH;

  if (state.zoomMode === "fit") {
    cardW = fitW;
    cardH = fitH;
    state.customZoomScale = 1.0;
  } else if (state.zoomMode === "fill") {
    cardW = fillW;
    cardH = fillH;
    state.customZoomScale = fillW / Math.max(1, fitW);
  } else if (state.zoomMode === "1:1") {
    cardW = oneToOneW;
    cardH = oneToOneH;
    state.customZoomScale = oneToOneW / Math.max(1, fitW);
  } else if (state.zoomMode === "2x") {
    cardW = fitW * 2.0;
    cardH = fitH * 2.0;
    state.customZoomScale = 2.0;
  } else {
    cardW = fitW * state.customZoomScale;
    cardH = fitH * state.customZoomScale;
  }

  const wPx = `${Math.round(cardW)}px`;
  const hPx = `${Math.round(cardH)}px`;
  elSvgCard.style.width = wPx;
  elSvgCard.style.height = hPx;
  elGbufferCard.style.width = wPx;
  elGbufferCard.style.height = hPx;

  // Update toolbar active button & percentage readout
  for (const btn of elViewportToolbar.querySelectorAll<HTMLButtonElement>(".zoom-preset-btn")) {
    btn.classList.toggle("active", btn.dataset.zoomMode === state.zoomMode);
  }

  // Show percentage relative to 1:1 physical size when in 1:1 mode, or relative to Fit
  const pct =
    state.zoomMode === "1:1"
      ? 100
      : Math.round((cardW / Math.max(1, fitW)) * 100);
  elZoomReadout.textContent = `${pct}%`;
}

function updateLayerTogglesUI(result: PlotResult) {
  elLayerToggles.innerHTML = "";
  for (const layer of result.layers) {
    const isVisible = !state.hiddenLayers.has(layer.id);
    const row = document.createElement("div");
    row.className = "layer-item";
    row.innerHTML = `
      <label>
        <input type="checkbox" data-layer-id="${layer.id}" ${isVisible ? "checked" : ""} />
        <span class="layer-swatch" style="background:${layer.color}"></span>
        <span>${layer.name}</span>
      </label>
      <span class="layer-count">${layer.polylines.length} paths</span>
    `;
    const checkbox = row.querySelector("input")!;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        state.hiddenLayers.delete(layer.id);
      } else {
        state.hiddenLayers.add(layer.id);
      }
      refreshSvgMountOnly();
    });
    elLayerToggles.appendChild(row);
  }
}

function refreshSvgMountOnly() {
  if (!latestResult) return;
  const svgText = latestResult.toSVG({
    includePenTravel: state.showTravel,
    includePaperBorder: state.showBorder,
    backgroundColor: "#faf8f5",
    hiddenLayerIds: state.hiddenLayers,
  });
  elSvgMount.innerHTML = svgText;
}

async function buildActiveScene(paper: PaperConfig) {
  const lodRatio = state.lodPercent / 100;
  let scene: PlotterScene3D | PlotterScene2D;

  switch (state.sceneId) {
    case "alpine-mountains":
      scene = buildAlpineMountainsScene2D({
        paper,
        detailLevel: Math.max(25, Math.round(145 * lodRatio)),
        hatchDensityScale: state.hatchDensity,
      });
      break;
    case "random-squares":
      scene = buildRandomSquaresScene2D({
        paper,
        count: Math.max(100, Math.round(1000 * lodRatio)),
        hatchRatio: 0.12 * state.hatchDensity,
      });
      break;
    case "three-demo":
      scene = buildThreeAdapterDemoScene({
        cameraAzimuthDeg: state.azimuthDeg,
        cameraElevationDeg: state.elevationDeg,
        cameraDistance: state.distance,
        hatchDensityScale: state.hatchDensity,
        lodRatio,
      });
      break;
    case "skull-glb": {
      const skullMeshes = await ensureSkullLoaded();
      scene = buildSkullScene(skullMeshes, {
        cameraAzimuthDeg: state.azimuthDeg,
        cameraElevationDeg: state.elevationDeg,
        cameraDistance: state.distance,
        hatchDensityScale: state.hatchDensity,
        lodRatio,
      });
      break;
    }
    case "custom-glb": {
      const meshes = customGlbMeshes ?? (await ensureSkullLoaded());
      scene = buildSkullScene(meshes, {
        cameraAzimuthDeg: state.azimuthDeg,
        cameraElevationDeg: state.elevationDeg,
        cameraDistance: state.distance,
        hatchDensityScale: state.hatchDensity,
        lodRatio,
      });
      break;
    }
  }

  // Apply 3D camera screen-space pan offset along camera Right and Up axes
  if (scene instanceof PlotterScene3D && (state.pan3DX !== 0 || state.pan3DY !== 0)) {
    const cam = scene.getCamera();
    const forward = normalize3(sub3(cam.target, cam.position));
    const right = normalize3(cross3(forward, cam.up ?? [0, 1, 0]));
    const up = normalize3(cross3(right, forward));

    const offset: Vec3 = [
      -state.pan3DX * right[0] + state.pan3DY * up[0],
      -state.pan3DX * right[1] + state.pan3DY * up[1],
      -state.pan3DX * right[2] + state.pan3DY * up[2],
    ];

    scene.setCamera({
      position: [
        cam.position[0] + offset[0],
        cam.position[1] + offset[1],
        cam.position[2] + offset[2],
      ],
      target: [
        cam.target[0] + offset[0],
        cam.target[1] + offset[1],
        cam.target[2] + offset[2],
      ],
    });
  }

  // Apply universal UI style overrides (hatch mode, angle, lighting, creases, pen nib width)
  scene.applyOverrides({
    hatchMode: state.hatchMode,
    hatchAngleOffsetDeg: state.hatchAngleOffsetDeg,
    highlightCutoff: state.highlightCutoff,
    crossHatchThreshold: state.crossHatchThreshold,
    lightDirection: computeLightDirectionVec3(),
    creaseAngleDeg: state.creaseAngleDeg,
    drawSilhouettes: state.drawSilhouettes,
    drawOutlines: state.drawOutlines,
    drawWireframe: state.drawWireframe,
    penWidthMm: state.penWidthMm,
  });

  return scene;
}

async function renderPlot() {
  if (!plotter) return;
  if (isRendering) {
    renderQueued = true;
    return;
  }
  isRendering = true;

  try {
    const paper = getActivePaperConfig();
    plotter.setPaper(paper, state.resolution);
    const scene = await buildActiveScene(paper);
    const needGbufferPreview = state.viewMode === "gbuffer" || state.viewMode === "split";

    const result = await plotter.plot(scene, {
      optimizeTravel: state.optimizeTravel,
      simplifyToleranceMm: state.simplifyTolMm,
      hatchJoinDistanceMm: state.hatchJoinDistMm,
      captureGBufferPreview: needGbufferPreview,
      previewLightDirection: computeLightDirectionVec3(),
    });

    latestResult = result;
    refreshSvgMountOnly();
    updateLayerTogglesUI(result);

    if (result.gbufferPreviewRGBA) {
      const [w, h] = result.stats.resolution;
      elGbufferCanvas.width = w;
      elGbufferCanvas.height = h;
      const ctx = elGbufferCanvas.getContext("2d")!;
      const imgData = new ImageData(
        new Uint8ClampedArray(result.gbufferPreviewRGBA.buffer as ArrayBuffer),
        w,
        h
      );
      ctx.putImageData(imgData, 0, 0);
    }

    const s = result.stats;
    elStatGpu.textContent = `${s.gpuTimeMs.toFixed(1)} ms`;
    elStatTotal.textContent = `${s.totalTimeMs.toFixed(1)} ms`;
    elStatPaths.textContent = `${s.finalPolylineCount.toLocaleString()}`;
    elStatSavings.textContent = `${s.travelSavingsPercent.toFixed(1)}%`;
    elStatDraw.textContent = `${(s.totalDrawLengthMm / 1000).toFixed(2)} m`;
    elStatTravel.textContent = `${(s.optimizedTravelLengthMm / 1000).toFixed(2)} m`;
  } finally {
    isRendering = false;
    if (renderQueued) {
      renderQueued = false;
      void renderPlot();
    }
  }
}

async function loadCustomGlbFile(file: File) {
  const buf = await file.arrayBuffer();
  customGlbMeshes = parseGLB(buf, { center: true, normalizeSize: 10.5 });
  customGlbName = file.name.replace(/\.glb$/i, "");

  elCustomGlbRadioRow.classList.remove("hidden");
  elCustomGlbRadioLabel.textContent = `Custom GLB (${customGlbName})`;
  const radio = elCustomGlbRadioRow.querySelector<HTMLInputElement>("input");
  if (radio) radio.checked = true;

  state.sceneId = "custom-glb";
  state.hiddenLayers.clear();
  applyPresetCameraDefaults("custom-glb");
  updateViewportLayoutUI();
  void renderPlot();
}

function wireEvents() {
  // Synchronize scrollbars between Source G-Buffer and Output SVG panels when zoomed in
  const syncScroll = (source: HTMLElement, target: HTMLElement) => {
    if (isSyncingScroll) return;
    isSyncingScroll = true;
    target.scrollLeft = source.scrollLeft;
    target.scrollTop = source.scrollTop;
    requestAnimationFrame(() => {
      isSyncingScroll = false;
    });
  };

  elGbufferScroll.addEventListener("scroll", () => syncScroll(elGbufferScroll, elSvgScroll));
  elSvgScroll.addEventListener("scroll", () => syncScroll(elSvgScroll, elGbufferScroll));

  // Automatically resize cards to use full workspace whenever window or panels resize
  const resizeObserver = new ResizeObserver(() => {
    updateViewportLayoutUI();
    if (state.paperKey === "AUTO_PANEL") {
      void renderPlot();
    }
  });
  resizeObserver.observe(elStageContainer);

  // Viewport Zoom Toolbar buttons
  elViewportToolbar.addEventListener("click", (e) => {
    const presetBtn = (e.target as HTMLElement).closest<HTMLButtonElement>(".zoom-preset-btn");
    if (presetBtn && presetBtn.dataset.zoomMode) {
      state.zoomMode = presetBtn.dataset.zoomMode as ViewportZoomMode;
      updateViewportLayoutUI();
    }
  });

  elBtnZoomIn.addEventListener("click", () => {
    state.zoomMode = "custom";
    state.customZoomScale = Math.min(4.0, state.customZoomScale * 1.25);
    updateViewportLayoutUI();
  });

  elBtnZoomOut.addEventListener("click", () => {
    state.zoomMode = "custom";
    state.customZoomScale = Math.max(0.4, state.customZoomScale / 1.25);
    updateViewportLayoutUI();
  });

  elSceneRadioList.addEventListener("change", (e) => {
    const target = e.target as HTMLInputElement;
    if (target && target.name === "scene-preset" && target.checked) {
      state.sceneId = target.value as ScenePresetId;
      state.hiddenLayers.clear();
      applyPresetCameraDefaults(state.sceneId);
      updateViewportLayoutUI();
      void renderPlot();
    }
  });

  elGlbFileInput.addEventListener("change", () => {
    const file = elGlbFileInput.files?.[0];
    if (file) {
      void loadCustomGlbFile(file);
    }
  });

  // Drag & Drop .glb anywhere on the workspace with counter-based dragleave handling
  let dragCounter = 0;
  elWorkspace.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragCounter++;
    elDropOverlay.classList.remove("hidden");
  });
  elWorkspace.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  elWorkspace.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      elDropOverlay.classList.add("hidden");
    }
  });
  elWorkspace.addEventListener("drop", (e) => {
    e.preventDefault();
    dragCounter = 0;
    elDropOverlay.classList.add("hidden");
    const file = e.dataTransfer?.files?.[0];
    if (file && file.name.toLowerCase().endsWith(".glb")) {
      void loadCustomGlbFile(file);
    }
  });

  elBtnResetCam.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    applyPresetCameraDefaults(state.sceneId);
    void renderPlot();
  });

  elViewMode.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button");
    if (!btn || !btn.dataset.view) return;
    state.viewMode = btn.dataset.view as ViewMode;
    updateViewportLayoutUI();
    void renderPlot();
  });

  elAzimuth.addEventListener("input", () => {
    state.azimuthDeg = Number(elAzimuth.value);
    elAzimuthVal.textContent = `${state.azimuthDeg}°`;
    void renderPlot();
  });

  elElevation.addEventListener("input", () => {
    state.elevationDeg = Number(elElevation.value);
    elElevationVal.textContent = `${state.elevationDeg}°`;
    void renderPlot();
  });

  elDistance.addEventListener("input", () => {
    state.distance = Number(elDistance.value);
    elDistanceVal.textContent = `${state.distance.toFixed(1)}`;
    void renderPlot();
  });

  // Section 2: Edges & LOD
  elMeshLod.addEventListener("input", () => {
    state.lodPercent = Number(elMeshLod.value);
    elMeshLodVal.textContent = `${state.lodPercent}%`;
    void renderPlot();
  });

  elCreaseAngle.addEventListener("input", () => {
    state.creaseAngleDeg = Number(elCreaseAngle.value);
    elCreaseAngleVal.textContent = `${state.creaseAngleDeg}°`;
    void renderPlot();
  });

  elEdgeSilhouettes.addEventListener("change", () => {
    state.drawSilhouettes = elEdgeSilhouettes.checked;
    void renderPlot();
  });

  elEdgeOutlines.addEventListener("change", () => {
    state.drawOutlines = elEdgeOutlines.checked;
    void renderPlot();
  });

  elEdgeWireframe.addEventListener("change", () => {
    state.drawWireframe = elEdgeWireframe.checked;
    void renderPlot();
  });

  // Section 3: Hatching & Lighting
  elHatchMode.addEventListener("change", () => {
    state.hatchMode = elHatchMode.value as HatchModeOverride;
    void renderPlot();
  });

  elHatchDensity.addEventListener("input", () => {
    state.hatchDensity = Number(elHatchDensity.value);
    elHatchDensityVal.textContent = `${state.hatchDensity.toFixed(1)}×`;
    void renderPlot();
  });

  elHatchAngle.addEventListener("input", () => {
    state.hatchAngleOffsetDeg = Number(elHatchAngle.value);
    elHatchAngleVal.textContent = `${state.hatchAngleOffsetDeg}°`;
    void renderPlot();
  });

  elHighlightCutoff.addEventListener("input", () => {
    state.highlightCutoff = Number(elHighlightCutoff.value);
    elHighlightCutoffVal.textContent = state.highlightCutoff.toFixed(2);
    void renderPlot();
  });

  elCrossThreshold.addEventListener("input", () => {
    state.crossHatchThreshold = Number(elCrossThreshold.value);
    elCrossThresholdVal.textContent = state.crossHatchThreshold.toFixed(2);
    void renderPlot();
  });

  elLightAzimuth.addEventListener("input", () => {
    state.lightAzimuthDeg = Number(elLightAzimuth.value);
    elLightAzimuthVal.textContent = `${state.lightAzimuthDeg}°`;
    void renderPlot();
  });

  elLightElevation.addEventListener("input", () => {
    state.lightElevationDeg = Number(elLightElevation.value);
    elLightElevationVal.textContent = `${state.lightElevationDeg}°`;
    void renderPlot();
  });

  // Section 4: Pen, Paper & Layers
  elPaperSize.addEventListener("change", () => {
    state.paperKey = elPaperSize.value as PaperSelectionKey;
    updateViewportLayoutUI();
    void renderPlot();
  });

  elPenWidth.addEventListener("input", () => {
    state.penWidthMm = Number(elPenWidth.value);
    elPenWidthVal.textContent = `${state.penWidthMm.toFixed(2)}mm`;
    void renderPlot();
  });

  elGbufferRes.addEventListener("change", () => {
    state.resolution = Number(elGbufferRes.value);
    void renderPlot();
  });

  // Section 5: Path Optimization & Guides
  elHatchJoinDist.addEventListener("input", () => {
    state.hatchJoinDistMm = Number(elHatchJoinDist.value);
    elHatchJoinDistVal.textContent =
      state.hatchJoinDistMm === 0 ? "Off" : `${state.hatchJoinDistMm.toFixed(1)}mm`;
    void renderPlot();
  });

  elSimplifyTol.addEventListener("input", () => {
    state.simplifyTolMm = Number(elSimplifyTol.value);
    elSimplifyTolVal.textContent = `${state.simplifyTolMm.toFixed(2)}mm`;
    void renderPlot();
  });

  elOptTravel.addEventListener("change", () => {
    state.optimizeTravel = elOptTravel.checked;
    void renderPlot();
  });

  elShowTravel.addEventListener("change", () => {
    state.showTravel = elShowTravel.checked;
    refreshSvgMountOnly();
  });

  elShowBorder.addEventListener("change", () => {
    state.showBorder = elShowBorder.checked;
    refreshSvgMountOnly();
  });

  // Interactive Mouse Controls:
  // - Left Mouse Button Drag: Orbit (Azimuth / Elevation)
  // - Right Mouse Button Drag (or Shift+Left): Pan 3D Camera Target / 2D Canvas
  // - Middle Mouse Drag (or Alt+Left): Scroll/Pan zoomed paper viewport
  // - Scroll Wheel: Zoom 3D Camera Distance (or Ctrl/Cmd + Scroll to zoom Paper Viewport)
  let dragMode: "none" | "orbit" | "pan" | "scroll-view" = "none";
  let lastX = 0;
  let lastY = 0;

  elStageContainer.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  });

  elStageContainer.addEventListener("pointerdown", (e) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      dragMode = "scroll-view";
    } else if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
      dragMode = "pan";
    } else if (e.button === 0) {
      dragMode = is2DScene(state.sceneId) ? "pan" : "orbit";
    } else {
      return;
    }

    lastX = e.clientX;
    lastY = e.clientY;
    elStageContainer.setPointerCapture(e.pointerId);
  });

  elStageContainer.addEventListener("pointermove", (e) => {
    if (dragMode === "none") return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;

    if (dragMode === "scroll-view") {
      elGbufferScroll.scrollLeft -= dx;
      elGbufferScroll.scrollTop -= dy;
      elSvgScroll.scrollLeft -= dx;
      elSvgScroll.scrollTop -= dy;
    } else if (dragMode === "orbit") {
      state.azimuthDeg = ((state.azimuthDeg - dx * 0.45 + 540) % 360) - 180;
      state.elevationDeg = Math.max(-60, Math.min(75, state.elevationDeg + dy * 0.45));
      syncCameraSlidersUI();
      void renderPlot();
    } else if (dragMode === "pan") {
      if (is2DScene(state.sceneId)) {
        state.pan2DX += dx;
        state.pan2DY += dy;
        apply2DTransformUI();
      } else {
        const panSpeed = state.distance * 0.0012;
        state.pan3DX += dx * panSpeed;
        state.pan3DY += dy * panSpeed;
        void renderPlot();
      }
    }
  });

  const endDrag = () => {
    dragMode = "none";
  };
  elStageContainer.addEventListener("pointerup", endDrag);
  elStageContainer.addEventListener("pointercancel", endDrag);

  elStageContainer.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      // Ctrl/Cmd + Scroll zooms the paper viewport display itself
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * 0.002);
        state.zoomMode = "custom";
        state.customZoomScale = Math.max(0.4, Math.min(4.0, state.customZoomScale * factor));
        updateViewportLayoutUI();
        return;
      }

      if (is2DScene(state.sceneId)) {
        const zoomFactor = Math.exp(-e.deltaY * 0.0015);
        state.zoom2D = Math.max(0.5, Math.min(4.0, state.zoom2D * zoomFactor));
        apply2DTransformUI();
      } else {
        const zoomFactor = Math.exp(e.deltaY * 0.0012);
        state.distance = Math.max(4.0, Math.min(45.0, state.distance * zoomFactor));
        syncCameraSlidersUI();
        void renderPlot();
      }
    },
    { passive: false }
  );

  elBtnDownload.addEventListener("click", () => {
    if (!latestResult) return;
    const svg = latestResult.toSVG({
      includePenTravel: false,
      includePaperBorder: false,
      hiddenLayerIds: state.hiddenLayers,
    });
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `plot-${state.sceneId}-${state.paperKey.toLowerCase()}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });
}

async function boot() {
  updateViewportLayoutUI();
  wireEvents();
  plotter = await createPlotter({
    paper: getActivePaperConfig(),
    penWidthMm: state.penWidthMm,
    resolution: state.resolution,
  });
  await renderPlot();
}

boot().catch((err) => {
  console.error("Failed to initialize Plotter Studio:", err);
  elSvgMount.innerHTML = `<div style="padding: 24px; color: #b91c1c; font-size: 14px;">WebGPU initialization error: ${String(err)}</div>`;
});
