// WGSL 公共函数：与 src/domain/grid.ts、src/domain/lic.ts 逐式同构。
// 任何一处修改积分/采样公式，两处必须同步（单元测试只覆盖 TS 侧）。

// 无效值哨兵（FLT_MAX）：替代部分 WGSL 版本不支持的 nan()，validVel 统一识别
const INVALID: f32 = 3.4028235e38;

struct GridUniforms {
  origin: vec4f,    // xyz 网格原点，w 未用
  spacing: vec4f,   // xyz 网格间距，w 未用
  dims: vec4f,      // x=nx y=ny z=nz，w 未用
};

// 手工三线性采样单个分量，不依赖 float32-filterable 特性。
// NaN/Inf 角点按权重归一化剔除，与 TS sampleComponent 同构。
fn sampleComp(tex: texture_3d<f32>, gu: GridUniforms, p: vec3f) -> f32 {
  let fc = (p - gu.origin.xyz) / gu.spacing.xyz;
  if (fc.x < 0.0 || fc.y < 0.0 || fc.z < 0.0 ||
      fc.x > gu.dims.x - 1.0 || fc.y > gu.dims.y - 1.0 || fc.z > gu.dims.z - 1.0) {
    return INVALID; // 越界哨兵（调用方按无效处理）
  }
  let i0 = i32(floor(fc.x));
  let j0 = i32(floor(fc.y));
  let k0 = i32(floor(fc.z));
  let i1 = min(i0 + 1, i32(gu.dims.x) - 1);
  let j1 = min(j0 + 1, i32(gu.dims.y) - 1);
  let k1 = min(k0 + 1, i32(gu.dims.z) - 1);
  let t = fc - vec3f(f32(i0), f32(j0), f32(k0));

  let c000 = textureLoad(tex, vec3i(i0, j0, k0), 0).x;
  let c100 = textureLoad(tex, vec3i(i1, j0, k0), 0).x;
  let c010 = textureLoad(tex, vec3i(i0, j1, k0), 0).x;
  let c110 = textureLoad(tex, vec3i(i1, j1, k0), 0).x;
  let c001 = textureLoad(tex, vec3i(i0, j0, k1), 0).x;
  let c101 = textureLoad(tex, vec3i(i1, j0, k1), 0).x;
  let c011 = textureLoad(tex, vec3i(i0, j1, k1), 0).x;
  let c111 = textureLoad(tex, vec3i(i1, j1, k1), 0).x;

  let wx0 = 1.0 - t.x; let wy0 = 1.0 - t.y; let wz0 = 1.0 - t.z;
  let wts = array<f32, 8>(
    wx0 * wy0 * wz0, t.x * wy0 * wz0,
    wx0 * t.y * wz0, t.x * t.y * wz0,
    wx0 * wy0 * t.z, t.x * wy0 * t.z,
    wx0 * t.y * t.z, t.x * t.y * t.z,
  );
  let corners = array<f32, 8>(c000, c100, c010, c110, c001, c101, c011, c111);
  var sum = 0.0;
  var wsum = 0.0;
  for (var n = 0; n < 8; n++) {
    let v = corners[n];
    // NaN 的定义性质：NaN != NaN；同时排除 Inf 与哨兵。兼容所有 WGSL 版本
    let finite = (v == v) && (v < 3.4e38) && (v > -3.4e38);
    if (finite) {
      sum += v * wts[n];
      wsum += wts[n];
    }
  }
  if (wsum <= 0.0) { return INVALID; }
  return sum / wsum;
}

fn sampleVel(texU: texture_3d<f32>, texV: texture_3d<f32>, texW: texture_3d<f32>,
             gu: GridUniforms, p: vec3f) -> vec3f {
  return vec3f(
    sampleComp(texU, gu, p),
    sampleComp(texV, gu, p),
    sampleComp(texW, gu, p),
  );
}

fn validVel(v: vec3f) -> bool {
  // 分量有限：非 NaN（NaN != NaN）、非 Inf、非哨兵
  for (var i = 0; i < 3; i++) {
    let x = v[i];
    if (x != x || x >= 3.4e38 || x <= -3.4e38) { return false; }
  }
  return true;
}

fn invalidVec() -> vec3f {
  return vec3f(INVALID, INVALID, INVALID);
}

fn unitVel(v: vec3f) -> vec3f {
  let len = length(v);
  if (len < 1e-9) { return invalidVec(); }
  return v / len;
}

// 弧长参数化 RK4，与 TS rk4Step 同式：k1..k4 均为归一化单位矢量。
// dir=+1 顺流，-1 逆流；step 为弧长（米）。
fn rk4(texU: texture_3d<f32>, texV: texture_3d<f32>, texW: texture_3d<f32>,
       gu: GridUniforms, p0: vec3f, step: f32, dir: f32) -> vec3f {
  let h = step * dir;
  let k1 = unitVel(sampleVel(texU, texV, texW, gu, p0));
  if (!validVel(k1)) { return invalidVec(); }
  let k2 = unitVel(sampleVel(texU, texV, texW, gu, p0 + k1 * (h * 0.5)));
  if (!validVel(k2)) { return invalidVec(); }
  let k3 = unitVel(sampleVel(texU, texV, texW, gu, p0 + k2 * (h * 0.5)));
  if (!validVel(k3)) { return invalidVec(); }
  let k4 = unitVel(sampleVel(texU, texV, texW, gu, p0 + k3 * h));
  if (!validVel(k4)) { return invalidVec(); }
  return p0 + (h / 6.0) * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
}

// 与 TS hashNoise 位级一致：u32 环绕乘法模拟 Math.imul。
fn hashNoise(ix: i32, iy: i32, iz: i32, seed: i32) -> f32 {
  var h: u32 = bitcast<u32>(seed)
    + (bitcast<u32>(ix) * 374761393u)
    + (bitcast<u32>(iy) * 668265263u)
    + (bitcast<u32>(iz) * 2147483647u);
  h = (h ^ (h >> 13u)) * 1274126177u;
  h = h ^ (h >> 16u);
  return f32(h % 10000u) / 10000.0;
}

// 与 TS noiseAt 同式（NOISE_SCALE 两侧共用 4.0）。
fn noiseAt(p: vec3f, phase: f32, seed: i32) -> f32 {
  return hashNoise(
    i32(floor(p.x * 4.0 + phase)),
    i32(floor(p.y * 4.0 + phase)),
    i32(floor(p.z * 4.0)),
    seed,
  );
}

// 单像素 LIC：沿单位速度流线前后各 kernelLength 步平均白噪声。
// phase 随时间推进，纹理沿流向滚动，滚动方向即流线方向。
fn licValue(texU: texture_3d<f32>, texV: texture_3d<f32>, texW: texture_3d<f32>,
            gu: GridUniforms, p: vec3f, step: f32, kernelLength: i32,
            phase: f32, seed: i32) -> f32 {
  var acc = noiseAt(p, phase, seed);
  var weight = 1.0;
  var pf = p;
  for (var s = 1; s <= kernelLength; s++) {
    pf = rk4(texU, texV, texW, gu, pf, step, 1.0);
    if (!validVel(pf)) { break; }
    acc += noiseAt(pf, phase - f32(s), seed);
    weight += 1.0;
  }
  var pb = p;
  for (var s = 1; s <= kernelLength; s++) {
    pb = rk4(texU, texV, texW, gu, pb, step, -1.0);
    if (!validVel(pb)) { break; }
    acc += noiseAt(pb, phase + f32(s), seed);
    weight += 1.0;
  }
  return acc / weight;
}

// 蓝 -> 青 -> 绿 -> 黄 -> 红 色带
fn ramp(t01: f32) -> vec3f {
  let x = clamp(t01, 0.0, 1.0);
  let stops = array<vec3f, 5>(
    vec3f(0.08, 0.25, 0.75),
    vec3f(0.10, 0.70, 0.85),
    vec3f(0.20, 0.75, 0.35),
    vec3f(0.95, 0.80, 0.20),
    vec3f(0.85, 0.15, 0.15),
  );
  let seg = clamp(x * 4.0, 0.0, 3.999);
  let i = i32(seg);
  let f = seg - f32(i);
  return mix(stops[i], stops[i + 1], f);
}
