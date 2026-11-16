struct PreviewParams {
  resolution: vec2u,
  minZ: f32,
  maxZ: f32,
  lightDir: vec3f,
  _pad: f32,
}

@group(0) @binding(0) var<uniform> params: PreviewParams;
@group(0) @binding(1) var gbuffer: texture_2d<f32>;

@fragment
fn fs_main(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let coords = vec2i(floor(pos.xy));
  let center = textureLoad(gbuffer, coords, 0);

  let objId = center.x;
  let faceId = center.y;
  let slope = center.z;
  let z = center.w;

  if (faceId <= 0.5 || objId < 0.0 || z > 1e6) {
    // Warm off-white paper background (or negative erase mask cutout)
    return vec4f(250.0 / 255.0, 248.0 / 255.0, 245.0 / 255.0, 1.0);
  }

  let dims = vec2i(params.resolution);
  let xL = max(0, coords.x - 1);
  let xR = min(dims.x - 1, coords.x + 1);
  let yU = max(0, coords.y - 1);
  let yD = min(dims.y - 1, coords.y + 1);

  let sL = textureLoad(gbuffer, vec2i(xL, coords.y), 0);
  let sR = textureLoad(gbuffer, vec2i(xR, coords.y), 0);
  let sU = textureLoad(gbuffer, vec2i(coords.x, yU), 0);
  let sD = textureLoad(gbuffer, vec2i(coords.x, yD), 0);

  let zL = select(z, sL.w, sL.y == faceId);
  let zR = select(z, sR.w, sR.y == faceId);
  let zU = select(z, sU.w, sU.y == faceId);
  let zD = select(z, sD.w, sD.y == faceId);

  let dzdx = (zR - zL) * 0.5;
  let dzdy = (zD - zU) * 0.5;
  let gradMag = length(vec2f(dzdx, dzdy));

  let zSpan = max(0.001, params.maxZ - params.minZ);
  let depthNorm = clamp((z - params.minZ) / zSpan, 0.0, 1.0);

  var luma: f32;

  if (gradMag > 1e-5 || slope < 0.999) {
    // 3D surface: reconstruct view-space unit normal from depth gradient
    let pixelWorldScale = max(0.002, (z * 0.85) / f32(dims.x));
    let nx = dzdx / pixelWorldScale;
    let ny = -dzdy / pixelWorldScale;
    let nz = 1.0;
    let normal = normalize(vec3f(nx, ny, nz));

    let keyDiffuse = max(0.0, dot(normal, params.lightDir));
    let fillDir = normalize(vec3f(-0.4, 0.3, 0.86));
    let fillDiffuse = max(0.0, dot(normal, fillDir));
    let depthAtten = 1.0 - depthNorm * 0.28;

    luma = (0.24 + 0.58 * keyDiffuse + 0.18 * fillDiffuse) * depthAtten;
  } else {
    // 2D flat shape: clean depth-ordered tonal layering
    let objEdge = (sL.x != objId) || (sR.x != objId) || (sU.x != objId) || (sD.x != objId);
    let baseTone = 0.28 + 0.58 * depthNorm;
    if (objEdge) {
      luma = max(0.12, baseTone - 0.18);
    } else {
      luma = baseTone;
    }
  }

  let clamped = clamp(luma, 0.08, 0.94);
  return vec4f(
    (clamped * 242.0) / 255.0,
    (clamped * 240.0) / 255.0,
    (clamped * 235.0) / 255.0,
    1.0
  );
}
