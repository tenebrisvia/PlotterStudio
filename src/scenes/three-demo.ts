import * as THREE from "three";
import { fromThreeScene, HatchFill, PlotterScene3D } from "../lib/index.ts";

export interface ThreeSceneDemoParams {
  readonly cameraAzimuthDeg?: number;
  readonly cameraElevationDeg?: number;
  readonly cameraDistance?: number;
  readonly hatchDensityScale?: number;
  readonly lodRatio?: number;
}

/**
 * Demonstrates the first-class Three.js adapter (`fromThreeScene`):
 * Builds a real `THREE.Scene` with intersecting architectural monoliths, torus rings,
 * and icosahedra, then converts it into a `PlotterScene3D`.
 */
export function buildThreeAdapterDemoScene(params: ThreeSceneDemoParams = {}): PlotterScene3D {
  const density = params.hatchDensityScale ?? 1.0;
  const lod = params.lodRatio ?? 1.0;
  const azRad = ((params.cameraAzimuthDeg ?? 28) * Math.PI) / 180;
  const elRad = ((params.cameraElevationDeg ?? 24) * Math.PI) / 180;
  const dist = params.cameraDistance ?? 19.0;

  const threeScene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 210 / 297, 0.5, 150);
  camera.position.set(
    dist * Math.cos(elRad) * Math.sin(azRad),
    dist * Math.sin(elRad),
    dist * Math.cos(elRad) * Math.cos(azRad)
  );
  camera.lookAt(0, 0, 0);

  const mat = new THREE.MeshBasicMaterial();

  // Central Torus (segments scale with LOD)
  const radialSegs = Math.max(6, Math.round(16 * lod));
  const tubularSegs = Math.max(12, Math.round(36 * lod));
  const torusGeom = new THREE.TorusGeometry(3.4, 1.05, radialSegs, tubularSegs);
  const torusMesh = new THREE.Mesh(torusGeom, mat);
  torusMesh.rotation.set(0.55, 0.35, 0.1);
  torusMesh.userData.plotter = {
    stroke: { layer: "outlines", outlines: true, silhouettes: true, creaseAngleDeg: 22 },
    fill: HatchFill.parallel({
      layer: "hatch-primary",
      angleDeg: 40,
      spacingMm: 0.85 / density,
      shadeByLight: {
        direction: [0.7, 1.0, 0.5],
        minSpacingMm: 0.42 / density,
        maxSpacingMm: 1.8 / density,
        highlightCutoff: 0.78,
      },
    }),
  };
  threeScene.add(torusMesh);

  // Intersecting Monolith Column passing right through the Torus ring!
  const pillarGeom = new THREE.BoxGeometry(2.1, 11.0, 2.1);
  const pillarMesh = new THREE.Mesh(pillarGeom, mat);
  pillarMesh.rotation.set(-0.2, 0.45, 0.25);
  pillarMesh.userData.plotter = {
    stroke: { layer: "outlines", outlines: true, silhouettes: true },
    fill: HatchFill.parallel({
      layer: "hatch-warm",
      angleDeg: -45,
      spacingMm: 0.8 / density,
      insetMm: 0.15,
      shadeByLight: {
        direction: [0.7, 1.0, 0.5],
        minSpacingMm: 0.4 / density,
        maxSpacingMm: 1.7 / density,
        highlightCutoff: 0.82,
      },
    }),
  };
  threeScene.add(pillarMesh);

  // Orbiting Icosahedra
  const icoGeom = new THREE.IcosahedronGeometry(1.55, 0);
  const icoPositions: [number, number, number][] = [
    [-4.2, 2.6, 2.4],
    [4.1, -2.3, 2.8],
    [2.8, 3.8, -2.2],
    [-3.5, -3.2, -1.9],
  ];

  for (let i = 0; i < icoPositions.length; i++) {
    const ico = new THREE.Mesh(icoGeom, mat);
    ico.position.set(...icoPositions[i]);
    ico.rotation.set(i * 0.7, i * 1.1, i * 0.4);
    ico.userData.plotter = {
      stroke: { layer: "outlines", outlines: true, creaseAngleDeg: 15 },
      fill: HatchFill.crossHatch({
        layer: i % 2 === 0 ? "hatch-primary" : "hatch-warm",
        angleDeg: i % 2 === 0 ? 30 : -30,
        spacingMm: 0.75 / density,
        insetMm: 0.14,
        shadeByLight: {
          direction: [0.7, 1.0, 0.5],
          minSpacingMm: 0.45 / density,
          maxSpacingMm: 1.65 / density,
          highlightCutoff: 0.82,
        },
      }),
    };
    threeScene.add(ico);
  }

  const plotterScene = fromThreeScene(threeScene, camera);
  plotterScene.registerLayer({ id: "outlines", name: "01-Outlines-Black", color: "#141413", strokeWidthMm: 0.24 });
  plotterScene.registerLayer({ id: "hatch-primary", name: "02-Hatch-Cobalt", color: "#1e40af", strokeWidthMm: 0.16 });
  plotterScene.registerLayer({ id: "hatch-warm", name: "03-Hatch-Terracotta", color: "#c2410c", strokeWidthMm: 0.16 });

  return plotterScene;
}
