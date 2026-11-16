import {
  decimateMeshLOD,
  HatchFill,
  parseGLB,
  PlotterScene3D,
  type ParsedGLBMesh,
  type Vec3,
} from "../lib/index.ts";

export interface SkullSceneParams {
  readonly cameraAzimuthDeg?: number;
  readonly cameraElevationDeg?: number;
  readonly cameraDistance?: number;
  readonly hatchDensityScale?: number;
  readonly lodRatio?: number;
  readonly rotationDeg?: Vec3;
}

let cachedSkullMeshes: ParsedGLBMesh[] | null = null;

export async function ensureSkullLoaded(): Promise<ParsedGLBMesh[]> {
  if (cachedSkullMeshes) {
    return cachedSkullMeshes;
  }

  let buffer: ArrayBuffer | Uint8Array;
  if (typeof window !== "undefined" && typeof fetch === "function") {
    const assetUrl = new URL("./skull.glb", import.meta.url).href;
    const resp = await fetch(assetUrl);
    buffer = await resp.arrayBuffer();
  } else {
    // Hidden from Vite static analysis via dynamic variable and @vite-ignore
    const fsName = "node:fs";
    const urlName = "node:url";
    const { readFileSync } = await import(/* @vite-ignore */ fsName);
    const { fileURLToPath } = await import(/* @vite-ignore */ urlName);
    buffer = readFileSync(fileURLToPath(new URL("./skull.glb", import.meta.url)));
  }

  cachedSkullMeshes = parseGLB(buffer, {
    center: true,
    normalizeSize: 10.5,
  });
  return cachedSkullMeshes;
}

/**
 * Builds the 3D Skull scene (`skull.glb`, 10,000 triangles) with anatomical silhouette/crease lines
 * and continuous engraving hatch shading.
 */
export function buildSkullScene(
  meshes: ParsedGLBMesh[],
  params: SkullSceneParams = {}
): PlotterScene3D {
  const density = params.hatchDensityScale ?? 1.0;
  const azRad = ((params.cameraAzimuthDeg ?? -28) * Math.PI) / 180;
  const elRad = ((params.cameraElevationDeg ?? 12) * Math.PI) / 180;
  const dist = params.cameraDistance ?? 22.0;

  const camPos: Vec3 = [
    dist * Math.cos(elRad) * Math.sin(azRad),
    dist * Math.sin(elRad),
    dist * Math.cos(elRad) * Math.cos(azRad),
  ];

  const scene = new PlotterScene3D({
    type: "perspective",
    position: camPos,
    target: [0, -0.3, 0],
    fovDeg: 38,
    near: 1.0,
    far: 100,
  });

  scene.registerLayer({
    id: "ink",
    name: "01-Outlines-Black",
    color: "#141413",
    strokeWidthMm: 0.22,
  });
  scene.registerLayer({
    id: "shade",
    name: "02-Engraving-Shade",
    color: "#1e3a8a",
    strokeWidthMm: 0.15,
  });

  const lightDir: Vec3 = [-0.65, 0.8, 0.75];
  const lodRatio = params.lodRatio ?? 1.0;

  for (const rawMesh of meshes) {
    const m = decimateMeshLOD(rawMesh, lodRatio);
    scene.addMesh({
      vertices: m.vertices,
      faces: m.faces,
      rotationDeg: params.rotationDeg ?? [0, 0, 0],
      stroke: {
        layer: "ink",
        outlines: true,
        silhouettes: true,
        creaseAngleDeg: 15,
      },
      fill: HatchFill.crossHatch({
        layer: "shade",
        angleDeg: 28,
        crossAngleDeg: -62,
        spacingMm: 0.55 / density,
        shadeByLight: {
          direction: lightDir,
          minSpacingMm: 0.48 / density,
          maxSpacingMm: 1.9 / density,
          highlightCutoff: 0.68,
        },
      }),
    });
  }

  return scene;
}
