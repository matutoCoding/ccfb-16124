// 切片 LIC 离屏渲染（全屏三角形 -> LIC 纹理）
#include_common

struct SliceUniforms {
  grid: GridUniforms,
  // xy: 纹理像素数；z: 切片轴 0=x 1=y 2=z；w: 颜色模式 0=速度 1=垂直分量
  params: vec4f,
  // x: 切片位置(米)；y: 弧长步长(米)；z: kernel 长度(浮点转 i32)；w: 动画相位
  slice: vec4f,
  // x: 速度量程上限；y: seed；z: 参考层高亮 0/1；w: 参考层标高
  colorCfg: vec4f,
};

@group(0) @binding(0) var texU: texture_3d<f32>;
@group(0) @binding(1) var texV: texture_3d<f32>;
@group(0) @binding(2) var texW: texture_3d<f32>;
@group(0) @binding(3) var texT: texture_3d<f32>;
@group(0) @binding(4) var<uniform> uni: SliceUniforms;

struct VSOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vsMain(@builtin(vertex_index) vi: u32) -> VSOut {
  // 单个全屏三角形
  var out: VSOut;
  let pos = array<vec2f, 3>(
    vec2f(-1.0, -3.0), vec2f(3.0, 1.0), vec2f(-1.0, 3.0),
  );
  out.clip = vec4f(pos[vi], 0.0, 1.0);
  out.uv = vec2f((pos[vi].x + 1.0) * 0.5, (pos[vi].y + 1.0) * 0.5);
  return out;
}

// uv -> 切片平面上的世界坐标（切片轴以外的两个轴覆盖整个网格范围）
fn slicePoint(uv: vec2f) -> vec3f {
  let g = uni.grid;
  let axis = i32(uni.params.z);
  let lo = g.origin.xyz;
  let hi = g.origin.xyz + g.spacing.xyz * (g.dims.xyz - 1.0);
  var p = vec3f(0.0);
  if (axis == 0) {
    p = vec3f(uni.slice.x, mix(lo.y, hi.y, uv.y), mix(lo.z, hi.z, uv.x));
  } else if (axis == 1) {
    p = vec3f(mix(lo.x, hi.x, uv.x), uni.slice.x, mix(lo.z, hi.z, uv.y));
  } else {
    p = vec3f(mix(lo.x, hi.x, uv.x), mix(lo.y, hi.y, uv.y), uni.slice.x);
  }
  return p;
}

@fragment
fn fsMain(in: VSOut) -> @location(0) vec4f {
  let p = slicePoint(in.uv);
  let v = sampleVel(texU, texV, texW, uni.grid, p);
  if (!validVel(v)) {
    return vec4f(0.06, 0.06, 0.08, 1.0); // 缺测/固体区
  }
  let speed = length(v);
  let lic = licValue(
    texU, texV, texW, uni.grid, p,
    uni.slice.y, i32(uni.slice.z), uni.slice.w, i32(uni.colorCfg.y),
  );

  var t01: f32;
  if (i32(uni.params.w) == 1) {
    // 垂直分量：0..量程 对称映射（蓝=下沉，红=上洗），中值 0.5
    t01 = clamp(0.5 + v.z / (2.0 * uni.colorCfg.x), 0.0, 1.0);
  } else {
    t01 = clamp(speed / uni.colorCfg.x, 0.0, 1.0);
  }
  let base = ramp(t01);
  // LIC 调制：在色带上叠加明暗流线纹理
  var col = base * (0.45 + 0.75 * lic);

  // 参考层标高线（z 切片且开启时画水平参考网格）
  if (uni.colorCfg.z > 0.5 && i32(uni.params.z) == 2
      && abs(p.z - uni.colorCfg.w) < uni.grid.spacing.z * 0.25) {
    col = mix(col, vec3f(1.0), 0.55);
  }
  return vec4f(col, 1.0);
}
