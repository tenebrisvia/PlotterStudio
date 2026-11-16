import { dist2 } from "./math.ts";
import type { Polyline2D, Vec2 } from "./types.ts";

export interface RawEmittedSubSegment {
  readonly x0Mm: number;
  readonly y0Mm: number;
  readonly x1Mm: number;
  readonly y1Mm: number;
  readonly tStart: number;
  readonly tEnd: number;
  readonly layerId: number;
  readonly lineId: number;
  readonly objectId: number;
}

/**
 * 1. Groups GPU-emitted sub-segments by `lineId`, sorts by `tStart`, and stitches contiguous
 *    sub-segments separated by less than `mergeGapMm` (eliminating pixel-step micro-gaps).
 */
export function stitchSubSegmentsByLineId(
  rawSegments: RawEmittedSubSegment[],
  mergeGapMm: number
): Polyline2D[] {
  if (rawSegments.length === 0) return [];

  const byLine = new Map<number, RawEmittedSubSegment[]>();
  for (const seg of rawSegments) {
    let list = byLine.get(seg.lineId);
    if (!list) {
      list = [];
      byLine.set(seg.lineId, list);
    }
    list.push(seg);
  }

  const polylines: Polyline2D[] = [];
  const gapSq = mergeGapMm * mergeGapMm;

  for (const list of byLine.values()) {
    list.sort((a, b) => a.tStart - b.tStart);

    let current: Polyline2D = [
      [list[0].x0Mm, list[0].y0Mm],
      [list[0].x1Mm, list[0].y1Mm],
    ];

    for (let i = 1; i < list.length; i++) {
      const seg = list[i];
      const lastPt = current[current.length - 1];
      const dx = seg.x0Mm - lastPt[0];
      const dy = seg.y0Mm - lastPt[1];
      const distSq = dx * dx + dy * dy;

      if (distSq <= gapSq) {
        // If collinear with previous segment, replace endpoint; otherwise append
        if (current.length >= 2 && isNearlyCollinear(current[current.length - 2], lastPt, [seg.x1Mm, seg.y1Mm])) {
          current[current.length - 1] = [seg.x1Mm, seg.y1Mm];
        } else {
          current.push([seg.x1Mm, seg.y1Mm]);
        }
      } else {
        if (polylineLengthMm(current) >= 0.08) {
          polylines.push(current);
        }
        current = [
          [seg.x0Mm, seg.y0Mm],
          [seg.x1Mm, seg.y1Mm],
        ];
      }
    }

    if (polylineLengthMm(current) >= 0.08) {
      polylines.push(current);
    }
  }

  return polylines;
}

function isNearlyCollinear(a: Vec2, b: Vec2, c: Vec2): boolean {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const vx = c[0] - b[0];
  const vy = c[1] - b[1];
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu < 1e-5 || lv < 1e-5) return true;
  const dot = (ux * vx + uy * vy) / (lu * lv);
  return dot > 0.9992;
}

/**
 * 2. Chains independent polylines whose endpoints meet within `snapToleranceMm`
 *    into continuous plotter strokes (reducing pen lifts at polygon corners).
 */
export function chainConnectedPolylines(
  polylines: Polyline2D[],
  snapToleranceMm = 0.22
): Polyline2D[] {
  if (polylines.length <= 1) return polylines;

  const cellSize = Math.max(0.5, snapToleranceMm * 2);
  const tolSq = snapToleranceMm * snapToleranceMm;
  const used = new Uint8Array(polylines.length);
  const working = polylines.map((p) => p.slice());

  interface EndpointRef {
    polyIdx: number;
    isEnd: boolean; // false = start, true = end
    pt: Vec2;
  }

  const grid = new Map<string, EndpointRef[]>();
  const cellKey = (x: number, y: number) => `${Math.floor(x / cellSize)}_${Math.floor(y / cellSize)}`;

  const addEndpoint = (ref: EndpointRef) => {
    const key = cellKey(ref.pt[0], ref.pt[1]);
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(ref);
  };

  for (let i = 0; i < working.length; i++) {
    const p = working[i];
    addEndpoint({ polyIdx: i, isEnd: false, pt: p[0] });
    addEndpoint({ polyIdx: i, isEnd: true, pt: p[p.length - 1] });
  }

  const findMatch = (pt: Vec2, excludeIdx: number): EndpointRef | null => {
    const cx = Math.floor(pt[0] / cellSize);
    const cy = Math.floor(pt[1] / cellSize);
    let best: EndpointRef | null = null;
    let bestD2 = tolSq;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx}_${cy + dy}`);
        if (!bucket) continue;
        for (const ref of bucket) {
          if (ref.polyIdx === excludeIdx || used[ref.polyIdx]) continue;
          const d2 = (ref.pt[0] - pt[0]) ** 2 + (ref.pt[1] - pt[1]) ** 2;
          if (d2 <= bestD2) {
            bestD2 = d2;
            best = ref;
          }
        }
      }
    }
    return best;
  };

  const result: Polyline2D[] = [];

  for (let i = 0; i < working.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let chain = working[i].slice();

    // Grow forward from tail
    while (true) {
      const tail = chain[chain.length - 1];
      const match = findMatch(tail, i);
      if (!match) break;
      used[match.polyIdx] = 1;
      const other = working[match.polyIdx];
      if (!match.isEnd) {
        for (let k = 1; k < other.length; k++) chain.push(other[k]);
      } else {
        for (let k = other.length - 2; k >= 0; k--) chain.push(other[k]);
      }
    }

    // Grow backward from head
    while (true) {
      const head = chain[0];
      const match = findMatch(head, i);
      if (!match) break;
      used[match.polyIdx] = 1;
      const other = working[match.polyIdx];
      const prefix: Polyline2D = [];
      if (match.isEnd) {
        for (let k = 0; k < other.length - 1; k++) prefix.push(other[k]);
      } else {
        for (let k = other.length - 1; k >= 1; k--) prefix.push(other[k]);
      }
      chain = prefix.concat(chain);
    }

    result.push(chain);
  }

  return result;
}

/**
 * 2b. Connects adjacent parallel hatch strokes separated by less than `maxJoinDistMm`
 *     into continuous serpentine / meander polylines (boustrophedon filling).
 *     Traces alternating ends to convert dozens of separate hatch strokes into one unbroken path.
 */
export function connectMeanderHatchPolylines(
  polylines: Polyline2D[],
  maxJoinDistMm: number
): Polyline2D[] {
  if (polylines.length <= 1 || maxJoinDistMm <= 0) return polylines;

  const maxDistSq = maxJoinDistMm * maxJoinDistMm;
  const cellSize = maxJoinDistMm;
  const cellKey = (x: number, y: number) =>
    `${Math.floor(x / cellSize)}_${Math.floor(y / cellSize)}`;

  const used = new Uint8Array(polylines.length);
  const result: Polyline2D[] = [];

  // Helper to test direction vector alignment of two strokes
  const strokeDir = (poly: Polyline2D): Vec2 => {
    const p0 = poly[0];
    const p1 = poly[poly.length - 1];
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  };

  const polyDirs = polylines.map(strokeDir);

  interface MeanderEndpoint {
    readonly polyIdx: number;
    readonly isTail: boolean;
    readonly pt: Vec2;
  }

  const grid = new Map<string, MeanderEndpoint[]>();
  const addEndpoint = (ep: MeanderEndpoint) => {
    const key = cellKey(ep.pt[0], ep.pt[1]);
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(ep);
  };

  for (let i = 0; i < polylines.length; i++) {
    const p = polylines[i];
    addEndpoint({ polyIdx: i, isTail: false, pt: p[0] });
    addEndpoint({ polyIdx: i, isTail: true, pt: p[p.length - 1] });
  }

  for (let i = 0; i < polylines.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let chain = polylines[i].slice();
    let currentDir = polyDirs[i];

    while (true) {
      const tail = chain[chain.length - 1];
      let bestIdx = -1;
      let bestReverse = false;
      let bestDistSq = maxDistSq;

      const cx = Math.floor(tail[0] / cellSize);
      const cy = Math.floor(tail[1] / cellSize);

      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(`${cx + dx}_${cy + dy}`);
          if (!bucket) continue;

          for (let k = 0; k < bucket.length; k++) {
            const ep = bucket[k];
            const j = ep.polyIdx;
            if (used[j]) continue;

            const dOther = polyDirs[j];
            const dot = Math.abs(currentDir[0] * dOther[0] + currentDir[1] * dOther[1]);
            if (dot < 0.85) continue; // Must be roughly parallel hatch lines

            const dSq = (ep.pt[0] - tail[0]) ** 2 + (ep.pt[1] - tail[1]) ** 2;
            if (dSq < bestDistSq) {
              bestDistSq = dSq;
              bestIdx = j;
              bestReverse = ep.isTail;
            }
          }
        }
      }

      if (bestIdx === -1) break;

      used[bestIdx] = 1;
      const other = bestReverse ? polylines[bestIdx].slice().reverse() : polylines[bestIdx];

      // Bridge endpoint of chain to start of next hatch line
      for (const pt of other) {
        chain.push(pt);
      }
      currentDir = strokeDir(other);
    }

    result.push(chain);
  }

  return result;
}

/**
 * 3. Ramer-Douglas-Peucker polyline simplification.
 */
export function simplifyPolylineRDP(pts: Polyline2D, toleranceMm: number): Polyline2D {
  if (pts.length <= 2 || toleranceMm <= 0) return pts;

  const sqTol = toleranceMm * toleranceMm;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;

  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    if (last <= first + 1) continue;

    let maxDistSq = 0;
    let index = first;
    const a = pts[first];
    const b = pts[last];

    for (let i = first + 1; i < last; i++) {
      const dSq = pointSegmentDistSq(pts[i], a, b);
      if (dSq > maxDistSq) {
        index = i;
        maxDistSq = dSq;
      }
    }

    if (maxDistSq > sqTol) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  const out: Polyline2D = [];
  for (let i = 0; i < pts.length; i++) {
    if (keep[i]) out.push(pts[i]);
  }
  return out;
}

function pointSegmentDistSq(p: Vec2, a: Vec2, b: Vec2): number {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;

  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }

  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

/**
 * 4. Optimizes pen-up travel order across polylines using Greedy Nearest-Neighbor
 *    (considering reversible polyline direction) + windowed 2-Opt local refinement.
 */
export function optimizePenTravelOrder(polylines: Polyline2D[]): Polyline2D[] {
  const n = polylines.length;
  if (n <= 1) return polylines.slice();

  // For small collections, direct search is faster without spatial index overhead
  if (n <= 64) {
    return optimizePenTravelOrderDirect(polylines);
  }

  // Compute bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = polylines[i];
    const h = p[0];
    const t = p[p.length - 1];
    if (h[0] < minX) minX = h[0];
    if (h[0] > maxX) maxX = h[0];
    if (h[1] < minY) minY = h[1];
    if (h[1] > maxY) maxY = h[1];
    if (t[0] < minX) minX = t[0];
    if (t[0] > maxX) maxX = t[0];
    if (t[1] < minY) minY = t[1];
    if (t[1] > maxY) maxY = t[1];
  }

  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const cellSize = Math.max(1.0, Math.sqrt((spanX * spanY) / n) * 1.5);
  const cellKey = (x: number, y: number) =>
    `${Math.floor(x / cellSize)}_${Math.floor(y / cellSize)}`;

  interface EndpointEntry {
    readonly polyIdx: number;
    readonly isTail: boolean;
    readonly pt: Vec2;
  }

  const grid = new Map<string, EndpointEntry[]>();
  const addEntry = (ep: EndpointEntry) => {
    const key = cellKey(ep.pt[0], ep.pt[1]);
    let bucket = grid.get(key);
    if (!bucket) {
      bucket = [];
      grid.set(key, bucket);
    }
    bucket.push(ep);
  };

  for (let i = 0; i < n; i++) {
    const p = polylines[i];
    addEntry({ polyIdx: i, isTail: false, pt: p[0] });
    addEntry({ polyIdx: i, isTail: true, pt: p[p.length - 1] });
  }

  const visited = new Uint8Array(n);
  const unvisited: number[] = new Array(n);
  const unvisitedPos = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    unvisited[i] = i;
    unvisitedPos[i] = i;
  }
  let unvisitedCount = n;

  const markVisited = (idx: number) => {
    visited[idx] = 1;
    const pos = unvisitedPos[idx];
    if (pos >= 0 && pos < unvisitedCount) {
      const lastIdx = unvisited[unvisitedCount - 1];
      unvisited[pos] = lastIdx;
      unvisitedPos[lastIdx] = pos;
      unvisitedPos[idx] = -1;
      unvisitedCount--;
    }
  };

  const ordered: Polyline2D[] = [];
  let curPos: Vec2 = [0, 0]; // Start from plotter origin (top-left (0, 0))

  for (let step = 0; step < n; step++) {
    let bestIdx = -1;
    let bestReverse = false;
    let bestDistSq = Infinity;

    const cx = Math.floor(curPos[0] / cellSize);
    const cy = Math.floor(curPos[1] / cellSize);

    // Expand search rings outwards
    const maxRings = 10;
    let foundInRing = false;

    for (let r = 0; r <= maxRings; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const bucket = grid.get(`${cx + dx}_${cy + dy}`);
          if (!bucket) continue;

          for (let k = 0; k < bucket.length; k++) {
            const ep = bucket[k];
            if (visited[ep.polyIdx]) continue;
            const dSq = (ep.pt[0] - curPos[0]) ** 2 + (ep.pt[1] - curPos[1]) ** 2;
            if (dSq < bestDistSq) {
              bestDistSq = dSq;
              bestIdx = ep.polyIdx;
              bestReverse = ep.isTail;
              foundInRing = true;
            }
          }
        }
      }

      if (foundInRing) {
        const nextRingDist = r * cellSize;
        if (bestDistSq <= nextRingDist * nextRingDist) {
          break;
        }
      }
    }

    // Fallback: if not found within maxRings, scan remaining unvisited items
    if (bestIdx === -1) {
      for (let k = 0; k < unvisitedCount; k++) {
        const i = unvisited[k];
        const poly = polylines[i];
        const head = poly[0];
        const tail = poly[poly.length - 1];

        const dHead = (head[0] - curPos[0]) ** 2 + (head[1] - curPos[1]) ** 2;
        if (dHead < bestDistSq) {
          bestDistSq = dHead;
          bestIdx = i;
          bestReverse = false;
        }

        const dTail = (tail[0] - curPos[0]) ** 2 + (tail[1] - curPos[1]) ** 2;
        if (dTail < bestDistSq) {
          bestDistSq = dTail;
          bestIdx = i;
          bestReverse = true;
        }
      }
    }

    markVisited(bestIdx);
    const chosen = bestReverse ? polylines[bestIdx].slice().reverse() : polylines[bestIdx];
    ordered.push(chosen);
    curPos = chosen[chosen.length - 1];
  }

  // Windowed 2-Opt refinement
  const windowSize = Math.min(48, n - 1);
  const passes = n <= 800 ? 2 : 1;
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < n - 2; i++) {
      const aEnd = ordered[i][ordered[i].length - 1];
      const bStart = ordered[i + 1][0];
      const maxJ = Math.min(n - 2, i + windowSize);

      for (let j = i + 2; j <= maxJ; j++) {
        const cEnd = ordered[j][ordered[j].length - 1];
        const dStart = ordered[j + 1][0];

        const curCost = dist2(aEnd, bStart) + dist2(cEnd, dStart);
        const newCost = dist2(aEnd, cEnd) + dist2(bStart, dStart);

        if (newCost + 1e-3 < curCost) {
          reversePolylineSubrange(ordered, i + 1, j);
          break;
        }
      }
    }
  }

  return ordered;
}

function optimizePenTravelOrderDirect(polylines: Polyline2D[]): Polyline2D[] {
  const n = polylines.length;
  const visited = new Uint8Array(n);
  const ordered: Polyline2D[] = [];
  let curPos: Vec2 = [0, 0];

  for (let step = 0; step < n; step++) {
    let bestIdx = -1;
    let bestReverse = false;
    let bestDistSq = Infinity;

    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      const poly = polylines[i];
      const head = poly[0];
      const tail = poly[poly.length - 1];

      const dHead = (head[0] - curPos[0]) ** 2 + (head[1] - curPos[1]) ** 2;
      if (dHead < bestDistSq) {
        bestDistSq = dHead;
        bestIdx = i;
        bestReverse = false;
      }

      const dTail = (tail[0] - curPos[0]) ** 2 + (tail[1] - curPos[1]) ** 2;
      if (dTail < bestDistSq) {
        bestDistSq = dTail;
        bestIdx = i;
        bestReverse = true;
      }
    }

    visited[bestIdx] = 1;
    const chosen = bestReverse ? polylines[bestIdx].slice().reverse() : polylines[bestIdx];
    ordered.push(chosen);
    curPos = chosen[chosen.length - 1];
  }

  const windowSize = Math.min(48, n - 1);
  for (let i = 0; i < n - 2; i++) {
    const aEnd = ordered[i][ordered[i].length - 1];
    const bStart = ordered[i + 1][0];
    const maxJ = Math.min(n - 2, i + windowSize);

    for (let j = i + 2; j <= maxJ; j++) {
      const cEnd = ordered[j][ordered[j].length - 1];
      const dStart = ordered[j + 1][0];

      const curCost = dist2(aEnd, bStart) + dist2(cEnd, dStart);
      const newCost = dist2(aEnd, cEnd) + dist2(bStart, dStart);

      if (newCost + 1e-3 < curCost) {
        reversePolylineSubrange(ordered, i + 1, j);
        break;
      }
    }
  }

  return ordered;
}

function reversePolylineSubrange(arr: Polyline2D[], left: number, right: number): void {
  let l = left;
  let r = right;
  while (l < r) {
    const tmp = arr[l].slice().reverse();
    arr[l] = arr[r].slice().reverse();
    arr[r] = tmp;
    l++;
    r--;
  }
  if (l === r) {
    arr[l] = arr[l].slice().reverse();
  }
}

export function polylineLengthMm(poly: Polyline2D): number {
  let sum = 0;
  for (let i = 1; i < poly.length; i++) {
    sum += dist2(poly[i - 1], poly[i]);
  }
  return sum;
}

export function computeTotalDrawLengthMm(polylines: Polyline2D[]): number {
  let sum = 0;
  for (const p of polylines) {
    sum += polylineLengthMm(p);
  }
  return sum;
}

export function computeTotalTravelLengthMm(polylines: Polyline2D[]): number {
  if (polylines.length === 0) return 0;
  let sum = dist2([0, 0], polylines[0][0]);
  for (let i = 1; i < polylines.length; i++) {
    const prevEnd = polylines[i - 1][polylines[i - 1].length - 1];
    const currStart = polylines[i][0];
    sum += dist2(prevEnd, currStart);
  }
  return sum;
}
