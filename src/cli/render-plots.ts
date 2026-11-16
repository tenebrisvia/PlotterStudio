import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { init } from "vgpu/node";
import { createPlotter, PaperSize } from "../lib/index.ts";
import { buildAlpineMountainsScene2D } from "../scenes/alpine-mountains.ts";
import { buildRandomSquaresScene2D } from "../scenes/random-squares.ts";
import { buildSkullScene, ensureSkullLoaded } from "../scenes/skull-scene.ts";
import { buildThreeAdapterDemoScene } from "../scenes/three-demo.ts";

async function main() {
  const outDir = join(process.cwd(), "output");
  mkdirSync(outDir, { recursive: true });

  const skullMeshes = await ensureSkullLoaded();

  const gpu = await init();
  const plotter = await createPlotter({
    gpu,
    paper: PaperSize.A4_PORTRAIT,
    penWidthMm: 0.2,
    resolution: 2048,
  });

  const benchmarks = [
    {
      name: "alpine-mountains-2d",
      title: "Alpine Mountain Range (Pure 2D Painter's Order + Clip Masks)",
      scene: buildAlpineMountainsScene2D({ paper: PaperSize.A4_PORTRAIT, detailLevel: 140 }),
    },
    {
      name: "random-squares-1000",
      title: "1,000 Random Overlapping Squares (2D Stress Test)",
      scene: buildRandomSquaresScene2D({ paper: PaperSize.A4_PORTRAIT, count: 1000 }),
    },
    {
      name: "threejs-adapter",
      title: "Three.js Scene Adapter (Intersecting Torus + Monolith)",
      scene: buildThreeAdapterDemoScene(),
    },
    {
      name: "skull-glb",
      title: "Anatomical Skull (skull.glb — 10,000 Triangles + Engraving Hatch)",
      scene: buildSkullScene(skullMeshes),
    },
  ];

  console.log("\n================================================================================");
  console.log("  Plotter Studio — Headless Benchmark & SVG Generation (vgpu/node)");
  console.log("================================================================================\n");

  for (const b of benchmarks) {
    const res = await plotter.plot(b.scene, {
      optimizeTravel: true,
      captureGBufferPreview: true,
    });

    const svgPath = join(outDir, `${b.name}.svg`);
    const svgContent = res.toSVG({
      includePaperBorder: true,
      backgroundColor: "#faf8f5",
    });
    writeFileSync(svgPath, svgContent, "utf8");

    if (res.gbufferPreviewRGBA) {
      const [w, h] = res.stats.resolution;
      const png = new PNG({ width: w, height: h });
      png.data.set(res.gbufferPreviewRGBA);
      const pngPath = join(outDir, `${b.name}-gbuffer.png`);
      writeFileSync(pngPath, PNG.sync.write(png));
    }

    const s = res.stats;
    console.log(`▶ ${b.title}`);
    console.log(
      `  • Geometry:       ${s.triangleCount.toLocaleString()} triangles | ${s.candidateSegmentCount.toLocaleString()} candidate segments`
    );
    console.log(
      `  • Output Paths:   ${s.rawVisibleSubSegments.toLocaleString()} GPU sub-segments → ${s.finalPolylineCount.toLocaleString()} chained polylines (${s.finalVertexCount.toLocaleString()} pts)`
    );
    console.log(
      `  • Pen Travel:     Draw ${(s.totalDrawLengthMm / 1000).toFixed(2)}m | Travel ${(s.unoptimizedTravelLengthMm / 1000).toFixed(2)}m → ${(s.optimizedTravelLengthMm / 1000).toFixed(2)}m (-${s.travelSavingsPercent.toFixed(1)}%)`
    );
    console.log(
      `  • Performance:    GPU ${s.gpuTimeMs.toFixed(1)} ms | Post-process ${s.postProcessTimeMs.toFixed(1)} ms | Total ${s.totalTimeMs.toFixed(1)} ms`
    );
    console.log(`  • Saved SVG:      ${svgPath}\n`);
  }

  plotter.dispose();
  gpu.dispose();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
