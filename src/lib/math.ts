import type { Mat4, Vec2, Vec3 } from "./types.ts";

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return [x, y, z];
}

export function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function len3(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize3(a: Vec3): Vec3 {
  const l = len3(a);
  return l > 1e-8 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}

export function dist2(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function mat4Identity(): Mat4 {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] =
        a[0 * 4 + row] * b[col * 4 + 0] +
        a[1 * 4 + row] * b[col * 4 + 1] +
        a[2 * 4 + row] * b[col * 4 + 2] +
        a[3 * 4 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

export function mat4LookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Mat4 {
  const zAxis = normalize3(sub3(eye, target)); // camera looks along -Z
  let xAxis = cross3(up, zAxis);
  if (len3(xAxis) < 1e-6) {
    xAxis = cross3([0, 0, 1], zAxis);
  }
  xAxis = normalize3(xAxis);
  const yAxis = cross3(zAxis, xAxis);

  const out = new Float32Array(16);
  out[0] = xAxis[0];
  out[1] = yAxis[0];
  out[2] = zAxis[0];
  out[3] = 0;

  out[4] = xAxis[1];
  out[5] = yAxis[1];
  out[6] = zAxis[1];
  out[7] = 0;

  out[8] = xAxis[2];
  out[9] = yAxis[2];
  out[10] = zAxis[2];
  out[11] = 0;

  out[12] = -dot3(xAxis, eye);
  out[13] = -dot3(yAxis, eye);
  out[14] = -dot3(zAxis, eye);
  out[15] = 1;
  return out;
}

/**
 * WebGPU right-handed perspective matrix mapping view-space Z in [-near, -far] to clip Z in [0, w].
 */
export function mat4PerspectiveZO(fovRad: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1.0 / Math.tan(fovRad * 0.5);
  const rangeInv = 1.0 / (near - far);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = far * rangeInv;
  out[11] = -1;
  out[14] = near * far * rangeInv;
  return out;
}

/**
 * WebGPU orthographic matrix mapping Z in [-near, -far] to [0, 1].
 */
export function mat4OrthoZO(
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number
): Mat4 {
  const out = new Float32Array(16);
  out[0] = 2 / (right - left);
  out[5] = 2 / (top - bottom);
  out[10] = 1 / (near - far);
  out[12] = -(right + left) / (right - left);
  out[13] = -(top + bottom) / (top - bottom);
  out[14] = near / (near - far);
  out[15] = 1;
  return out;
}

export function mat4FromTRS(
  translation: Vec3 = [0, 0, 0],
  rotationEulerRad: Vec3 = [0, 0, 0],
  scale: Vec3 = [1, 1, 1]
): Mat4 {
  const [rx, ry, rz] = rotationEulerRad;
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);

  // ZYX Euler rotation
  const r00 = cy * cz;
  const r01 = cz * sx * sy - cx * sz;
  const r02 = cx * cz * sy + sx * sz;

  const r10 = cy * sz;
  const r11 = cx * cz + sx * sy * sz;
  const r12 = -cz * sx + cx * sy * sz;

  const r20 = -sy;
  const r21 = cy * sx;
  const r22 = cx * cy;

  const out = new Float32Array(16);
  out[0] = r00 * scale[0];
  out[1] = r10 * scale[0];
  out[2] = r20 * scale[0];
  out[3] = 0;

  out[4] = r01 * scale[1];
  out[5] = r11 * scale[1];
  out[6] = r21 * scale[1];
  out[7] = 0;

  out[8] = r02 * scale[2];
  out[9] = r12 * scale[2];
  out[10] = r22 * scale[2];
  out[11] = 0;

  out[12] = translation[0];
  out[13] = translation[1];
  out[14] = translation[2];
  out[15] = 1;
  return out;
}

export function transformPointMat4(p: Vec3, m: Mat4): Vec3 {
  const x = p[0], y = p[1], z = p[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1.0;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

export function transformDirectionMat4(d: Vec3, m: Mat4): Vec3 {
  const x = d[0], y = d[1], z = d[2];
  return normalize3([
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ]);
}

export function transformVec4Mat4(p: Vec3, m: Mat4): [number, number, number, number] {
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

/**
 * Clips a 3D segment in camera view space against the near plane (z <= -near).
 */
export function clipViewSegmentNear(
  v0: Vec3,
  v1: Vec3,
  near: number
): [Vec3, Vec3] | null {
  const zLimit = -near;
  const d0 = v0[2] - zLimit; // <= 0 means in front of near plane
  const d1 = v1[2] - zLimit;

  if (d0 > 0 && d1 > 0) {
    return null;
  }
  if (d0 <= 0 && d1 <= 0) {
    return [v0, v1];
  }
  const t = d0 / (d0 - d1);
  const hit: Vec3 = [
    v0[0] + (v1[0] - v0[0]) * t,
    v0[1] + (v1[1] - v0[1]) * t,
    zLimit,
  ];
  return d0 > 0 ? [hit, v1] : [v0, hit];
}

/**
 * Simple ear-clipping triangulation for 2D polygons.
 * Returns array of triangle index triplets [i0, i1, i2].
 */
export function triangulatePolygon2D(points: Vec2[]): [number, number, number][] {
  const n = points.length;
  if (n < 3) return [];
  if (n === 3) return [[0, 1, 2]];

  // Signed area to detect winding
  let area = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    area += p[0] * q[1] - q[0] * p[1];
  }

  const indices: number[] = [];
  if (area >= 0) {
    for (let i = 0; i < n; i++) indices.push(i);
  } else {
    for (let i = n - 1; i >= 0; i--) indices.push(i);
  }

  const triangles: [number, number, number][] = [];
  let count = indices.length;
  let guard = 0;

  const isEar = (u: number, v: number, w: number): boolean => {
    const a = points[indices[u]];
    const b = points[indices[v]];
    const c = points[indices[w]];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (cross <= 1e-7) return false;

    for (let p = 0; p < count; p++) {
      if (p === u || p === v || p === w) continue;
      const pt = points[indices[p]];
      if (pointInTriangle2D(pt, a, b, c)) return false;
    }
    return true;
  };

  let v = count - 1;
  while (count > 2 && guard < 4 * n * n) {
    guard++;
    const u = v >= count ? 0 : v;
    v = u + 1 >= count ? 0 : u + 1;
    const w = v + 1 >= count ? 0 : v + 1;

    if (isEar(u, v, w)) {
      triangles.push([indices[u], indices[v], indices[w]]);
      indices.splice(v, 1);
      count--;
      guard = 0;
    }
  }

  // If ear-clipping stalled before consuming all vertices (e.g. collinear points or self-intersection),
  // fan-triangulate the remaining polygon loop so no missing holes are left in the mesh
  if (count > 2) {
    for (let i = 1; i < count - 1; i++) {
      triangles.push([indices[0], indices[i], indices[i + 1]]);
    }
  }

  return triangles;
}

export function pointInTriangle2D(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
  const c1 = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const c2 = (c[0] - b[0]) * (p[1] - b[1]) - (c[1] - b[1]) * (p[0] - b[0]);
  const c3 = (a[0] - c[0]) * (p[1] - c[1]) - (a[1] - c[1]) * (p[0] - c[0]);
  const hasNeg = c1 < -1e-6 || c2 < -1e-6 || c3 < -1e-6;
  const hasPos = c1 > 1e-6 || c2 > 1e-6 || c3 > 1e-6;
  return !(hasNeg && hasPos);
}
