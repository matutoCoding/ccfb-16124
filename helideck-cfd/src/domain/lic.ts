import type { Vec3 } from './types';

/**
 * 线积分卷积（LIC）的 CPU 参考实现。
 * WGSL 切片着色器中的 lic() 函数与本文件使用完全相同的：
 *   1) RK4 中点流线积分（4 次场采样/步）
 *   2) 盒式核（前后各 L 步白噪声平均）
 *   3) 同一格点哈希噪声函数（见 hashNoise 注释）
 * 因此 CPU 侧的方向偏差验证结果代表 GPU 纹理的真实流向精度。
 */

export interface SampleField3D {
  (p: Vec3): Vec3;
}

/** 确定性格点白噪声 [0,1)。WGSL 中使用同构整数运算（见 shaders/lic.wgsl 注释）。 */
export function hashNoise(ix: number, iy: number, iz: number, seed = 0): number {
  let h = (seed | 0) + Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(iz | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return (h % 10000) / 10000;
}

/**
 * RK4 流线推进（弧长参数化）。
 * 速度先归一化为单位矢量再积分，step 即沿流线的弧长（米），
 * 与风速大小无关——高速区不会一步跨出网格。动画速度另由相位
 * 推进速率按 |V| 缩放（见页面 animate 逻辑）。
 * WGSL 端 rk4() 使用同一归一化与同一 RK4 系数。
 * @param sample 速度场采样（无效点返回含 NaN 的矢量）
 * @param p0 起点
 * @param step 弧长步长（米，建议 ≤ 0.5 倍网格间距）
 * @param dir +1 顺流 / -1 逆流
 * @returns 终点；穿出有效域则返回 null
 */
export function rk4Step(sample: SampleField3D, p0: Vec3, step: number, dir: 1 | -1): Vec3 | null {
  const h = step * dir;
  const k1 = unit(sample(p0));
  if (!isFiniteVec(k1)) return null;
  const k2 = unit(sample(addScaled(p0, k1, h / 2)));
  if (!isFiniteVec(k2)) return null;
  const k3 = unit(sample(addScaled(p0, k2, h / 2)));
  if (!isFiniteVec(k3)) return null;
  const k4 = unit(sample(addScaled(p0, k3, h)));
  if (!isFiniteVec(k4)) return null;
  return {
    x: p0.x + (h / 6) * (k1.x + 2 * k2.x + 2 * k3.x + k4.x),
    y: p0.y + (h / 6) * (k1.y + 2 * k2.y + 2 * k3.y + k4.y),
    z: p0.z + (h / 6) * (k1.z + 2 * k2.z + 2 * k3.z + k4.z),
  };
}

function unit(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z);
  if (!Number.isFinite(len) || len < 1e-9) return { x: NaN, y: NaN, z: NaN };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

/**
 * 单像素 LIC 值：沿流线前后各 kernelLength 步积分白噪声。
 * 动画相位 phase 沿流线移动噪声查找位置（单位：步），GPU 端同式实现。
 */
export function licValue(
  sample: SampleField3D,
  p: Vec3,
  step: number,
  kernelLength: number,
  phase: number,
  seed = 0,
): number {
  let acc = noiseAt(sample, p, phase, seed);
  let weight = 1;
  // 顺流
  let pf: Vec3 | null = p;
  for (let s = 1; s <= kernelLength; s++) {
    pf = rk4Step(sample, pf, step, 1);
    if (!pf) break;
    acc += noiseAt(sample, pf, phase - s, seed);
    weight++;
  }
  // 逆流
  let pb: Vec3 | null = p;
  for (let s = 1; s <= kernelLength; s++) {
    pb = rk4Step(sample, pb, step, -1);
    if (!pb) break;
    acc += noiseAt(sample, pb, phase + s, seed);
    weight++;
  }
  return acc / weight;
}

function noiseAt(sample: SampleField3D, p: Vec3, phase: number, seed: number): number {
  // 采样点本身用于判有效性；噪声按相位移动的格点取值
  const v = sample(p);
  if (!isFiniteVec(v)) return 0.5;
  return hashNoise(
    Math.floor(p.x * 4 + phase),
    Math.floor(p.y * 4 + phase),
    Math.floor(p.z * 4),
    seed,
  );
}

function isFiniteVec(v: Vec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function addScaled(p: Vec3, v: Vec3, s: number): Vec3 {
  return { x: p.x + v.x * s, y: p.y + v.y * s, z: p.z + v.z * s };
}

/** 速度矢量方位角（xy 平面运动方向，度，0=北，顺时针） */
export function vectorBearing(v: Vec3): number {
  const deg = (Math.atan2(v.x, v.y) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/**
 * 流向偏差验证（验收指标 1）。
 * 在域内均匀布置探针，比较：
 *  - 解析/采样场的当地速度方向
 *  - RK4 流线走 n 步后的弦方向（LIC 纹理实际走向）
 * 返回每个探针的夹角（度）与统计值。弦方向会抹平曲率，
 * 因此用较小步长（≤0.35 格距）与 3 步弦长控制截断误差。
 */
export function measureDirectionError(
  sample: SampleField3D,
  probes: Vec3[],
  step: number,
  chordSteps = 3,
): { errorsDeg: number[]; max: number; mean: number; rms: number; valid: number } {
  const errorsDeg: number[] = [];
  for (const p of probes) {
    const v0 = sample(p);
    if (!isFiniteVec(v0) || Math.hypot(v0.x, v0.y) < 1e-6) continue;
    let pf: Vec3 | null = p;
    let pb: Vec3 | null = p;
    for (let s = 0; s < chordSteps; s++) {
      pf = rk4Step(sample, pf, step, 1);
      pb = rk4Step(sample, pb, step, -1);
      if (!pf || !pb) break;
    }
    if (!pf || !pb) continue;
    const chord = { x: pf.x - pb.x, y: pf.y - pb.y, z: pf.z - pb.z };
    if (Math.hypot(chord.x, chord.y, chord.z) < 1e-9) continue;
    const e = angleBetween(v0, chord);
    errorsDeg.push(e);
  }
  if (errorsDeg.length === 0) {
    return { errorsDeg, max: NaN, mean: NaN, rms: NaN, valid: 0 };
  }
  const mean = errorsDeg.reduce((a, b) => a + b, 0) / errorsDeg.length;
  const rms = Math.sqrt(errorsDeg.reduce((a, b) => a + b * b, 0) / errorsDeg.length);
  return { errorsDeg, max: Math.max(...errorsDeg), mean, rms, valid: errorsDeg.length };
}

/** 两矢量夹角（度，0..180） */
export function angleBetween(a: Vec3, b: Vec3): number {
  const na = Math.hypot(a.x, a.y, a.z);
  const nb = Math.hypot(b.x, b.y, b.z);
  if (na < 1e-12 || nb < 1e-12) return NaN;
  const cos = (a.x * b.x + a.y * b.y + a.z * b.z) / (na * nb);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}
