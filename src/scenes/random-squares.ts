import { HatchFill, PaperSize, PlotterScene2D, type PaperConfig, type Vec2 } from "../lib/index.ts";

export interface RandomSquaresSceneParams {
  readonly paper?: PaperConfig;
  readonly count?: number;
  readonly seed?: number;
  readonly minSizeMm?: number;
  readonly maxSizeMm?: number;
  readonly marginMm?: number;
  readonly hatchRatio?: number;
}

/**
 * Deterministic PRNG (Mulberry32) for reproducible generative art.
 */
function createPrng(seed: number) {
  let s = seed | 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds a 2D performance stress-test scene consisting of 1,000 (configurable) random squares
 * overlaid on top of each other in random positions and orientations.
 *
 * Each square acts as an opaque occluding polygon in the WebGPU G-Buffer, hiding all
 * underlying square outlines and hatch lines behind it in strict painter's depth order.
 */
export function buildRandomSquaresScene2D(params: RandomSquaresSceneParams = {}): PlotterScene2D {
  const paper = params.paper ?? PaperSize.A4_PORTRAIT;
  const count = params.count ?? 1000;
  const seed = params.seed ?? 2026;
  const minSize = params.minSizeMm ?? 10;
  const maxSize = params.maxSizeMm ?? 45;
  const margin = params.marginMm ?? 16;
  const hatchRatio = params.hatchRatio ?? 0.12;

  const rnd = createPrng(seed);
  const scene = new PlotterScene2D();

  // Multi-pen plotter layers
  scene.registerLayer({ id: "ink-black", name: "Primary Black Ink", color: "#18181b", strokeWidthMm: 0.28 });
  scene.registerLayer({ id: "accent-crimson", name: "Crimson Accent", color: "#dc2626", strokeWidthMm: 0.25 });
  scene.registerLayer({ id: "accent-indigo", name: "Indigo Accent", color: "#3b82f6", strokeWidthMm: 0.22 });

  const W = paper.widthMm;
  const H = paper.heightMm;
  const innerW = Math.max(20, W - margin * 2);
  const innerH = Math.max(20, H - margin * 2);

  // Generate 1000 overlapping squares with increasing zIndex
  for (let i = 0; i < count; i++) {
    const t = i / count;
    // Skew size distribution: mostly compact/medium squares with occasional large hero squares
    const size = minSize + Math.pow(rnd(), 1.4) * (maxSize - minSize);
    const half = size * 0.5;

    // Random position within margins
    const cx = margin + half + rnd() * Math.max(0, innerW - size);
    const cy = margin + half + rnd() * Math.max(0, innerH - size);

    // Random rotation: combination of axis-aligned and angled squares
    const rot = rnd() < 0.2 ? 0 : (rnd() - 0.5) * 60;

    // Distribute layers: 75% primary black, 15% crimson, 10% indigo
    const layerRoll = rnd();
    const layer = layerRoll < 0.72 ? "ink-black" : layerRoll < 0.88 ? "accent-crimson" : "accent-indigo";

    // A curated subset of squares receive fine internal parallel hatching
    const hasHatch = rnd() < hatchRatio;
    const hatchAngle = rnd() < 0.5 ? 45 : -45;

    scene.addRect({
      x: cx - half,
      y: cy - half,
      width: size,
      height: size,
      rotationDeg: rot,
      zIndex: i + 1,
      mode: "normal",
      stroke: { layer },
      fill: hasHatch
        ? HatchFill.parallel({
            layer,
            angleDeg: hatchAngle + rot,
            spacingMm: 1.2,
          })
        : undefined,
    });
  }

  // Neat framing border around the plot
  scene.addRect({
    x: margin * 0.75,
    y: margin * 0.75,
    width: W - margin * 1.5,
    height: H - margin * 1.5,
    zIndex: count + 10,
    mode: "transparent",
    stroke: { layer: "ink-black" },
  });

  return scene;
}
