/**
 * 验收指标 1 量化报告：LIC 纹理走向 vs 速度场方向偏差。
 * 输出多类流场的 max/mean/RMS 偏差，作为评审证据，
 * 阈值硬性要求 max < 3°（与 vitest 断言一致）。
 */
import { describe, it, expect } from 'vitest';
import type { GridSpec, Vec3 } from '../src/domain/types';
import { measureDirectionError } from '../src/domain/lic';
import { sampleComponent } from '../src/domain/grid';
import { gridIndex } from '../src/domain/grid';

function griddedSample(grid: GridSpec, u: Float32Array, v: Float32Array, w: Float32Array) {
  return (p: Vec3): Vec3 => ({
    x: sampleComponent(grid, u, p),
    y: sampleComponent(grid, v, p),
    z: sampleComponent(grid, w, p),
  });
}

describe('验收 1 量化报告：流向偏差（度）', () => {
  const grid: GridSpec = {
    nx: 25, ny: 25, nz: 15,
    origin: { x: -24, y: -24, z: 0 },
    spacing: { x: 2, y: 2, z: 2 },
  };
  const n = grid.nx * grid.ny * grid.nz;
  const probes: Vec3[] = [];
  for (let x = -20; x <= 20; x += 2)
    for (let y = -20; y <= 20; y += 2)
      for (let z = 4; z <= 24; z += 4) probes.push({ x, y, z });

  it('均匀场', () => {
    const s = griddedSample(grid, new Float32Array(n).fill(15), new Float32Array(n).fill(-8), new Float32Array(n).fill(0.4));
    const r = measureDirectionError(s, probes, 0.8);
    console.log(`[流向偏差] 均匀场: max=${r.max.toFixed(4)}° mean=${r.mean.toFixed(4)}° rms=${r.rms.toFixed(4)}° n=${r.valid}`);
    expect(r.max).toBeLessThan(3);
  });

  it('变化网格场（含回流）', () => {
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
          u[idx] = 8 + 6 * Math.sin(x * 0.08);
          v[idx] = 10 * Math.cos(y * 0.06);
          w[idx] = 1.5 * Math.sin(z * 0.3);
        }
    const s = griddedSample(grid, u, v, w);
    const validProbes = probes.filter((p) => Math.hypot(8 + 6 * Math.sin(p.x * 0.08), 10 * Math.cos(p.y * 0.06)) > 1.5);
    const r = measureDirectionError(s, validProbes, 0.8);
    console.log(`[流向偏差] 变化场: max=${r.max.toFixed(4)}° mean=${r.mean.toFixed(4)}° rms=${r.rms.toFixed(4)}° n=${r.valid}`);
    expect(r.max).toBeLessThan(3);
    expect(r.mean).toBeLessThan(1);
  });

  it('步长收敛性：0.8m -> 0.4m 误差下降', () => {
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const w = new Float32Array(n);
    for (let k = 0; k < grid.nz; k++)
      for (let j = 0; j < grid.ny; j++)
        for (let i = 0; i < grid.nx; i++) {
          const idx = gridIndex(grid, i, j, k);
          const x = grid.origin.x + i * 2;
          const y = grid.origin.y + j * 2;
          u[idx] = 8 + 6 * Math.sin(x * 0.08);
          v[idx] = 10 * Math.cos(y * 0.06);
          w[idx] = 1.5 * Math.sin(k * 0.6);
        }
    const s = griddedSample(grid, u, v, w);
    const coarse = measureDirectionError(s, probes, 0.8);
    const fine = measureDirectionError(s, probes, 0.4);
    console.log(`[流向偏差] 收敛: coarse max=${coarse.max.toFixed(4)}° -> fine max=${fine.max.toFixed(4)}°`);
    expect(fine.max).toBeLessThanOrEqual(coarse.max);
  });
});
