import { describe, it, expect } from 'vitest';
import type { GridSpec, Vec3 } from '../src/domain/types';
import {
  rk4Step, licValue, measureDirectionError, hashNoise, angleBetween, vectorBearing,
} from '../src/domain/lic';
import { sampleComponent } from '../src/domain/grid';
import { gridIndex } from '../src/domain/grid';

/** 解析场采样器 */
function analyticSample(f: (p: Vec3) => Vec3) {
  return (p: Vec3): Vec3 => f(p);
}

/** 在规则网格上用三线性插值构造采样器（与 WGSL 端同一路径） */
function griddedSample(grid: GridSpec, u: Float32Array, v: Float32Array, w: Float32Array) {
  return (p: Vec3): Vec3 => ({
    x: sampleComponent(grid, u, p),
    y: sampleComponent(grid, v, p),
    z: sampleComponent(grid, w, p),
  });
}

function interiorProbes(grid: GridSpec, step: number): Vec3[] {
  const out: Vec3[] = [];
  const b = {
    x0: grid.origin.x + grid.spacing.x * 2,
    x1: grid.origin.x + (grid.nx - 3) * grid.spacing.x,
    y0: grid.origin.y + grid.spacing.y * 2,
    y1: grid.origin.y + (grid.ny - 3) * grid.spacing.y,
    z0: grid.origin.z + grid.spacing.z * 2,
    z1: grid.origin.z + (grid.nz - 3) * grid.spacing.z,
  };
  for (let x = b.x0; x <= b.x1; x += step * 3)
    for (let y = b.y0; y <= b.y1; y += step * 3)
      for (let z = b.z0; z <= b.z1; z += step * 3) out.push({ x, y, z });
  return out;
}

describe('LIC 基础性质', () => {
  it('噪声确定性且落在 [0,1)', () => {
    expect(hashNoise(1, 2, 3)).toBe(hashNoise(1, 2, 3));
    for (let i = 0; i < 100; i++) {
      const h = hashNoise(i, i * 7, i * 13);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });

  it('licValue 输出 [0,1] 且可复现', () => {
    const s = analyticSample(() => ({ x: 1, y: 0.5, z: 0 }));
    const a = licValue(s, { x: 5, y: 5, z: 5 }, 0.5, 8, 0);
    const b = licValue(s, { x: 5, y: 5, z: 5 }, 0.5, 8, 0);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(1);
  });

  it('RK4 穿出有效域返回 null', () => {
    const s = analyticSample((p) => (p.x > 9 ? { x: NaN, y: NaN, z: NaN } : { x: 10, y: 0, z: 0 }));
    const end = rk4Step(s, { x: 8.9, y: 0, z: 0 }, 0.5, 1);
    expect(end).toBeNull();
  });
});

/**
 * 验收指标 1：LIC 纹理走向与速度场方向偏差 < 3°。
 * 用 RK4 流线弦方向代表纹理走向，对多类流场逐探针统计。
 */
describe('验收 1：流向偏差 < 3°（解析场）', () => {
  it('均匀场：偏差为 0', () => {
    const s = analyticSample(() => ({ x: 12, y: -7, z: 0.3 }));
    const probes: Vec3[] = [];
    for (let x = -10; x <= 10; x += 2) for (let y = -10; y <= 10; y += 2) probes.push({ x, y, z: 0 });
    const r = measureDirectionError(s, probes, 0.05);
    expect(r.valid).toBe(probes.length);
    // 弧长参数化下均匀场弦方向与场方向严格平行，仅余浮点舍入
    expect(r.max).toBeLessThan(1e-4);
  });

  it('旋转场（圆形流线）：对称弦与切线平行', () => {
    const s = analyticSample((p) => ({ x: -p.y, y: p.x, z: 0 }));
    const probes: Vec3[] = [];
    for (let x = -8; x <= 8; x += 2) for (let y = -8; y <= 8; y += 2) {
      if (Math.hypot(x, y) > 2) probes.push({ x, y, z: 0 });
    }
    const r = measureDirectionError(s, probes, 0.01);
    expect(r.max).toBeLessThan(3);
    expect(r.mean).toBeLessThan(0.5);
  });

  it('抛物流线场 v=(1, x²)：弯曲流线误差随步长收敛', () => {
    const s = analyticSample((p) => ({ x: 1, y: p.x * p.x * 0.05, z: 0 }));
    const probes: Vec3[] = [];
    for (let x = -10; x <= 10; x += 1.5) for (let y = -10; y <= 10; y += 3) probes.push({ x, y, z: 0 });
    const r = measureDirectionError(s, probes, 0.05);
    expect(r.max).toBeLessThan(3);
    // 收敛性：步长减半，误差约降到 1/4（二阶截断）
    const rFine = measureDirectionError(s, probes, 0.025);
    expect(rFine.max).toBeLessThan(r.max);
  });

  it('三维剪切场 v=(sin z, 1, 0.3cos x)', () => {
    const s = analyticSample((p) => ({
      x: Math.sin(p.z * 0.4), y: 1, z: 0.3 * Math.cos(p.x * 0.3),
    }));
    const probes: Vec3[] = [];
    for (let x = -8; x <= 8; x += 2) for (let y = -8; y <= 8; y += 2) for (let z = -8; z <= 8; z += 4) {
      probes.push({ x, y, z });
    }
    const r = measureDirectionError(s, probes, 0.05);
    expect(r.max).toBeLessThan(3);
  });
});

describe('验收 1：流向偏差 < 3°（网格三线性场，GPU 同构路径）', () => {
  const grid: GridSpec = {
    nx: 25, ny: 25, nz: 15,
    origin: { x: -24, y: -24, z: 0 },
    spacing: { x: 2, y: 2, z: 2 },
  };
  const n = grid.nx * grid.ny * grid.nz;

  it('均匀网格场：偏差为 0', () => {
    const u = new Float32Array(n).fill(15);
    const v = new Float32Array(n).fill(-8);
    const w = new Float32Array(n).fill(0.4);
    const s = griddedSample(grid, u, v, w);
    const r = measureDirectionError(s, interiorProbes(grid, 0.7), 0.7);
    expect(r.valid).toBeGreaterThan(50);
    expect(r.max).toBeLessThan(1e-4);
  });

  it('变化网格场（含回流反向区）：全部探针 < 3°', () => {
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const w = new Float32Array(n);
    for (let k = 0; k < grid.nz; k++)
      for (let j = 0; j < grid.ny; j++)
        for (let i = 0; i < grid.nx; i++) {
          const idx = gridIndex(grid, i, j, k);
          const x = grid.origin.x + i * 2;
          const y = grid.origin.y + j * 2;
          const z = k * 2;
          // 方向在域内连续变化，局部出现反向（回流）
          u[idx] = 8 + 6 * Math.sin(x * 0.08);
          v[idx] = 10 * Math.cos(y * 0.06);
          w[idx] = 1.5 * Math.sin(z * 0.3);
        }
    const s = griddedSample(grid, u, v, w);
    const probes = interiorProbes(grid, 0.7).filter((p) => Math.hypot(8 + 6 * Math.sin(p.x * 0.08), 10 * Math.cos(p.y * 0.06)) > 1.5);
    const r = measureDirectionError(s, probes, 0.7);
    expect(r.valid).toBeGreaterThan(100);
    expect(r.max).toBeLessThan(3);
  });

  it('方位角工具自洽', () => {
    expect(vectorBearing({ x: 0, y: 1, z: 0 })).toBeCloseTo(0, 10);
    expect(vectorBearing({ x: 1, y: 0, z: 0 })).toBeCloseTo(90, 10);
    expect(angleBetween({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })).toBeCloseTo(90, 10);
  });
});
