struct GBufferVertex {
  clipPos: vec4f,
  // attrs: (objectId, faceId, slope, linearZ)
  attrs: vec4f,
}

@group(0) @binding(0) var<storage, read> vertices: array<GBufferVertex>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) ids_slope: vec3f,
  @location(1) linearZ: f32,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  let v = vertices[vi];
  var out: VertexOutput;
  out.position = v.clipPos;
  out.ids_slope = v.attrs.xyz;
  out.linearZ = v.attrs.w;
  return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
  // r = objectId, g = faceId, b = surface slope, a = perspective-correct linearZ
  return vec4f(in.ids_slope.x, in.ids_slope.y, in.ids_slope.z, in.linearZ);
}
