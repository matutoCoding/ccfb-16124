// 粒子平流计算管线：粒子限制在当前切片平面附近，沿物理速度推进。
// 粒子位置同时存 3D 世界坐标，渲染时投影到切片平面。
#include_common

struct ParticleUniforms {
  grid: GridUniforms,
  // x: dt(秒)；y: 粒子数；z: 切片轴；w: 切片位置
  params: vec4f,
  // xyz: 切片半厚度（粒子重投范围用），w: 速度下限（低于则重撒）
  extra: vec4f,
  seed: vec4f,
};

struct Particle {
  pos: vec4f,   // xyz 世界坐标，w=寿命(秒)
  seed: vec4f,  // x=随机种子
};

@group(0) @binding(0) var texU: texture_3d<f32>;
@group(0) @binding(1) var texV: texture_3d<f32>;
@group(0) @binding(2) var texW: texture_3d<f32>;
@group(0) @binding(3) var<uniform> uni: ParticleUniforms;
@group(0) @binding(4) var<storage, read_write> particles: array<Particle>;

fn rand1(seed: u32) -> f32 {
  var s = seed * 747796405u + 2891336453u;
  s = (s ^ (s >> 13u)) * 1274126177u;
  s = s ^ (s >> 16u);
  return f32(s % 100000u) / 100000.0;
}

fn respawn(idx: u32, r0: f32, r1: f32) -> vec3f {
  let g = uni.grid;
  let lo = g.origin.xyz;
  let hi = g.origin.xyz + g.spacing.xyz * (g.dims.xyz - 1.0);
  let axis = i32(uni.params.z);
  var p = mix(lo, hi, vec3f(r0, r1, rand1(idx * 97u + 7u)));
  // 锁到切片平面 ±半厚
  let half = uni.extra.x;
  if (axis == 0) { p.x = uni.params.w + (rand1(idx + 3u) - 0.5) * 2.0 * half; }
  if (axis == 1) { p.y = uni.params.w + (rand1(idx + 5u) - 0.5) * 2.0 * half; }
  if (axis == 2) { p.z = uni.params.w + (rand1(idx + 9u) - 0.5) * 2.0 * half; }
  return clamp(p, lo + 0.01, hi - 0.01);
}

fn setPos(pt_ptr: ptr<function, Particle>, p: vec3f) {
  (*(pt_ptr)).pos.x = p.x;
  (*(pt_ptr)).pos.y = p.y;
  (*(pt_ptr)).pos.z = p.z;
}

@compute @workgroup_size(64)
fn csMain(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= u32(uni.params.y)) { return; }
  var pt = particles[idx];
  let g = uni.grid;
  let lo = g.origin.xyz;
  let hi = g.origin.xyz + g.spacing.xyz * (g.dims.xyz - 1.0);

  let v0 = sampleVel(texU, texV, texW, uni.grid, pt.pos.xyz);
  let r0 = rand1(idx * 131u + 3u);
  let r1 = rand1(idx * 17u + 101u);

  // 死亡/无效/静止/出界 -> 重撒
  let dead = pt.pos.w <= 0.0;
  let outside = any(pt.pos.xyz < lo) || any(pt.pos.xyz > hi);
  if (dead || !validVel(v0) || length(v0) < uni.extra.w || outside) {
    setPos(&pt, respawn(idx, r0, r1));
    pt.pos.w = 4.0 + rand1(idx + 13u) * 6.0;
    pt.seed.x = f32(rand1(idx + 17u));
    particles[idx] = pt;
    return;
  }

  // 物理速度推进：子步长 ≤ 0.35 格距，保证轨迹贴场
  let spacing = min(min(g.spacing.x, g.spacing.y), g.spacing.z);
  let maxStep = spacing * 0.35;
  let travel = length(v0) * uni.params.x;
  let substeps = max(1.0, ceil(travel / maxStep));
  var pos = pt.pos.xyz;
  for (var s = 0; s < i32(substeps); s++) {
    let v = sampleVel(texU, texV, texW, uni.grid, pos);
    if (!validVel(v)) {
      setPos(&pt, respawn(idx, r0, r1));
      pt.pos.w = 4.0;
      particles[idx] = pt;
      return;
    }
    pos = pos + v * (uni.params.x / substeps);
  }

  // 粒子漂离切片平面太远则拉回（保持 2D 粒子密度稳定）
  let axis = i32(uni.params.z);
  let d = pos[axis] - uni.params.w;
  if (abs(d) > uni.extra.x * 2.0) {
    pos[axis] = uni.params.w;
  }

  setPos(&pt, pos);
  pt.pos.w = pt.pos.w - uni.params.x;
  particles[idx] = pt;
}
