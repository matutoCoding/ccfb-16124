// 3D 场景着色器：平台体块、等温面、粒子、航线、甲板圆盘共用一套相机 uniform。

struct Camera {
  viewProj: mat4x4f,
  eye: vec4f,
  right: vec4f,  // xyz 相机右方向
  up: vec4f,     // xyz 相机上方向
};

struct BoxData {
  min: vec4f,
  max: vec4f,
  color: vec4f,
};

struct SceneUniforms {
  cam: Camera,
  // x: 点精灵尺寸(米)；y/z/w 预留
  misc: vec4f,
};

// ---------- 平台体块（立方体实例化） ----------
@group(0) @binding(0) var<uniform> scene: SceneUniforms;
@group(0) @binding(1) var<storage, read> boxes: array<BoxData>;

struct BoxVsOut {
  @builtin(position) clip: vec4f,
  @location(0) color: vec3f,
  @location(1) normal: vec3f,
  @location(2) worldPos: vec3f,
};

// 单位立方体 8 角点 + 36 索引（12 三角形）
const CUBE_POS = array<vec3f, 8>(
  vec3f(0, 0, 0), vec3f(1, 0, 0), vec3f(1, 1, 0), vec3f(0, 1, 0),
  vec3f(0, 0, 1), vec3f(1, 0, 1), vec3f(1, 1, 1), vec3f(0, 1, 1),
);
const CUBE_IDX = array<u32, 36>(
  0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
  0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
  2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
);
const CUBE_NRM = array<vec3f, 6>(
  vec3f(0, 0, -1), vec3f(0, 0, 1), vec3f(0, -1, 0),
  vec3f(1, 0, 0), vec3f(0, 1, 0), vec3f(-1, 0, 0),
);

@vertex
fn boxVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BoxVsOut {
  let b = boxes[ii];
  let corner = CUBE_POS[CUBE_IDX[vi]];
  let world = mix(b.min.xyz, b.max.xyz, corner);
  var out: BoxVsOut;
  out.clip = scene.cam.viewProj * vec4f(world, 1.0);
  out.color = b.color.xyz;
  out.normal = CUBE_NRM[vi / 6u];
  out.worldPos = world;
  return out;
}

@fragment
fn boxFs(in: BoxVsOut) -> @location(0) vec4f {
  let lightDir = normalize(vec3f(0.5, 0.6, 0.8));
  let lambert = clamp(dot(normalize(in.normal), lightDir) * 0.6 + 0.55, 0.2, 1.0);
  return vec4f(in.color * lambert, 0.92);
}

// ---------- 等温面（顶点缓冲来自 Marching Tetrahedra） ----------
struct IsoVsOut {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) local: vec3f,
};

@vertex
fn isoVs(@location(0) position: vec3f, @location(1) normal: vec3f) -> IsoVsOut {
  var out: IsoVsOut;
  out.clip = scene.cam.viewProj * vec4f(position, 1.0);
  out.normal = normal;
  out.local = position;
  return out;
}

@fragment
fn isoFs(in: IsoVsOut) -> @location(0) vec4f {
  let lightDir = normalize(vec3f(0.5, 0.6, 0.8));
  let lambert = clamp(dot(normalize(in.normal), lightDir), 0.0, 1.0);
  // 暖橙色半透明（bind group 中可覆盖颜色，这里固定，2K 层走独立描边管线）
  return vec4f(vec3f(1.0, 0.45, 0.15) * (0.35 + 0.5 * lambert), 0.28);
}

// 2K 等温面描边线框
@vertex
fn isoEdgeVs(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return scene.cam.viewProj * vec4f(position, 1.0);
}
@fragment
fn isoEdgeFs() -> @location(0) vec4f {
  return vec4f(1.0, 0.85, 0.2, 0.95);
}

// ---------- 粒子（实例化三角形点精灵，不依赖 point-list 可选特性） ----------
struct ParticleVertex {
  pos: vec4f,
  seed: vec4f,
};
@group(1) @binding(0) var<storage, read> parts: array<ParticleVertex>;
@group(1) @binding(1) var texU: texture_3d<f32>;
@group(1) @binding(2) var texV: texture_3d<f32>;
@group(1) @binding(3) var texW: texture_3d<f32>;
@group(1) @binding(4) var<uniform> gridUni: GridUniforms;

struct POut {
  @builtin(position) clip: vec4f,
  @location(0) speed: f32,
  @location(1) alive: f32,
};

fn pSampleVel(p: vec3f) -> vec3f {
  return vec3f(
    sampleComp(texU, gridUni, p),
    sampleComp(texV, gridUni, p),
    sampleComp(texW, gridUni, p),
  );
}

@vertex
fn particleVs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> POut {
  let pt = parts[ii];
  // 面向相机的广告牌：每实例 3 顶点组成小三角形，尺寸由 misc.x 给定（米）
  let corner = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  let size = scene.misc.x;
  let world = pt.pos.xyz
    + scene.cam.right.xyz * (corner[vi].x * size)
    + scene.cam.up.xyz * (corner[vi].y * size);
  var out: POut;
  out.clip = scene.cam.viewProj * vec4f(world, 1.0);
  let v = pSampleVel(pt.pos.xyz);
  out.speed = select(length(v), 0.0, !validVel(v));
  out.alive = select(0.0, 1.0, pt.pos.w > 0.0);
  return out;
}

@fragment
fn particleFs(in: POut) -> @location(0) vec4f {
  if (in.alive < 0.5) { discard; }
  let t01 = clamp(in.speed / 25.0, 0.0, 1.0);
  return vec4f(mix(vec3f(0.6, 0.8, 1.0), vec3f(1.0, 0.5, 0.3), t01), 0.9);
}

// ---------- 航线线段 ----------
struct LineOut {
  @builtin(position) clip: vec4f,
  @location(0) exceed: f32,
};
struct RoutePoint {
  pos: vec4f,
  flag: vec4f, // x: 垂直超限 y: 温升超限
};
@group(2) @binding(0) var<storage, read> routePts: array<RoutePoint>;

@vertex
fn routeVs(@builtin(vertex_index) vi: u32) -> LineOut {
  let rp = routePts[vi];
  var out: LineOut;
  out.clip = scene.cam.viewProj * vec4f(rp.pos.xyz, 1.0);
  out.exceed = select(0.0, 1.0, rp.flag.x > 0.5 || rp.flag.y > 0.5);
  return out;
}

@fragment
fn routeFs(in: LineOut) -> @location(0) vec4f {
  let normal = vec3f(0.2, 0.9, 0.4);
  let red = vec3f(1.0, 0.15, 0.1);
  return vec4f(mix(normal, red, in.exceed), 1.0);
}

// ---------- 切片 LIC 纹理平面（贴回 3D 场景） ----------
struct SlicePlaneUniforms {
  cam: Camera,
  // 四边形 4 个角点世界坐标（xyz），w 预留
  corners: array<vec4f, 4>,
};
@group(3) @binding(0) var<uniform> spUni: SlicePlaneUniforms;
@group(3) @binding(1) var spTex: texture_2d<f32>;
@group(3) @binding(2) var spSamp: sampler;

struct SpOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn slicePlaneVs(@builtin(vertex_index) vi: u32) -> SpOut {
  // 两个三角形：0,1,2 / 0,2,3
  let idx = array<u32, 6>(0u, 1u, 2u, 0u, 2u, 3u);
  let corner = spUni.corners[idx[vi]];
  var out: SpOut;
  out.clip = spUni.cam.viewProj * vec4f(corner.xyz, 1.0);
  let uvIdx = array<vec2f, 4>(
    vec2f(0.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0), vec2f(1.0, 0.0),
  );
  out.uv = uvIdx[idx[vi]];
  return out;
}

@fragment
fn slicePlaneFs(in: SpOut) -> @location(0) vec4f {
  return textureSample(spTex, spSamp, in.uv);
}
