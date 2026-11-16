import fs from "node:fs";
import path from "node:path";
import * as THREE from "three";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { init, type Gpu } from "vgpu/node";
import {
  createPlotter,
  fromThreeScene,
  getPolygonScanlineChords,
  HatchFill,
  PaperSize,
  type ScreenVertex,
  type WebGPUPlotter,
} from "../index.ts";
import { triangulatePolygon2D } from "../math.ts";
import { generatePolygonHatchSegments } from "../hatching.ts";
import { GBUFFER_WGSL, LINE_MARCHER_WGSL, PREVIEW_WGSL } from "../shaders/index.ts";
import { buildRandomSquaresScene2D } from "../../scenes/random-squares.ts";

describe("WebGPUPlotter (3D & 2D Hidden Line Removal + Hatching)", () => {
  let gpu: Gpu;
  let plotter: WebGPUPlotter;

  beforeAll(async () => {
    gpu = await init();
    plotter = await createPlotter({
      gpu,
      paper: PaperSize.A4_PORTRAIT,
      resolution: 1024,
    });
  });

  afterAll(() => {
    plotter?.dispose();
    gpu?.dispose();
  });

  it("occludes 3D lines behind a foreground box while preserving visible parts", async () => {
    const scene = plotter.createScene3D({
      position: [0, 0, 15],
      target: [0, 0, 0],
      fovDeg: 45,
    });

    // Foreground occluding box centered at origin (size 4x4x4)
    scene.addBox({
      size: [4, 4, 4],
      position: [0, 0, 0],
      stroke: { layer: "default", outlines: true },
    });

    // Long horizontal line at z = -4 passing behind the box from x = -6 to x = +6
    scene.addPolyline3D({
      points: [
        [-6, 0, -4],
        [6, 0, -4],
      ],
      layer: "accent",
    });

    const result = await plotter.plot(scene, { chainPolylines: false });
    const defaultLayer = result.layers.find((l) => l.id === "default");
    expect(defaultLayer).toBeDefined();
    // Viewed head-on from [0, 0, 15], the front +Z face of the box has 4 visible edges
    expect(defaultLayer!.polylines.length).toBe(4);

    const accentLayer = result.layers.find((l) => l.id === "accent");
    expect(accentLayer).toBeDefined();
    // Because the middle of the line is blocked by the foreground box, it must split into 2 visible segments!
    expect(accentLayer!.polylines.length).toBe(2);
    expect(result.stats.gpuTimeMs).toBeGreaterThan(0);

    // Viewed from a 3/4 corner angle [10, 10, 10], a cube must have 9 visible edges:
    // 6 outer hexagon silhouette edges + 3 inner Y-corner crease edges!
    const cornerScene = plotter.createScene3D({
      position: [10, 10, 10],
      target: [0, 0, 0],
      fovDeg: 40,
    });
    cornerScene.addBox({
      size: [4, 4, 4],
      position: [0, 0, 0],
      stroke: { layer: "default", outlines: true, silhouettes: true },
    });
    const cornerRes = await plotter.plot(cornerScene, { chainPolylines: false });
    expect(cornerRes.layers[0].polylines.length).toBe(9);
  });

  it("supports 2D scenes with painter's order occlusion, positive clip masks, and negative erase masks", async () => {
    const scene2d = plotter.createScene2D();

    // Background horizontal line from x=20 to x=190 at y=100 (zIndex=1)
    scene2d.addPolyline({
      points: [
        [20, 100],
        [190, 100],
      ],
      zIndex: 1,
      layer: "default",
    });

    // Foreground occluding rectangle covering x=80..130, y=70..130 (zIndex=10)
    const rectId = scene2d.addRect({
      x: 80,
      y: 70,
      width: 50,
      height: 60,
      zIndex: 10,
      mode: "normal",
      stroke: false,
      fill: HatchFill.parallel({ layer: "hatch", angleDeg: 45, spacingMm: 3.0 }),
    });

    // Clipped line that spans x=20..190 at y=90, clipped strictly inside rectId
    scene2d.addPolyline({
      points: [
        [20, 90],
        [190, 90],
      ],
      zIndex: 11,
      layer: "accent",
      clipToObjectId: rectId,
    });

    const res = await plotter.plot(scene2d);
    const bgLayer = res.layers.find((l) => l.id === "default")!;
    const hatchLayer = res.layers.find((l) => l.id === "hatch")!;
    const accentLayer = res.layers.find((l) => l.id === "accent")!;

    // Background line was split into 2 pieces by the foreground rectangle
    expect(bgLayer.polylines.length).toBe(2);
    // Hatch fill generated inside the rectangle
    expect(hatchLayer.polylines.length).toBeGreaterThan(5);
    // Clipped line only exists inside x in [80, 130]
    expect(accentLayer.polylines.length).toBe(1);
    const clippedPoly = accentLayer.polylines[0];
    expect(clippedPoly[0][0]).toBeGreaterThanOrEqual(79.0);
    expect(clippedPoly[clippedPoly.length - 1][0]).toBeLessThanOrEqual(131.0);
  });

  it("converts a Three.js scene via fromThreeScene and optimizes pen travel", async () => {
    const threeScene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 210 / 297, 0.5, 100);
    camera.position.set(8, 7, 12);
    camera.lookAt(0, 0, 0);

    const mesh1 = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 3));
    const mesh2 = new THREE.Mesh(new THREE.BoxGeometry(2.5, 2.5, 2.5));
    mesh2.position.set(1.5, 1.0, 2.5);
    threeScene.add(mesh1, mesh2);

    const pScene = fromThreeScene(threeScene, camera, {
      defaultStroke: { layer: "default", outlines: true },
      defaultFill: HatchFill.crossHatch({ layer: "hatch", spacingMm: 1.5 }),
    });

    const result = await plotter.plot(pScene, {
      optimizeTravel: true,
    });

    expect(result.stats.finalPolylineCount).toBeGreaterThan(10);
    expect(result.stats.optimizedTravelLengthMm).toBeLessThanOrEqual(
      result.stats.unoptimizedTravelLengthMm
    );

    const svg = result.toSVG({ includePenTravel: true, includePaperBorder: true });
    expect(svg).toContain("<svg");
    expect(svg).toContain('width="210mm"');
    expect(svg).toContain("inkscape:groupmode=\"layer\"");
    expect(svg).toContain('id="layer-pen-travel"');
    expect(svg).toContain('stroke-width="0.38"');
    expect(svg).toContain('stroke-opacity="0.85"');
  });

  it("bridges adjacent parallel hatch lines into continuous meander / serpentine paths", async () => {
    const scene = plotter.createScene2D();
    scene.addRect({
      x: 50,
      y: 50,
      width: 40,
      height: 40,
      zIndex: 1,
      mode: "normal",
      stroke: false,
      fill: HatchFill.parallel({
        layer: "hatch",
        angleDeg: 0,
        spacingMm: 2.0,
      }),
    });

    // 1. Without meander joiner: ~20 separate parallel scanlines
    const unjoinedRes = await plotter.plot(scene, {
      chainPolylines: true,
      hatchJoinDistanceMm: 0,
    });
    const unjoinedHatch = unjoinedRes.layers.find((l) => l.id === "hatch")!;
    expect(unjoinedHatch.polylines.length).toBeGreaterThan(15);

    // 2. With meander joiner (gap = 2.5mm >= 2.0mm spacing): all scanlines bridged into 1 continuous polyline!
    const joinedRes = await plotter.plot(scene, {
      chainPolylines: true,
      hatchJoinDistanceMm: 2.5,
    });
    const joinedHatch = joinedRes.layers.find((l) => l.id === "hatch")!;
    expect(joinedHatch.polylines.length).toBe(1);
    expect(joinedHatch.polylines[0].length).toBeGreaterThan(30);
  });

  it("triangulates polygons with collinear / degenerate vertices without leaving holes", () => {
    // Polygon with collinear vertices along the top edge
    const pts: [number, number][] = [
      [0, 0],
      [5, 0],
      [10, 0], // collinear with [0,0] and [5,0]
      [10, 10],
      [5, 5],  // reflex dart vertex
      [0, 10],
    ];
    const tris = triangulatePolygon2D(pts);
    // Any n-gon must triangulate into exactly n - 2 = 4 triangles
    expect(tris.length).toBe(pts.length - 2);
  });

  it("applies uniform edge insetting without collapsing non-equilateral polygons", () => {
    // Rectangular polygon (100px x 40px)
    const poly = [
      { xPx: 0, yPx: 0, z: 5 },
      { xPx: 100, yPx: 0, z: 5 },
      { xPx: 100, yPx: 40, z: 5 },
      { xPx: 0, yPx: 40, z: 5 },
    ];
    const segs = generatePolygonHatchSegments(
      poly,
      HatchFill.parallel({ spacingMm: 1.0, insetMm: 0.5 }),
      3.78, // ~3.78 px/mm
      [0, 0, 1]
    );
    expect(segs.length).toBeGreaterThan(5);
    // All segment endpoints must lie strictly inside the inset boundary
    const insetPx = 0.5 * 3.78;
    for (const s of segs) {
      expect(s.x0Px).toBeGreaterThanOrEqual(insetPx - 0.1);
      expect(s.x0Px).toBeLessThanOrEqual(100 - insetPx + 0.1);
      expect(s.y0Px).toBeGreaterThanOrEqual(insetPx - 0.1);
      expect(s.y0Px).toBeLessThanOrEqual(40 - insetPx + 0.1);
    }
  });

  it("batches SVG polylines into compound paths by default to eliminate DOM bloat", async () => {
    const scene = plotter.createScene2D();
    for (let i = 0; i < 5; i++) {
      scene.addPolyline({
        points: [
          [10, 10 + i * 10],
          [50, 10 + i * 10],
        ],
        layer: "default",
      });
    }
    const result = await plotter.plot(scene);
    const batchedSvg = result.toSVG({ combinePathsPerLayer: true });
    // Default layer group should contain exactly 1 combined <path> tag instead of 5
    const pathMatches = batchedSvg.match(/<path d=/g);
    expect(pathMatches?.length).toBe(1);

    const unbatchedSvg = result.toSVG({ combinePathsPerLayer: false });
    const unbatchedMatches = unbatchedSvg.match(/<path d=/g);
    expect(unbatchedMatches?.length).toBe(5);
  });

  it("reuses persistent storage buffers across multiple plot executions without memory leak", async () => {
    // 1. First small plot
    const sceneSmall = plotter.createScene2D();
    sceneSmall.addRect({ x: 10, y: 10, width: 20, height: 20, stroke: { layer: "l1" } });
    const res1 = await plotter.plot(sceneSmall);
    expect(res1.layers.length).toBeGreaterThan(0);

    // 2. Larger plot requiring buffer growth
    const sceneLarge = plotter.createScene2D();
    for (let i = 0; i < 50; i++) {
      sceneLarge.addRect({
        x: 10 + i * 2,
        y: 10 + i * 2,
        width: 15,
        height: 15,
        stroke: { layer: "l1" },
        fill: HatchFill.parallel({ layer: "hatch", spacingMm: 1.0 }),
      });
    }
    const res2 = await plotter.plot(sceneLarge);
    expect(res2.stats.candidateSegmentCount).toBeGreaterThan(res1.stats.candidateSegmentCount);

    // 3. Third plot with small geometry reusing already allocated capacity
    const res3 = await plotter.plot(sceneSmall);
    expect(res3.layers.length).toBeGreaterThan(0);
  });

  it("does not merge coplanar triangle pairs into invalid non-convex quads", () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(1, 1, 10);
    camera.lookAt(1, 1, 0);

    // 1. Chevron geometry (reflex polygon on Z=0):
    // p0: (0, 0, 0), p1: (2, 0, 0), p2: (1, 0.5, 0) [reflex inward], p3: (0, 2, 0)
    // Triangle 0: (p0, p1, p2)
    // Triangle 1: (p0, p2, p3)
    const threeSceneNonConvex = new THREE.Scene();
    const geomNonConvex = new THREE.BufferGeometry();
    const posNonConvex = new Float32Array([
      0, 0, 0,   2, 0, 0,   1, 0.5, 0,  // Triangle 0
      0, 0, 0,   1, 0.5, 0, 0, 2, 0,    // Triangle 1
    ]);
    geomNonConvex.setAttribute("position", new THREE.BufferAttribute(posNonConvex, 3));
    threeSceneNonConvex.add(new THREE.Mesh(geomNonConvex));

    const pSceneNonConvex = fromThreeScene(threeSceneNonConvex, camera);
    const nonConvexMeshes = (pSceneNonConvex as unknown as { meshes: Array<{ faces: Array<{ indices: number[] }> }> }).meshes;
    // Faces must NOT be merged into a 4-vertex quad; they must remain 2 separate triangles
    expect(nonConvexMeshes[0].faces.length).toBe(2);
    expect(nonConvexMeshes[0].faces[0].indices.length).toBe(3);
    expect(nonConvexMeshes[0].faces[1].indices.length).toBe(3);

    // 2. Convex coplanar quad (Z=0 plane square split into two triangles):
    // Triangle 0: (0, 0, 0), (2, 0, 0), (2, 2, 0)
    // Triangle 1: (0, 0, 0), (2, 2, 0), (0, 2, 0)
    const threeSceneConvex = new THREE.Scene();
    const geomConvex = new THREE.BufferGeometry();
    const posConvex = new Float32Array([
      0, 0, 0,   2, 0, 0,   2, 2, 0,  // Triangle 0
      0, 0, 0,   2, 2, 0,   0, 2, 0,  // Triangle 1
    ]);
    geomConvex.setAttribute("position", new THREE.BufferAttribute(posConvex, 3));
    threeSceneConvex.add(new THREE.Mesh(geomConvex));

    const pSceneConvex = fromThreeScene(threeSceneConvex, camera);
    const convexMeshes = (pSceneConvex as unknown as { meshes: Array<{ faces: Array<{ indices: number[] }> }> }).meshes;
    // Strictly convex pair MUST be merged into 1 4-vertex quad
    expect(convexMeshes[0].faces.length).toBe(1);
    expect(convexMeshes[0].faces[0].indices.length).toBe(4);
  });

  it("renders G-Buffer preview via fullscreen GPU shader into an rgba8 byte buffer", async () => {
    const scene = plotter.createScene2D();
    scene.addRect({ x: 20, y: 20, width: 60, height: 60, stroke: { layer: "l1" } });

    const result = await plotter.plot(scene, {
      captureGBufferPreview: true,
    });

    expect(result.gbufferPreviewRGBA).toBeDefined();
    const [w, h] = result.stats.resolution;
    expect(result.gbufferPreviewRGBA?.byteLength).toBe(w * h * 4);

    // Verify paper background alpha channel is 255
    expect(result.gbufferPreviewRGBA![3]).toBe(255);
  });

  it("supports custom user-defined hatching routines (e.g. sine wave) with 3D depth occlusion", async () => {
    const scene = plotter.createScene3D({
      position: [0, 0, 18],
      target: [0, 0, 0],
    });

    scene.registerLayer({ id: "sine-layer", name: "Custom Sine Wave", color: "#2563eb" });

    // Custom sine wave hatching generator
    const sineWaveHatch = HatchFill.custom(
      (ctx) => {
        const spacingPx = 2.0 * ctx.pxPerMm;
        const amplitudePx = 0.5 * ctx.pxPerMm;
        const wavelengthPx = 4.0 * ctx.pxPerMm;
        const chords = getPolygonScanlineChords(ctx.screenPoly, spacingPx, 0); // horizontal scanlines
        const waves: ScreenVertex[][] = [];

        for (const chord of chords) {
          const pts: ScreenVertex[] = [];
          const len = chord.x1 - chord.x0;
          if (len < 1.0) continue;
          const steps = Math.ceil(len / 1.5);

          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const x = chord.x0 + len * t;
            const yBase = chord.y0;
            const waveY = yBase + Math.sin((x / wavelengthPx) * Math.PI * 2) * amplitudePx;

            pts.push({
              xPx: x,
              yPx: waveY,
              z: ctx.interpolateZ(x, waveY),
            });
          }

          waves.push(...ctx.clipPolyline(pts));
        }

        return waves;
      },
      { layer: "sine-layer" }
    );

    // Background cube with custom sine wave hatch
    scene.addBox({
      position: [0, 0, -4],
      size: [6, 6, 2],
      stroke: { layer: "outlines" },
      fill: sineWaveHatch,
    });

    // Foreground occluder covering right half of background cube
    scene.addBox({
      position: [2, 0, 0],
      size: [4, 8, 2],
      stroke: { layer: "outlines" },
    });

    const result = await plotter.plot(scene);
    const sineLayer = result.layers.find((l) => l.id === "sine-layer");
    expect(sineLayer).toBeDefined();
    expect(sineLayer!.polylines.length).toBeGreaterThan(0);

    // Verify that polylines behind the foreground occluder (x > 0) are clipped by WebGPU line marcher
    let visiblePointsInOccludedRegion = 0;
    for (const poly of sineLayer!.polylines) {
      for (const [x] of poly) {
        // Foreground box spans roughly x from 0 to 4 in 3D projection
        // The background cube right half is occluded, left half (x < 0 in paper coordinates) is visible
        if (x > 115) { // Paper width is 210mm, center is ~105mm
          visiblePointsInOccludedRegion++;
        }
      }
    }
    // Occlusion should significantly reduce points on the right side
    expect(visiblePointsInOccludedRegion).toBeLessThan(10);
  });

  it("supports custom user-defined hatching in 2D scenes with polygon boundary clipping", async () => {
    const scene = plotter.createScene2D();
    scene.registerLayer({ id: "custom-2d", name: "Custom 2D Waves", color: "#16a34a" });

    const wavyHatch = HatchFill.custom(
      (ctx) => {
        const spacingPx = 3.0 * ctx.pxPerMm;
        const amplitudePx = 0.8 * ctx.pxPerMm;
        const wavelengthPx = 5.0 * ctx.pxPerMm;
        const chords = getPolygonScanlineChords(ctx.screenPoly, spacingPx, Math.PI / 4);
        const result: ScreenVertex[][] = [];

        for (const c of chords) {
          const dx = c.x1 - c.x0;
          const dy = c.y1 - c.y0;
          const len = Math.hypot(dx, dy);
          if (len < 1.0) continue;
          const steps = Math.ceil(len / 1.5);
          const pts: ScreenVertex[] = [];

          // Normal to chord direction
          const nx = -dy / len;
          const ny = dx / len;

          for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const xBase = c.x0 + dx * t;
            const yBase = c.y0 + dy * t;
            const offset = Math.sin((t * len / wavelengthPx) * Math.PI * 2) * amplitudePx;

            pts.push({
              xPx: xBase + nx * offset,
              yPx: yBase + ny * offset,
              z: 1.0,
            });
          }

          result.push(...ctx.clipPolyline(pts));
        }

        return result;
      },
      { layer: "custom-2d" }
    );

    scene.addPolygon({
      points: [
        [30, 30],
        [80, 30],
        [80, 80],
        [30, 80],
      ],
      fill: wavyHatch,
      stroke: { layer: "outlines" },
    });

    const res = await plotter.plot(scene);
    const customLayer = res.layers.find((l) => l.id === "custom-2d");
    expect(customLayer).toBeDefined();
    expect(customLayer!.polylines.length).toBeGreaterThan(0);

    // Verify all points in custom layer stay within polygon bounds (with small epsilon for numerical tolerance)
    for (const poly of customLayer!.polylines) {
      for (const [x, y] of poly) {
        expect(x).toBeGreaterThanOrEqual(29.8);
        expect(x).toBeLessThanOrEqual(80.2);
        expect(y).toBeGreaterThanOrEqual(29.8);
        expect(y).toBeLessThanOrEqual(80.2);
      }
    }
  });

  it("keeps shader WGSL files in sync with compiled shader constants", () => {
    const shadersDir = path.resolve(__dirname, "../shaders");
    const gbuffer = fs.readFileSync(path.join(shadersDir, "gbuffer.wgsl"), "utf8").trim();
    const marcher = fs.readFileSync(path.join(shadersDir, "line-marcher.wgsl"), "utf8").trim();
    const preview = fs.readFileSync(path.join(shadersDir, "preview.wgsl"), "utf8").trim();

    expect(GBUFFER_WGSL.trim()).toBe(gbuffer);
    expect(LINE_MARCHER_WGSL.trim()).toBe(marcher);
    expect(PREVIEW_WGSL.trim()).toBe(preview);
  });

  it("stress tests occlusion performance across 1,000 random overlapping squares", async () => {
    const scene = buildRandomSquaresScene2D({
      paper: PaperSize.A4_PORTRAIT,
      count: 1000,
      seed: 42,
    });

    const res = await plotter.plot(scene, { optimizeTravel: true });
    expect(res.stats.triangleCount).toBe(2000);
    expect(res.stats.candidateSegmentCount).toBeGreaterThan(4000);
    expect(res.stats.finalPolylineCount).toBeGreaterThan(100);
    expect(res.stats.rawVisibleSubSegments).toBeLessThan(res.stats.candidateSegmentCount);
    expect(res.stats.gpuTimeMs).toBeLessThan(500);
    const svg = res.toSVG();
    expect(svg).toContain("<svg");
  });
});
