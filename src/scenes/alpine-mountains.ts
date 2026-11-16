import { HatchFill, PaperSize, PlotterScene2D, type PaperConfig, type Vec2 } from "../lib/index.ts";

export interface AlpineMountainsSceneParams {
  readonly paper?: PaperConfig;
  readonly detailLevel?: number;
  readonly seed?: number;
  readonly hatchDensityScale?: number;
}

/**
 * Pure 2D Scene: "Alpine Mountain Range & Tarn"
 * Demonstrates 2D hidden-line removal, painter's order occlusion, faceted ridge arêtes,
 * positive clip masks (`clipToObjectId`), and negative border erase masks (`mode: "erase"`):
 *  - High-altitude stratified sky & rising alpenglow sun with clipped solar rings
 *  - 4 overlapping tectonic mountain ranges where each peak splits along a craggy
 *    descending arête into a densely hatched Western Shadow Facet and an airy Eastern Sunlit Facet
 *  - Serene alpine lake at the valley floor with horizontal water reflections
 *  - Foreground rocky promontories and layered alpine pine trees occluding the valley behind them
 */
export function buildAlpineMountainsScene2D(params: AlpineMountainsSceneParams = {}): PlotterScene2D {
  const paper = params.paper ?? PaperSize.A4_PORTRAIT;
  const W = paper.widthMm;
  const H = paper.heightMm;
  const detailScale = Math.max(0.35, Math.min(1.5, (params.detailLevel ?? 140) / 140));
  const density = params.hatchDensityScale ?? 1.0;

  let rngState = (params.seed ?? 2026) >>> 0;
  const rand = () => {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return rngState / 0xffffffff;
  };

  const scene = new PlotterScene2D();
  scene.registerLayer({
    id: "alpine-ink",
    name: "01-Alpine-Ridges-Black",
    color: "#141413",
    strokeWidthMm: 0.22,
  });
  scene.registerLayer({
    id: "shadow-cobalt",
    name: "02-Glacial-Shadow-Cobalt",
    color: "#1e3a8a",
    strokeWidthMm: 0.16,
  });
  scene.registerLayer({
    id: "alpenglow-rust",
    name: "03-Alpenglow-Sun-Rust",
    color: "#c2410c",
    strokeWidthMm: 0.16,
  });

  const margin = Math.round(Math.min(W, H) * 0.075);
  const innerW = W - margin * 2;
  const innerH = H - margin * 2;

  // ---------------------------------------------------------------------------
  // 1. High-Altitude Sky Bands & Rising Alpenglow Sun (zIndex = 1..6)
  // ---------------------------------------------------------------------------
  scene.addRect({
    x: margin,
    y: margin,
    width: innerW,
    height: innerH * 0.56,
    zIndex: 1,
    mode: "normal",
    stroke: false,
    fill: HatchFill.parallel({
      layer: "shadow-cobalt",
      angleDeg: 0,
      spacingMm: 2.6 / density,
    }),
  });

  // Rising Sun Disc behind the main mountain saddle
  const sunCx = margin + innerW * 0.62;
  const sunCy = margin + innerH * 0.26;
  const sunR = Math.min(innerW, innerH) * 0.21;

  const sunMaskId = scene.addCircle({
    cx: sunCx,
    cy: sunCy,
    radius: sunR,
    segments: 84,
    zIndex: 3,
    mode: "normal",
    stroke: { layer: "alpenglow-rust" },
    fill: HatchFill.parallel({
      layer: "alpenglow-rust",
      angleDeg: 0,
      spacingMm: 0.85 / density,
    }),
  });

  // Positive clip mask inside the Sun: offset inner solar corona arcs
  for (let r = 6; r < sunR * 1.45; r += 5.2 / density) {
    scene.addCircle({
      cx: sunCx - sunR * 0.28,
      cy: sunCy + sunR * 0.18,
      radius: r,
      segments: 64,
      zIndex: 4,
      mode: "transparent",
      stroke: { layer: "alpenglow-rust" },
      clipToObjectId: sunMaskId,
    });
  }

  // ---------------------------------------------------------------------------
  // 2. Multi-Tier Faceted Alpine Mountain Ranges (zIndex = 10..50)
  // ---------------------------------------------------------------------------
  interface PeakNode {
    readonly x: number;
    readonly y: number;
    readonly isPeak: boolean; // true = summit, false = saddle/col
  }

  interface MountainRangeSpec {
    readonly zBase: number;
    readonly baseY: number;
    readonly nodes: { u: number; hNorm: number; isPeak: boolean }[];
    readonly shadowSpacingMm: number;
    readonly shadowCrossHatch: boolean;
    readonly shadowAngleDeg: number;
    readonly sunlitSpacingMm: number | null;
    readonly sunlitAngleDeg: number;
    readonly sunlitLayer: string;
    readonly cragRoughness: number;
    readonly areteDriftX: number;
  }

  const ranges: MountainRangeSpec[] = [
    // Tier 1: Distant High Alps (Matterhorn-inspired twin spires)
    {
      zBase: 10,
      baseY: margin + innerH * 0.62,
      nodes: [
        { u: 0.0, hNorm: 0.36, isPeak: false },
        { u: 0.14, hNorm: 0.21, isPeak: true },
        { u: 0.26, hNorm: 0.33, isPeak: false },
        { u: 0.41, hNorm: 0.13, isPeak: true }, // Main high spire
        { u: 0.57, hNorm: 0.34, isPeak: false }, // Saddle below sun
        { u: 0.74, hNorm: 0.17, isPeak: true },
        { u: 0.87, hNorm: 0.29, isPeak: false },
        { u: 0.96, hNorm: 0.22, isPeak: true },
        { u: 1.0, hNorm: 0.31, isPeak: false },
      ],
      shadowSpacingMm: 0.62,
      shadowCrossHatch: true,
      shadowAngleDeg: -48,
      sunlitSpacingMm: 1.85,
      sunlitAngleDeg: 32,
      sunlitLayer: "alpenglow-rust",
      cragRoughness: 3.4,
      areteDriftX: 10,
    },
    // Tier 2: Mid-Far Glacial Massif
    {
      zBase: 22,
      baseY: margin + innerH * 0.69,
      nodes: [
        { u: 0.0, hNorm: 0.44, isPeak: false },
        { u: 0.09, hNorm: 0.31, isPeak: true },
        { u: 0.22, hNorm: 0.43, isPeak: false },
        { u: 0.33, hNorm: 0.26, isPeak: true },
        { u: 0.49, hNorm: 0.45, isPeak: false },
        { u: 0.65, hNorm: 0.28, isPeak: true },
        { u: 0.79, hNorm: 0.42, isPeak: false },
        { u: 0.89, hNorm: 0.30, isPeak: true },
        { u: 1.0, hNorm: 0.43, isPeak: false },
      ],
      shadowSpacingMm: 0.7,
      shadowCrossHatch: true,
      shadowAngleDeg: -42,
      sunlitSpacingMm: 2.1,
      sunlitAngleDeg: 28,
      sunlitLayer: "alpenglow-rust",
      cragRoughness: 3.0,
      areteDriftX: -12,
    },
    // Tier 3: Midground Sweeping Crags framing the central valley
    {
      zBase: 34,
      baseY: margin + innerH * 0.75,
      nodes: [
        { u: 0.0, hNorm: 0.43, isPeak: true },
        { u: 0.13, hNorm: 0.53, isPeak: false },
        { u: 0.25, hNorm: 0.38, isPeak: true },
        { u: 0.44, hNorm: 0.59, isPeak: false }, // Deep glacial valley floor
        { u: 0.58, hNorm: 0.42, isPeak: true },
        { u: 0.72, hNorm: 0.55, isPeak: false },
        { u: 0.84, hNorm: 0.37, isPeak: true },
        { u: 1.0, hNorm: 0.52, isPeak: false },
      ],
      shadowSpacingMm: 0.78,
      shadowCrossHatch: false,
      shadowAngleDeg: -52,
      sunlitSpacingMm: 1.9,
      sunlitAngleDeg: 36,
      sunlitLayer: "shadow-cobalt",
      cragRoughness: 2.6,
      areteDriftX: 14,
    },
    // Tier 4: Lower Valley Ridges descending into the Alpine Tarn
    {
      zBase: 46,
      baseY: margin + innerH * 0.78,
      nodes: [
        { u: 0.0, hNorm: 0.60, isPeak: false },
        { u: 0.16, hNorm: 0.49, isPeak: true },
        { u: 0.36, hNorm: 0.66, isPeak: false },
        { u: 0.51, hNorm: 0.54, isPeak: true },
        { u: 0.67, hNorm: 0.67, isPeak: false },
        { u: 0.82, hNorm: 0.50, isPeak: true },
        { u: 1.0, hNorm: 0.63, isPeak: false },
      ],
      shadowSpacingMm: 0.85,
      shadowCrossHatch: false,
      shadowAngleDeg: -38,
      sunlitSpacingMm: 2.3,
      sunlitAngleDeg: 25,
      sunlitLayer: "alpenglow-rust",
      cragRoughness: 2.1,
      areteDriftX: -9,
    },
  ];

  // Helper to subdivide a ridge segment between two nodes with craggy midpoint displacement
  const buildCraggySegment = (
    pA: Vec2,
    pB: Vec2,
    roughness: number,
    steps: number
  ): Vec2[] => {
    const pts: Vec2[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = pA[0] + (pB[0] - pA[0]) * t;
      // Envelope is 0 at endpoints so peaks and saddles stay exact
      const env = Math.sin(t * Math.PI);
      const jitter =
        (Math.sin(t * Math.PI * 5.0 + pA[0] * 0.17) * 0.6 +
          (rand() - 0.5) * 0.8) *
        roughness *
        env;
      const y = pA[1] + (pB[1] - pA[1]) * t + jitter;
      pts.push([x, y]);
    }
    return pts;
  };

  for (const tier of ranges) {
    const keyNodes: PeakNode[] = tier.nodes.map((n) => ({
      x: margin + n.u * innerW,
      y: margin + n.hNorm * innerH,
      isPeak: n.isPeak,
    }));

    // Generate descending ridge spine (arête) from every node down to tier.baseY
    const nodeSpines: Vec2[][] = keyNodes.map((node, idx) => {
      const drift =
        node.isPeak
          ? tier.areteDriftX * (idx % 2 === 0 ? 1 : -0.8)
          : tier.areteDriftX * 0.35;
      const endX = Math.max(margin, Math.min(W - margin, node.x + drift));
      const spineSteps = Math.max(5, Math.round(10 * detailScale));
      const spine: Vec2[] = [];
      for (let s = 0; s <= spineSteps; s++) {
        const t = s / spineSteps;
        const env = Math.sin(t * Math.PI);
        const lateralWiggle =
          Math.sin(t * Math.PI * 3.0 + idx * 1.9) * (tier.cragRoughness * 1.6) * env;
        const sx = node.x + (endX - node.x) * t + lateralWiggle;
        const sy = node.y + (tier.baseY - node.y) * t;
        spine.push([sx, sy]);
      }
      return spine;
    });

    // Each span between keyNodes[i] and keyNodes[i+1] forms a mountain facet:
    // - If keyNodes[i+1].y < keyNodes[i].y (climbing up to a peak from left to right),
    //   it is a Left (Western Shadow) facet!
    // - If keyNodes[i+1].y > keyNodes[i].y (descending from a peak to the right),
    //   it is a Right (Eastern Sunlit) facet!
    const segSteps = Math.max(6, Math.round(14 * detailScale));

    for (let i = 0; i < keyNodes.length - 1; i++) {
      const n0 = keyNodes[i];
      const n1 = keyNodes[i + 1];
      const isShadowFacet = n1.y < n0.y;

      const topEdge = buildCraggySegment(
        [n0.x, n0.y],
        [n1.x, n1.y],
        tier.cragRoughness,
        segSteps
      );
      const rightSpine = nodeSpines[i + 1];
      const leftSpine = nodeSpines[i].slice().reverse();

      const facetPoly: Vec2[] = [
        ...topEdge,
        ...rightSpine.slice(1),
        ...leftSpine.slice(0, leftSpine.length - 1),
      ];

      // 1. Add the opaque mountain facet polygon to the G-Buffer (without full perimeter stroke
      //    so the flat bottom baseY edge is never drawn)
      const facetObjId = scene.addPolygon({
        points: facetPoly,
        zIndex: tier.zBase + (isShadowFacet ? 0.2 : 0.1),
        mode: "normal",
        stroke: false,
        fill: isShadowFacet
          ? tier.shadowCrossHatch
            ? HatchFill.crossHatch({
                layer: "shadow-cobalt",
                angleDeg: tier.shadowAngleDeg,
                crossAngleDeg: tier.shadowAngleDeg + 75,
                spacingMm: tier.shadowSpacingMm / density,
                insetMm: 0.12,
              })
            : HatchFill.parallel({
                layer: "shadow-cobalt",
                angleDeg: tier.shadowAngleDeg,
                spacingMm: tier.shadowSpacingMm / density,
                insetMm: 0.12,
              })
          : tier.sunlitSpacingMm !== null
            ? HatchFill.parallel({
                layer: tier.sunlitLayer,
                angleDeg: tier.sunlitAngleDeg,
                spacingMm: tier.sunlitSpacingMm / density,
                insetMm: 0.15,
              })
            : undefined,
      });

      // 2. Draw crisp skyline ridge stroke along topEdge
      scene.addPolyline({
        points: topEdge,
        zIndex: tier.zBase + 0.5,
        layer: "alpine-ink",
      });

      // 3. Draw the primary descending arête line from the peak
      if (n1.isPeak) {
        scene.addPolyline({
          points: rightSpine.slice(0, Math.max(3, Math.floor(rightSpine.length * 0.88))),
          zIndex: tier.zBase + 0.5,
          layer: "alpine-ink",
        });
      }

      // 4. Add geological rock strata / secondary couloir ridges clipped strictly inside the facet
      const strataCount = Math.max(2, Math.round(5 * detailScale));
      for (let s = 1; s <= strataCount; s++) {
        const frac = s / (strataCount + 1);
        const yLeft = n0.y + (tier.baseY - n0.y) * frac * 0.75;
        const yRight = n1.y + (tier.baseY - n1.y) * frac * 0.75;
        const strataPts = buildCraggySegment(
          [n0.x - 10, yLeft],
          [n1.x + 10, yRight],
          tier.cragRoughness * 0.7,
          8
        );
        scene.addPolyline({
          points: strataPts,
          zIndex: tier.zBase + 0.35,
          layer: isShadowFacet ? "alpine-ink" : tier.sunlitLayer,
          clipToObjectId: facetObjId,
        });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Serene Alpine Tarn / Glacial Lake in the Valley (zIndex = 58..62)
  // ---------------------------------------------------------------------------
  const lakeTopY = margin + innerH * 0.725;
  const lakeBottomY = margin + innerH + 5;
  const shorelinePts: Vec2[] = [];
  const shoreSteps = 28;
  for (let i = 0; i <= shoreSteps; i++) {
    const t = i / shoreSteps;
    const x = margin + t * innerW;
    const y = lakeTopY + Math.sin(t * Math.PI * 3.0) * 1.4;
    shorelinePts.push([x, y]);
  }

  const lakePoly: Vec2[] = [
    ...shorelinePts,
    [W - margin, lakeBottomY],
    [margin, lakeBottomY],
  ];

  const lakeMaskId = scene.addPolygon({
    points: lakePoly,
    zIndex: 58,
    mode: "normal",
    stroke: false,
    fill: HatchFill.parallel({
      layer: "shadow-cobalt",
      angleDeg: 0,
      spacingMm: 1.35 / density,
    }),
  });

  // Crisp upper shoreline stroke
  scene.addPolyline({
    points: shorelinePts,
    zIndex: 59,
    layer: "alpine-ink",
  });

  // Sunlit water shimmer reflection column below the sun (clipped inside lakeMaskId)
  const shimmerWaves = Math.max(8, Math.round(18 * density));
  for (let i = 0; i < shimmerWaves; i++) {
    const t = (i + 0.5) / shimmerWaves;
    const wy = lakeTopY + 2.5 + t * (margin + innerH * 0.885 - lakeTopY - 5);
    const halfSpan = (8 + (1 - t) * 18) * (0.65 + 0.35 * Math.sin(i * 2.3));
    scene.addPolyline({
      points: [
        [sunCx - halfSpan, wy],
        [sunCx + halfSpan, wy],
      ],
      zIndex: 60,
      layer: "alpenglow-rust",
      clipToObjectId: lakeMaskId,
    });
  }

  // ---------------------------------------------------------------------------
  // 4. Foreground Rocky Promontories & Alpine Pine Trees (zIndex = 68..98)
  // ---------------------------------------------------------------------------
  // Left foreground rocky headland (extends past center to overlap cleanly with right bank)
  const leftBankTop: Vec2[] = [
    [margin, margin + innerH * 0.75],
    [margin + innerW * 0.14, margin + innerH * 0.77],
    [margin + innerW * 0.29, margin + innerH * 0.82],
    [margin + innerW * 0.44, margin + innerH * 0.88],
    [margin + innerW * 0.50, margin + innerH * 0.94],
    [margin + innerW * 0.54, margin + innerH],
  ];
  scene.addPolygon({
    points: [...leftBankTop, [margin, margin + innerH]],
    zIndex: 68,
    mode: "normal",
    stroke: false,
    fill: HatchFill.parallel({
      layer: "alpine-ink",
      angleDeg: -28,
      spacingMm: 1.05 / density,
    }),
  });
  scene.addPolyline({
    points: leftBankTop,
    zIndex: 69,
    layer: "alpine-ink",
  });

  // Right foreground rocky headland (overlaps the left bank)
  const rightBankTop: Vec2[] = [
    [margin + innerW * 0.48, margin + innerH],
    [margin + innerW * 0.50, margin + innerH * 0.94],
    [margin + innerW * 0.56, margin + innerH * 0.86],
    [margin + innerW * 0.71, margin + innerH * 0.79],
    [margin + innerW * 0.86, margin + innerH * 0.75],
    [W - margin, margin + innerH * 0.72],
  ];
  scene.addPolygon({
    points: [...rightBankTop, [W - margin, margin + innerH]],
    zIndex: 72,
    mode: "normal",
    stroke: false,
    fill: HatchFill.crossHatch({
      layer: "shadow-cobalt",
      angleDeg: 32,
      crossAngleDeg: -45,
      spacingMm: 1.1 / density,
    }),
  });
  scene.addPolyline({
    points: rightBankTop,
    zIndex: 73,
    layer: "alpine-ink",
  });

  // Helper to add a stylized Alpine Conifer (Pine Tree) with tiered boughs that occlude background lines
  const addAlpinePine = (baseX: number, baseY: number, heightMm: number, zIdx: number) => {
    const trunkW = Math.max(0.7, heightMm * 0.035);
    scene.addRect({
      x: baseX - trunkW * 0.5,
      y: baseY - heightMm * 0.25,
      width: trunkW,
      height: heightMm * 0.26,
      zIndex: zIdx,
      mode: "normal",
      stroke: { layer: "alpine-ink" },
    });

    const tiers = Math.max(4, Math.min(8, Math.round((heightMm / 6.5) * detailScale)));
    for (let t = 0; t < tiers; t++) {
      // Draw from bottom tier to top crown so upper boughs overlap lower boughs
      const frac = t / Math.max(1, tiers - 1); // 0 = lowest bough, 1 = apex
      const tierTopY = baseY - heightMm * (0.36 + frac * 0.64);
      const tierBotY = baseY - heightMm * (0.14 + frac * 0.56);
      const halfSpan = heightMm * (0.28 * (1 - frac * 0.72) + 0.04);

      // Left shaded bough wing
      const leftWing: Vec2[] = [
        [baseX, tierTopY],
        [baseX - halfSpan, tierBotY],
        [baseX - halfSpan * 0.45, tierBotY - (tierBotY - tierTopY) * 0.14],
        [baseX, tierBotY - (tierBotY - tierTopY) * 0.08],
      ];
      scene.addPolygon({
        points: leftWing,
        zIndex: zIdx + 0.1 + t * 0.05,
        mode: "normal",
        stroke: { layer: "alpine-ink" },
        fill: HatchFill.parallel({
          layer: "alpine-ink",
          angleDeg: -55,
          spacingMm: 0.65 / density,
        }),
      });

      // Right sunlit bough wing
      const rightWing: Vec2[] = [
        [baseX, tierTopY],
        [baseX, tierBotY - (tierBotY - tierTopY) * 0.08],
        [baseX + halfSpan * 0.45, tierBotY - (tierBotY - tierTopY) * 0.14],
        [baseX + halfSpan, tierBotY],
      ];
      scene.addPolygon({
        points: rightWing,
        zIndex: zIdx + 0.12 + t * 0.05,
        mode: "normal",
        stroke: { layer: "alpine-ink" },
        fill: HatchFill.parallel({
          layer: "shadow-cobalt",
          angleDeg: 55,
          spacingMm: 1.15 / density,
        }),
      });
    }
  };

  // Place stands of Alpine Pines along the left and right foreground ridges (sorted back-to-front)
  const pineSpecs = [
    // Left ridge stand
    { u: 0.06, v: 0.79, h: 38, z: 76 },
    { u: 0.12, v: 0.81, h: 46, z: 78 },
    { u: 0.19, v: 0.83, h: 33, z: 80 },
    { u: 0.25, v: 0.85, h: 27, z: 82 },
    { u: 0.09, v: 0.88, h: 52, z: 88 },
    { u: 0.16, v: 0.91, h: 42, z: 90 },
    // Right ridge stand
    { u: 0.74, v: 0.81, h: 31, z: 77 },
    { u: 0.81, v: 0.79, h: 44, z: 79 },
    { u: 0.88, v: 0.77, h: 50, z: 81 },
    { u: 0.94, v: 0.76, h: 36, z: 83 },
    { u: 0.84, v: 0.87, h: 54, z: 92 },
    { u: 0.91, v: 0.89, h: 45, z: 94 },
  ];

  const activePineCount = Math.max(4, Math.round(pineSpecs.length * Math.min(1, detailScale)));
  for (let i = 0; i < activePineCount; i++) {
    const p = pineSpecs[i];
    addAlpinePine(margin + p.u * innerW, margin + p.v * innerH, p.h, p.z);
  }

  // ---------------------------------------------------------------------------
  // 5. Negative Erase Margin Masks (`mode: "erase"`) & Printmaker's Double Frame
  // ---------------------------------------------------------------------------
  const frameZ = 115;
  scene.addRect({ x: 0, y: H - margin, width: W, height: margin + 5, zIndex: frameZ, mode: "erase" });
  scene.addRect({ x: 0, y: 0, width: margin, height: H, zIndex: frameZ, mode: "erase" });
  scene.addRect({ x: W - margin, y: 0, width: margin + 5, height: H, zIndex: frameZ, mode: "erase" });
  scene.addRect({ x: 0, y: 0, width: W, height: margin, zIndex: frameZ, mode: "erase" });

  // Inner and outer printmaker's frame borders
  scene.addRect({
    x: margin,
    y: margin,
    width: innerW,
    height: innerH,
    zIndex: frameZ + 5,
    mode: "transparent",
    stroke: { layer: "alpine-ink" },
  });
  scene.addRect({
    x: margin - 2.2,
    y: margin - 2.2,
    width: innerW + 4.4,
    height: innerH + 4.4,
    zIndex: frameZ + 6,
    mode: "transparent",
    stroke: { layer: "alpine-ink" },
  });

  return scene;
}

export const buildLayeredGrassScene2D = buildAlpineMountainsScene2D;
export const buildMountainRangeScene2D = buildAlpineMountainsScene2D;
