import { dot3, normalize3 } from "./math.ts";
import type {
  GeneratedHatchSegment,
  HatchContext,
  HatchFillStyle,
  ScreenVertex,
  Vec2,
  Vec3,
} from "./types.ts";

export type { ScreenVertex, GeneratedHatchSegment };

export interface ScanlineChord {
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly x1: number;
  readonly y1: number;
  readonly z1: number;
}

/**
 * Computes a function that interpolates perspective-correct camera depth z at any
 * screen-space coordinate (x, y) on the plane formed by a polygon.
 */
export function createPlaneZInterpolator(
  poly: ScreenVertex[]
): (xPx: number, yPx: number) => number {
  if (poly.length === 0) return () => 1.0;
  if (poly.length <= 2) {
    const avgZ = poly.reduce((acc, v) => acc + v.z, 0) / poly.length;
    return () => avgZ;
  }

  const v0 = poly[0];
  let v1 = poly[1];
  let v2 = poly[2];
  let maxArea = 0;

  for (let i = 1; i < poly.length - 1; i++) {
    for (let j = i + 1; j < poly.length; j++) {
      const p1 = poly[i];
      const p2 = poly[j];
      const area = Math.abs(
        (p1.xPx - v0.xPx) * (p2.yPx - v0.yPx) - (p2.xPx - v0.xPx) * (p1.yPx - v0.yPx)
      );
      if (area > maxArea) {
        maxArea = area;
        v1 = p1;
        v2 = p2;
      }
    }
  }

  const det =
    (v1.xPx - v0.xPx) * (v2.yPx - v0.yPx) - (v2.xPx - v0.xPx) * (v1.yPx - v0.yPx);

  if (Math.abs(det) < 1e-6) {
    const avgZ = poly.reduce((acc, v) => acc + v.z, 0) / poly.length;
    return () => avgZ;
  }

  const invZ0 = 1.0 / Math.max(v0.z, 1e-4);
  const invZ1 = 1.0 / Math.max(v1.z, 1e-4);
  const invZ2 = 1.0 / Math.max(v2.z, 1e-4);

  const dInvZ1 = invZ1 - invZ0;
  const dInvZ2 = invZ2 - invZ0;
  const dx1 = v1.xPx - v0.xPx;
  const dy1 = v1.yPx - v0.yPx;
  const dx2 = v2.xPx - v0.xPx;
  const dy2 = v2.yPx - v0.yPx;

  // invZ(x, y) = invZ0 + A * (x - v0.x) + B * (y - v0.y)
  const A = (dInvZ1 * dy2 - dInvZ2 * dy1) / det;
  const B = (dx1 * dInvZ2 - dx2 * dInvZ1) / det;

  return (xPx: number, yPx: number) => {
    const invZ = invZ0 + A * (xPx - v0.xPx) + B * (yPx - v0.yPx);
    return 1.0 / Math.max(invZ, 1e-7);
  };
}

/**
 * Tests whether a 2D screen coordinate is inside a polygon using ray casting.
 */
export function pointInPolygon(xPx: number, yPx: number, poly: ScreenVertex[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].xPx;
    const yi = poly[i].yPx;
    const xj = poly[j].xPx;
    const yj = poly[j].yPx;
    const intersect =
      yi > yPx !== yj > yPx && xPx < ((xj - xi) * (yPx - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Clips an arbitrary polyline against a polygon boundary, returning a list of continuous
 * polyline segments that lie strictly inside the polygon with exact interpolated depth z.
 */
export function clipPolylineToPolygon(
  points: ScreenVertex[],
  poly: ScreenVertex[],
  interpolateZ?: (xPx: number, yPx: number) => number
): ScreenVertex[][] {
  if (points.length < 2 || poly.length < 3) return [];

  const getZ = interpolateZ ?? createPlaneZInterpolator(poly);
  const outPolylines: ScreenVertex[][] = [];
  let currentChain: ScreenVertex[] = [];

  const pushPoint = (pt: ScreenVertex) => {
    if (currentChain.length > 0) {
      const last = currentChain[currentChain.length - 1];
      if (Math.hypot(pt.xPx - last.xPx, pt.yPx - last.yPx) < 0.2) return;
    }
    currentChain.push(pt);
  };

  const endChain = () => {
    if (currentChain.length >= 2) {
      outPolylines.push(currentChain);
    }
    currentChain = [];
  };

  for (let s = 0; s + 1 < points.length; s++) {
    const a = points[s];
    const b = points[s + 1];
    const dx = b.xPx - a.xPx;
    const dy = b.yPx - a.yPx;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1e-4) continue;

    const tValues: number[] = [0, 1];

    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % poly.length];
      const edx = p2.xPx - p1.xPx;
      const edy = p2.yPx - p1.yPx;

      const denom = dx * edy - dy * edx;
      if (Math.abs(denom) < 1e-9) continue;

      const t = ((p1.xPx - a.xPx) * edy - (p1.yPx - a.yPx) * edx) / denom;
      const u = ((p1.xPx - a.xPx) * dy - (p1.yPx - a.yPx) * dx) / denom;

      if (t > 1e-5 && t < 1 - 1e-5 && u >= -1e-5 && u <= 1 + 1e-5) {
        tValues.push(t);
      }
    }

    tValues.sort((u, v) => u - v);

    const uniqueT: number[] = [tValues[0]];
    for (let k = 1; k < tValues.length; k++) {
      if (tValues[k] - uniqueT[uniqueT.length - 1] > 1e-5) {
        uniqueT.push(tValues[k]);
      }
    }

    for (let k = 0; k + 1 < uniqueT.length; k++) {
      const t0 = uniqueT[k];
      const t1 = uniqueT[k + 1];
      const tMid = (t0 + t1) * 0.5;
      const midX = a.xPx + dx * tMid;
      const midY = a.yPx + dy * tMid;

      if (pointInPolygon(midX, midY, poly)) {
        const x0 = a.xPx + dx * t0;
        const y0 = a.yPx + dy * t0;
        const x1 = a.xPx + dx * t1;
        const y1 = a.yPx + dy * t1;

        const pt0: ScreenVertex = { xPx: x0, yPx: y0, z: getZ(x0, y0) };
        const pt1: ScreenVertex = { xPx: x1, yPx: y1, z: getZ(x1, y1) };

        if (currentChain.length > 0) {
          const last = currentChain[currentChain.length - 1];
          if (Math.hypot(pt0.xPx - last.xPx, pt0.yPx - last.yPx) > 0.5) {
            endChain();
          }
        }

        pushPoint(pt0);
        pushPoint(pt1);
      } else {
        endChain();
      }
    }
  }

  endChain();
  return outPolylines;
}

/**
 * Computes straight parallel scanline chords intersecting a polygon at a given angle and spacing.
 */
export function getPolygonScanlineChords(
  poly: ScreenVertex[],
  spacingPx: number,
  angleRad: number,
  lineStride = 1
): ScanlineChord[] {
  const segs = slicePolygonByParallelLines(poly, angleRad, spacingPx, lineStride);
  return segs.map((s) => ({
    x0: s.x0Px,
    y0: s.y0Px,
    z0: s.z0,
    x1: s.x1Px,
    y1: s.y1Px,
    z1: s.z1,
  }));
}

/**
 * Constructs a HatchContext for user-provided custom hatching generators.
 */
export function buildHatchContext(
  poly: ScreenVertex[],
  pxPerMm: number,
  worldNormal: Vec3 = [0, 0, 1],
  lightFactor?: number
): HatchContext {
  const interpolateZ = createPlaneZInterpolator(poly);
  return {
    screenPoly: poly,
    pxPerMm,
    worldNormal,
    lightFactor,
    interpolateZ,
    containsPoint: (xPx: number, yPx: number) => pointInPolygon(xPx, yPx, poly),
    clipPolyline: (pts: ScreenVertex[]) => clipPolylineToPolygon(pts, poly, interpolateZ),
  };
}

/**
 * Generates parallel, cross-hatch, or user-defined custom hatch segments inside a closed 2D
 * screen-space polygon whose vertices carry linear depth `z`.
 */
export function generatePolygonHatchSegments(
  poly: ScreenVertex[],
  style: HatchFillStyle,
  pxPerMm: number,
  worldNormal: Vec3 = [0, 0, 1]
): GeneratedHatchSegment[] {
  if (poly.length < 3) return [];

  // Signed screen area to skip back-facing or degenerate polygons
  let signedArea2 = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    signedArea2 += a.xPx * b.yPx - b.xPx * a.yPx;
  }
  if (Math.abs(signedArea2) < 2.0) return [];

  // Handle custom user-provided hatching routines
  if (style.kind === "custom") {
    const ctx = buildHatchContext(poly, pxPerMm, worldNormal);
    const result = style.generate(ctx);
    if (!result || result.length === 0) return [];

    const first = result[0];
    if (Array.isArray(first)) {
      // Returned ScreenVertex[][] (list of polylines)
      const outSegs: GeneratedHatchSegment[] = [];
      const polylines = result as ScreenVertex[][];
      for (const pl of polylines) {
        for (let i = 0; i + 1 < pl.length; i++) {
          const p0 = pl[i];
          const p1 = pl[i + 1];
          if (Math.hypot(p1.xPx - p0.xPx, p1.yPx - p0.yPx) < 0.4) continue;
          outSegs.push({
            x0Px: p0.xPx,
            y0Px: p0.yPx,
            z0: p0.z,
            x1Px: p1.xPx,
            y1Px: p1.yPx,
            z1: p1.z,
          });
        }
      }
      return outSegs;
    } else {
      // Returned GeneratedHatchSegment[] directly
      return result as GeneratedHatchSegment[];
    }
  }

  // Parallel or Cross-Hatch
  let spacingMm = style.spacingMm ?? 1.2;
  let lineStride = 1;
  let ndotl = 0.5;
  let primaryShading: HatchShadingParams | undefined;
  let crossShading: HatchShadingParams | undefined;

  if (style.shadeByLight) {
    const lightDir = normalize3(style.shadeByLight.direction);
    const n = normalize3(worldNormal);
    ndotl = Math.max(0, Math.min(1, dot3(n, lightDir) * 0.5 + 0.5));
    const cutoff = style.shadeByLight.highlightCutoff ?? 0.85;
    const crossCutoff = style.shadeByLight.crossHatchThreshold ?? 0.48;
    const softness = style.shadeByLight.softness ?? 0.22;
    const randomness = style.shadeByLight.randomness ?? 0.28;
    const useGradual = softness > 0.001 || randomness > 0.001;

    if (!useGradual) {
      if (style.shadeByLight.highlightCutoff !== undefined && ndotl > cutoff) {
        return [];
      }
      const minS = style.shadeByLight.minSpacingMm;
      const maxS = style.shadeByLight.maxSpacingMm;

      if (poly.length === 3) {
        spacingMm = minS;
        const normShade = ndotl / Math.max(0.05, cutoff);
        if (normShade < 0.42) {
          lineStride = 1;
        } else if (normShade < 0.72) {
          lineStride = 2;
        } else {
          lineStride = 4;
        }
      } else {
        spacingMm = minS + (maxS - minS) * Math.pow(ndotl, 1.35);
      }
    } else {
      // Lock to global base spacing `minSpacingMm` so adjacent faces on curved or faceted
      // meshes align tip-to-tip while density & line lengths fade gradually.
      spacingMm = style.shadeByLight.minSpacingMm;
      primaryShading = {
        lightDir,
        fallbackNormal: n,
        cutoff,
        softness,
        randomness,
        pxPerMm,
        seedOffset: 101,
      };
      if (style.crossHatch) {
        crossShading = {
          lightDir,
          fallbackNormal: n,
          cutoff: crossCutoff,
          softness: Math.max(0.12, softness * 0.85),
          randomness,
          pxPerMm,
          seedOffset: 7919,
        };
      }
    }
  }

  const spacingPx = Math.max(1.5, spacingMm * pxPerMm);
  const insetPx = Math.max(0, (style.insetMm ?? 0) * pxPerMm);
  const workingPoly = insetPx > 0 ? insetPolygonScreen(poly, insetPx) : poly;
  if (workingPoly.length < 3) return [];

  const angleRad = ((style.angleDeg ?? 45) * Math.PI) / 180;
  const out = slicePolygonByParallelLines(
    workingPoly,
    angleRad,
    spacingPx,
    lineStride,
    primaryShading
  );

  const crossCutoff = style.shadeByLight?.crossHatchThreshold ?? 0.48;
  const shouldCross =
    style.crossHatch &&
    (!style.shadeByLight || crossShading !== undefined || ndotl < crossCutoff);
  if (shouldCross) {
    const crossDeg = style.crossAngleDeg ?? (style.angleDeg ?? 45) + 90;
    const crossRad = (crossDeg * Math.PI) / 180;
    const crossStride =
      !crossShading && poly.length === 3 && style.shadeByLight
        ? Math.max(2, lineStride * 2)
        : lineStride;
    const crossSegs = slicePolygonByParallelLines(
      workingPoly,
      crossRad,
      spacingPx * (poly.length === 3 || crossShading ? 1.0 : 1.15),
      crossStride,
      crossShading
    );
    out.push(...crossSegs);
  }

  return out;
}

interface HatchShadingParams {
  readonly lightDir: Vec3;
  readonly fallbackNormal: Vec3;
  readonly cutoff: number;
  readonly softness: number;
  readonly randomness: number;
  readonly pxPerMm: number;
  readonly seedOffset: number;
}

interface ScanlineHit {
  s: number;
  xPx: number;
  yPx: number;
  invZ: number;
  worldPos?: Vec3;
  worldNormal?: Vec3;
}

function hashInt2D(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function hashScanline(k: number, seed: number): number {
  let h = (Math.imul(k, 73856093) ^ Math.imul(seed, 19349663)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (Math.abs(edge1 - edge0) < 1e-6) {
    return x <= edge1 ? 1 : 0;
  }
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function valueNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hashInt2D(ix, iy, seed);
  const b = hashInt2D(ix + 1, iy, seed);
  const c = hashInt2D(ix, iy + 1, seed);
  const d = hashInt2D(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm2D(x: number, y: number, seed: number): number {
  return 0.65 * valueNoise2D(x, y, seed) + 0.35 * valueNoise2D(x * 2.13 + 7.3, y * 2.13 - 4.1, seed + 59);
}

function lerpVec3Perspective(
  a: Vec3,
  b: Vec3,
  t: number,
  invZa: number,
  invZb: number
): Vec3 {
  const wa = (1 - t) * invZa;
  const wb = t * invZb;
  const wSum = wa + wb;
  if (wSum <= 1e-9) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  const u = wa / wSum;
  const v = wb / wSum;
  return [a[0] * u + b[0] * v, a[1] * u + b[1] * v, a[2] * u + b[2] * v];
}

function evaluateHatchScore(
  xPx: number,
  yPx: number,
  worldPos: Vec3 | undefined,
  worldNormal: Vec3 | undefined,
  lineRank: number,
  shading: HatchShadingParams
): number {
  const n = worldNormal ? normalize3(worldNormal) : shading.fallbackNormal;
  const ndotl = Math.max(0, Math.min(1, dot3(n, shading.lightDir) * 0.5 + 0.5));

  // Gentle spatial gradient along the light axis so even large flat faces (e.g. columns)
  // transition gradually from brighter toward the light to darker away from it.
  let spatialShift = 0;
  if (worldPos && shading.randomness > 0) {
    const alongLight = dot3(worldPos, shading.lightDir);
    spatialShift =
      Math.max(-0.14, Math.min(0.14, alongLight * 0.026)) *
      (0.35 + 0.65 * shading.randomness);
  }

  const xMm = xPx / shading.pxPerMm;
  const yMm = yPx / shading.pxPerMm;
  const nLow = fbm2D(xMm * 0.11, yMm * 0.11, shading.seedOffset);
  const nDash = valueNoise2D(xMm * 0.45, yMm * 0.45, shading.seedOffset + 31);

  const toneNoise = (nLow - 0.5) * shading.randomness * 0.34;
  const effTone = Math.max(0, Math.min(1, ndotl + spatialShift + toneNoise));

  const edge0 = shading.cutoff + shading.softness * 0.45;
  const edge1 = shading.cutoff - shading.softness;
  const coverage = smoothstep(edge0, edge1, effTone);

  if (coverage <= 0.001) {
    return -1;
  }

  const dashJitter = (nDash - 0.5) * shading.randomness * 0.38 * Math.min(1, coverage * 2.5);
  return coverage - lineRank * 0.82 + dashJitter;
}

function slicePolygonByParallelLines(
  poly: ScreenVertex[],
  angleRad: number,
  spacingPx: number,
  lineStride = 1,
  shading?: HatchShadingParams
): GeneratedHatchSegment[] {
  const cosA = Math.cos(angleRad);
  const sinA = Math.sin(angleRad);
  // Line direction d = (cosA, sinA), normal n = (-sinA, cosA)
  const nx = -sinA;
  const ny = cosA;

  let minProj = Infinity;
  let maxProj = -Infinity;
  for (const v of poly) {
    const proj = v.xPx * nx + v.yPx * ny;
    if (proj < minProj) minProj = proj;
    if (proj > maxProj) maxProj = proj;
  }

  const results: GeneratedHatchSegment[] = [];
  // Align scanlines to global grid in rotated space so adjacent faces have continuous hatches!
  const firstK = Math.ceil(minProj / spacingPx);
  const lastK = Math.floor(maxProj / spacingPx);
  const minSegLenPx = shading ? Math.max(1.2, 0.75 * shading.pxPerMm) : 0.75;
  const sampleStepPx = shading ? Math.max(4.0, 1.8 * shading.pxPerMm) : 0;

  for (let k = firstK; k <= lastK; k++) {
    if (lineStride > 1 && ((k % lineStride) + lineStride) % lineStride !== 0) {
      continue;
    }
    const c = k * spacingPx;
    const hits: ScanlineHit[] = [];

    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const da = a.xPx * nx + a.yPx * ny - c;
      const db = b.xPx * nx + b.yPx * ny - c;

      if ((da < 0 && db >= 0) || (db < 0 && da >= 0)) {
        const denom = da - db;
        if (Math.abs(denom) < 1e-9) continue;
        const t = da / denom;
        const xPx = a.xPx + (b.xPx - a.xPx) * t;
        const yPx = a.yPx + (b.yPx - a.yPx) * t;
        const invZa = 1.0 / Math.max(a.z, 1e-4);
        const invZb = 1.0 / Math.max(b.z, 1e-4);
        const invZ = invZa + (invZb - invZa) * t;
        const s = xPx * cosA + yPx * sinA;
        let worldPos: Vec3 | undefined;
        let worldNormal: Vec3 | undefined;
        if (shading) {
          if (a.worldPos && b.worldPos) {
            worldPos = lerpVec3Perspective(a.worldPos, b.worldPos, t, invZa, invZb);
          }
          if (a.worldNormal && b.worldNormal) {
            worldNormal = lerpVec3Perspective(a.worldNormal, b.worldNormal, t, invZa, invZb);
          }
        }
        hits.push({ s, xPx, yPx, invZ, worldPos, worldNormal });
      }
    }

    if (hits.length < 2) continue;
    hits.sort((u, v) => u.s - v.s);

    // Alternate direction on odd scanlines to naturally reduce pen travel
    const flip = (k & 1) !== 0;
    const lineRank = shading
      ? (() => {
          const golden = (((k * 0.61803398875) % 1) + 1) % 1;
          const rnd = hashScanline(k, shading.seedOffset);
          const mix = shading.randomness * 0.65;
          return golden * (1 - mix) + rnd * mix;
        })()
      : 0;

    for (let i = 0; i + 1 < hits.length; i += 2) {
      const h0 = flip ? hits[i + 1] : hits[i];
      const h1 = flip ? hits[i] : hits[i + 1];
      const segLen = Math.hypot(h1.xPx - h0.xPx, h1.yPx - h0.yPx);
      if (segLen < minSegLenPx) continue;

      if (!shading) {
        results.push({
          x0Px: h0.xPx,
          y0Px: h0.yPx,
          z0: 1.0 / Math.max(h0.invZ, 1e-7),
          x1Px: h1.xPx,
          y1Px: h1.yPx,
          z1: 1.0 / Math.max(h1.invZ, 1e-7),
        });
        continue;
      }

      const steps = Math.max(2, Math.min(32, Math.ceil(segLen / sampleStepPx)));
      let inRun = false;
      let runStartT = 0;
      let prevT = 0;
      let prevScore = evaluateHatchScore(
        h0.xPx,
        h0.yPx,
        h0.worldPos,
        h0.worldNormal,
        lineRank,
        shading
      );
      if (prevScore > 0) {
        inRun = true;
        runStartT = 0;
      }

      for (let step = 1; step <= steps; step++) {
        const currT = step / steps;
        const currX = h0.xPx + (h1.xPx - h0.xPx) * currT;
        const currY = h0.yPx + (h1.yPx - h0.yPx) * currT;
        const currWp =
          h0.worldPos && h1.worldPos
            ? lerpVec3Perspective(h0.worldPos, h1.worldPos, currT, h0.invZ, h1.invZ)
            : undefined;
        const currWn =
          h0.worldNormal && h1.worldNormal
            ? lerpVec3Perspective(h0.worldNormal, h1.worldNormal, currT, h0.invZ, h1.invZ)
            : undefined;
        const currScore = evaluateHatchScore(
          currX,
          currY,
          currWp,
          currWn,
          lineRank,
          shading
        );

        if (currScore > 0 && prevScore <= 0) {
          const denom = currScore - prevScore;
          const frac = denom > 1e-6 ? -prevScore / denom : 0.5;
          runStartT = prevT + (currT - prevT) * Math.max(0, Math.min(1, frac));
          inRun = true;
        } else if (currScore <= 0 && prevScore > 0) {
          const denom = prevScore - currScore;
          const frac = denom > 1e-6 ? prevScore / denom : 0.5;
          const runEndT = prevT + (currT - prevT) * Math.max(0, Math.min(1, frac));
          const sx0 = h0.xPx + (h1.xPx - h0.xPx) * runStartT;
          const sy0 = h0.yPx + (h1.yPx - h0.yPx) * runStartT;
          const sx1 = h0.xPx + (h1.xPx - h0.xPx) * runEndT;
          const sy1 = h0.yPx + (h1.yPx - h0.yPx) * runEndT;
          if (Math.hypot(sx1 - sx0, sy1 - sy0) >= minSegLenPx) {
            const iz0 = h0.invZ + (h1.invZ - h0.invZ) * runStartT;
            const iz1 = h0.invZ + (h1.invZ - h0.invZ) * runEndT;
            results.push({
              x0Px: sx0,
              y0Px: sy0,
              z0: 1.0 / Math.max(iz0, 1e-7),
              x1Px: sx1,
              y1Px: sy1,
              z1: 1.0 / Math.max(iz1, 1e-7),
            });
          }
          inRun = false;
        }

        prevT = currT;
        prevScore = currScore;
      }

      if (inRun) {
        const sx0 = h0.xPx + (h1.xPx - h0.xPx) * runStartT;
        const sy0 = h0.yPx + (h1.yPx - h0.yPx) * runStartT;
        if (Math.hypot(h1.xPx - sx0, h1.yPx - sy0) >= minSegLenPx) {
          const iz0 = h0.invZ + (h1.invZ - h0.invZ) * runStartT;
          results.push({
            x0Px: sx0,
            y0Px: sy0,
            z0: 1.0 / Math.max(iz0, 1e-7),
            x1Px: h1.xPx,
            y1Px: h1.yPx,
            z1: 1.0 / Math.max(h1.invZ, 1e-7),
          });
        }
      }
    }
  }

  return results;
}

function insetPolygonScreen(poly: ScreenVertex[], insetPx: number): ScreenVertex[] {
  const n = poly.length;
  if (n < 3 || insetPx <= 0) return poly;

  let signedArea = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    signedArea += a.xPx * b.yPx - b.xPx * a.yPx;
  }
  if (Math.abs(signedArea) < 1.0) return [];

  const ccw = signedArea > 0;

  // Compute unit edge vectors, inward unit normals, and offset points for all edges
  const edgeDir: [number, number][] = [];
  const edgeNormal: [number, number][] = [];
  const edgeOffsetPoint: [number, number][] = [];

  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const dx = b.xPx - a.xPx;
    const dy = b.yPx - a.yPx;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      edgeDir.push([1, 0]);
      edgeNormal.push([0, 1]);
      edgeOffsetPoint.push([a.xPx, a.yPx]);
      continue;
    }
    const ux = dx / len;
    const uy = dy / len;
    edgeDir.push([ux, uy]);

    // Inward unit normal perpendicular to edge
    const nx = ccw ? -uy : uy;
    const ny = ccw ? ux : -ux;
    edgeNormal.push([nx, ny]);
    edgeOffsetPoint.push([a.xPx + nx * insetPx, a.yPx + ny * insetPx]);
  }

  const out: ScreenVertex[] = [];
  const maxMiter = insetPx * 2.8;

  for (let i = 0; i < n; i++) {
    const prevIdx = (i - 1 + n) % n;
    const currIdx = i;

    const p1 = edgeOffsetPoint[prevIdx];
    const d1 = edgeDir[prevIdx];
    const p2 = edgeOffsetPoint[currIdx];
    const d2 = edgeDir[currIdx];

    const det = d1[0] * d2[1] - d1[1] * d2[0];
    const v = poly[i];

    if (Math.abs(det) < 1e-4) {
      // Parallel or nearly collinear adjacent edges
      const nAvgX = (edgeNormal[prevIdx][0] + edgeNormal[currIdx][0]) * 0.5;
      const nAvgY = (edgeNormal[prevIdx][1] + edgeNormal[currIdx][1]) * 0.5;
      out.push({
        xPx: v.xPx + nAvgX * insetPx,
        yPx: v.yPx + nAvgY * insetPx,
        z: v.z,
        worldPos: v.worldPos,
        worldNormal: v.worldNormal,
      });
      continue;
    }

    const dpx = p2[0] - p1[0];
    const dpy = p2[1] - p1[1];
    const t = (dpx * d2[1] - dpy * d2[0]) / det;

    let qx = p1[0] + t * d1[0];
    let qy = p1[1] + t * d1[1];

    // Clamp extreme acute miter spikes
    const miterDist = Math.hypot(qx - v.xPx, qy - v.yPx);
    if (miterDist > maxMiter) {
      const nAvgX = (edgeNormal[prevIdx][0] + edgeNormal[currIdx][0]) * 0.5;
      const nAvgY = (edgeNormal[prevIdx][1] + edgeNormal[currIdx][1]) * 0.5;
      const nAvgLen = Math.hypot(nAvgX, nAvgY) || 1;
      qx = v.xPx + (nAvgX / nAvgLen) * maxMiter;
      qy = v.yPx + (nAvgY / nAvgLen) * maxMiter;
    }

    out.push({
      xPx: qx,
      yPx: qy,
      z: v.z,
      worldPos: v.worldPos,
      worldNormal: v.worldNormal,
    });
  }

  // Verify that the inset polygon didn't collapse or invert orientation
  let newArea = 0;
  for (let i = 0; i < out.length; i++) {
    const a = out[i];
    const b = out[(i + 1) % out.length];
    newArea += a.xPx * b.yPx - b.xPx * a.yPx;
  }

  // Polygon collapsed under the requested inset
  if ((ccw && newArea <= 2.0) || (!ccw && newArea >= -2.0)) {
    return [];
  }

  return out;
}

export function sampleCatmullRom2D(points: Vec2[], subdivisionsPerSegment = 12, closed = false): Vec2[] {
  if (points.length < 2) return points.slice();
  if (points.length === 2) return points.slice();

  const out: Vec2[] = [];
  const n = points.length;
  const count = closed ? n : n - 1;

  for (let i = 0; i < count; i++) {
    const p0 = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[closed ? (i + 2) % n : Math.min(n - 1, i + 2)];

    for (let s = 0; s < subdivisionsPerSegment; s++) {
      const t = s / subdivisionsPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      out.push([x, y]);
    }
  }

  if (!closed) {
    out.push(points[n - 1]);
  } else if (out.length > 0) {
    out.push([out[0][0], out[0][1]]);
  }

  return out;
}
