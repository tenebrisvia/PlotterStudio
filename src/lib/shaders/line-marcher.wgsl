struct MarchParams {
  resolution: vec2f,
  paperSizeMm: vec2f,
  stepSizePx: f32,
  depthBias: f32,
  edgeSearchRadiusPx: f32,
  segmentCount: u32,
  maxOutSegments: u32,
}

struct CandidateSegment {
  // (x0_px, y0_px, linearZ0, faceId0)
  p0_f0: vec4f,
  // (x1_px, y1_px, linearZ1, faceId1)
  p1_f1: vec4f,
  // (objectId, layerId, lineId, flags)
  // flags bit 0 (1u): clipToObjectId (only visible where gbuffer.r == f32(objectId))
  // flags bit 2 (4u): edge / silhouette line (use orthogonal neighborhood search)
  // flags bit 3 (8u): ignore depth occlusion (always visible unless outside clip mask)
  attrs: vec4u,
}

struct EmittedSegment {
  // (x0_mm, y0_mm, x1_mm, y1_mm)
  coords: vec4f,
  // (tStart, tEnd, 0.0, 0.0)
  trange: vec4f,
  // (layerId, lineId, objectId, 0u)
  attrs: vec4u,
}

struct CounterBuffer {
  count: atomic<u32>,
}

@group(0) @binding(0) var<uniform> params: MarchParams;
@group(0) @binding(1) var gbuffer: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> candidates: array<CandidateSegment>;
@group(0) @binding(3) var<storage, read_write> outSegments: array<EmittedSegment>;
@group(0) @binding(4) var<storage, read_write> counter: CounterBuffer;

fn perspectiveCorrectZ(z0: f32, z1: f32, t: f32) -> f32 {
  let safeZ0 = max(z0, 0.0001);
  let safeZ1 = max(z1, 0.0001);
  let invZ = mix(1.0 / safeZ0, 1.0 / safeZ1, t);
  return 1.0 / max(invZ, 1e-7);
}

fn testSampleVisible(
  texCoord: vec2i,
  lineZ: f32,
  faceId0: f32,
  faceId1: f32,
  objectId: f32,
  flags: u32
) -> bool {
  let resI = vec2i(params.resolution);
  if (texCoord.x < 0 || texCoord.y < 0 || texCoord.x >= resI.x || texCoord.y >= resI.y) {
    return false;
  }

  let sample = textureLoad(gbuffer, texCoord, 0);
  let sampleObjId = sample.r;
  let sampleFaceId = sample.g;
  let sampleSlope = clamp(sample.b, 0.05, 1.0);
  let sampleZ = sample.a;

  // Positive clip mask mode: only visible where the G-Buffer has the target objectId
  if ((flags & 1u) != 0u) {
    return sampleFaceId > 0.5 && abs(sampleObjId - objectId) < 0.25;
  }

  // Unoccluded overlay mode or empty background pixel (no occluding face at this texel)
  if ((flags & 8u) != 0u || sampleFaceId < 0.5) {
    return true;
  }

  // If the pixel belongs to either of the segment's owning faces, it is visible!
  if (faceId0 > 0.0 && abs(sampleFaceId - faceId0) < 0.25) {
    return true;
  }
  if (faceId1 > 0.0 && abs(sampleFaceId - faceId1) < 0.25) {
    return true;
  }

  // Slope-scaled linear depth tolerance
  let adaptiveBias = params.depthBias / sampleSlope;
  return lineZ <= sampleZ + adaptiveBias;
}

fn isPointVisible(
  t: f32,
  p0: vec2f,
  p1: vec2f,
  z0: f32,
  z1: f32,
  faceId0: f32,
  faceId1: f32,
  objectId: f32,
  orthoDir: vec2f,
  flags: u32
) -> bool {
  let posPx = mix(p0, p1, t);
  if (posPx.x < 0.0 || posPx.y < 0.0 || posPx.x >= params.resolution.x || posPx.y >= params.resolution.y) {
    return false;
  }

  let lineZ = perspectiveCorrectZ(z0, z1, t);
  let centerCoord = vec2i(floor(posPx));

  if (testSampleVisible(centerCoord, lineZ, faceId0, faceId1, objectId, flags)) {
    return true;
  }

  // For mesh/polygon edges or positive clip boundaries, check orthogonal neighbors
  // just like Gábor Ugray's `pt + orto` and `pt - orto` test so silhouette & shared edges remain crisp.
  if ((flags & 4u) != 0u && params.edgeSearchRadiusPx > 0.0) {
    let offset = orthoDir * params.edgeSearchRadiusPx;
    let leftCoord = vec2i(floor(posPx + offset));
    if (testSampleVisible(leftCoord, lineZ, faceId0, faceId1, objectId, flags)) {
      return true;
    }
    let rightCoord = vec2i(floor(posPx - offset));
    if (testSampleVisible(rightCoord, lineZ, faceId0, faceId1, objectId, flags)) {
      return true;
    }
  }

  return false;
}

fn refineTransition(
  tA: f32,
  tB: f32,
  visA: bool,
  p0: vec2f,
  p1: vec2f,
  z0: f32,
  z1: f32,
  faceId0: f32,
  faceId1: f32,
  objectId: f32,
  orthoDir: vec2f,
  flags: u32
) -> f32 {
  var lo = tA;
  var hi = tB;
  for (var iter = 0u; iter < 5u; iter = iter + 1u) {
    let mid = 0.5 * (lo + hi);
    let visMid = isPointVisible(mid, p0, p1, z0, z1, faceId0, faceId1, objectId, orthoDir, flags);
    if (visMid == visA) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  // Return the visible side of the boundary
  if (visA) {
    return lo;
  }
  return hi;
}

fn emitSubSegment(
  tStart: f32,
  tEnd: f32,
  p0: vec2f,
  p1: vec2f,
  attrs: vec4u
) {
  let span = tEnd - tStart;
  if (span <= 1e-5) {
    return;
  }

  let startPx = mix(p0, p1, tStart);
  let endPx = mix(p0, p1, tEnd);

  let diffPx = endPx - startPx;
  if (dot(diffPx, diffPx) < 0.04) {
    return;
  }

  let scaleToMm = params.paperSizeMm / params.resolution;
  let startMm = startPx * scaleToMm;
  let endMm = endPx * scaleToMm;

  let outIdx = atomicAdd(&counter.count, 1u);
  if (outIdx < params.maxOutSegments) {
    outSegments[outIdx] = EmittedSegment(
      vec4f(startMm.x, startMm.y, endMm.x, endMm.y),
      vec4f(tStart, tEnd, 0.0, 0.0),
      vec4u(attrs.y, attrs.z, attrs.x, 0u)
    );
  }
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= params.segmentCount) {
    return;
  }

  let seg = candidates[idx];
  let p0 = seg.p0_f0.xy;
  let z0 = seg.p0_f0.z;
  let faceId0 = seg.p0_f0.w;

  let p1 = seg.p1_f1.xy;
  let z1 = seg.p1_f1.z;
  let faceId1 = seg.p1_f1.w;

  let objectId = f32(seg.attrs.x);
  let flags = seg.attrs.w;

  let delta = p1 - p0;
  let lineLenPx = length(delta);
  if (lineLenPx < 0.25) {
    return;
  }

  let dir = delta / lineLenPx;
  let orthoDir = vec2f(-dir.y, dir.x);

  let stepPx = max(params.stepSizePx, 0.5);
  let numSteps = clamp(u32(ceil(lineLenPx / stepPx)), 2u, 4096u);
  let invSteps = 1.0 / f32(numSteps);

  var inVisibleRun = false;
  var runStartT = 0.0;
  var prevT = 0.0;
  var prevVis = isPointVisible(0.0, p0, p1, z0, z1, faceId0, faceId1, objectId, orthoDir, flags);

  if (prevVis) {
    inVisibleRun = true;
    runStartT = 0.0;
  }

  for (var step = 1u; step <= numSteps; step = step + 1u) {
    let currT = f32(step) * invSteps;
    let currVis = isPointVisible(currT, p0, p1, z0, z1, faceId0, faceId1, objectId, orthoDir, flags);

    if (currVis && !prevVis) {
      // Transition: occluded -> visible
      runStartT = refineTransition(prevT, currT, false, p0, p1, z0, z1, faceId0, faceId1, objectId, orthoDir, flags);
      inVisibleRun = true;
    } else if (!currVis && prevVis) {
      // Transition: visible -> occluded
      let runEndT = refineTransition(prevT, currT, true, p0, p1, z0, z1, faceId0, faceId1, objectId, orthoDir, flags);
      emitSubSegment(runStartT, runEndT, p0, p1, seg.attrs);
      inVisibleRun = false;
    }

    prevT = currT;
    prevVis = currVis;
  }

  if (inVisibleRun) {
    emitSubSegment(runStartT, 1.0, p0, p1, seg.attrs);
  }
}
