import { describe, it, expect } from 'vitest';
import type { GridSpec, Vec3 } from '../src/domain/types';
import {
  gridIndex, sampleComponent, sampleField, trilinearWeights,
  worldToGridCoord, gridBounds, nodePosition,
} from '../src/domain/grid';

const grid: GridSpec = {
  nx: 5, ny: 4, nz: 3,
  origin: { x: 0, y: 0, z: 0 },
  spacing: { x: 2, y: 2, z: 2 },
};

describe('grid 索引与坐标', () => {
  it('index 与 nodePosition 互逆', () => {
    expect(gridIndex(grid, 3, 2, 1)).toBe(3 + 5 * (2 + 4 * 1));
    const p = nodePosition(grid, 3, 2, 1);
    expect(p).toEqual({ x: 6, y: 4, z: 2 });
  });

  it('worldToGridCoord 越界返回 null', () => {
    expect(worldToGridCoord(grid, { x: 1, y: 1, z: 1 })).not.toBeNull();
    expect(worldToGridCoord(grid, { x: -0.1, y: 0, z: 0 })).toBeNull();
    expect(worldToGridCoord(grid, { x: 8.1, y: 0, z: 0 })).toBeNull();
  });

  it('网格边界正好包含最后一个格点', () => {
    const b = gridBounds(grid);
    expect(b.max).toEqual({ x: 8, y: 6, z: 4 });
    expect(worldToGridCoord(grid, b.max)).not.toBeNull();
  });
});

describe('三线性采样', () => {
  it('格点上采样返回原值', () => {
    const f = new Float32Array(5 * 4 * 3).fill(7);
    expect(sampleComponent(grid, f, nodePosition(grid, 2, 1, 0))).toBe(7);
  });

  it('线性场采样精确还原（误差 < 1e-12）', () => {
    const n = 5 * 4 * 3;
    const f = new Float32Array(n);
    for (let k = 0; k < 3; k++)
      for (let j = 0; j < 4; j++)
        for (let i = 0; i < 5; i++)
          f[gridIndex(grid, i, j, k)] = 3 * i - 2 * j + 0.5 * k + 1;

    const p: Vec3 = { x: 3.3, y: 2.7, z: 1.2 };
    const got = sampleComponent(grid, f, p);
    const fx = p.x / 2, fy = p.y / 2, fz = p.z / 2;
    const expectVal = 3 * fx - 2 * fy + 0.5 * fz + 1;
    expect(Math.abs(got - expectVal)).toBeLessThan(1e-12);
  });

  it('NaN 角点按权重归一化剔除', () => {
    const f = new Float32Array(5 * 4 * 3).fill(10);
    // 让包围 p 的一个角点为 NaN
    f[gridIndex(grid, 1, 1, 0)] = NaN;
    const p = { x: 2.5, y: 2.5, z: 0 };
    const got = sampleComponent(grid, f, p);
    expect(Number.isFinite(got)).toBe(true);
    expect(got).toBeCloseTo(10, 10); // 其余角点全为 10
  });

  it('8 角点全 NaN 时返回 NaN', () => {
    const f = new Float32Array(5 * 4 * 3).fill(NaN);
    const got = sampleComponent(grid, f, { x: 2, y: 2, z: 2 });
    expect(Number.isNaN(got)).toBe(true);
  });

  it('sampleField 四分量一致', () => {
    const n = 5 * 4 * 3;
    const u = new Float32Array(n).fill(1);
    const v = new Float32Array(n).fill(2);
    const w = new Float32Array(n).fill(3);
    const t = new Float32Array(n).fill(300);
    const s = sampleField(grid, u, v, w, t, { x: 2, y: 2, z: 2 });
    expect(s).toEqual({ u: 1, v: 2, w: 3, t: 300 });
  });

  it('权重在边界格点（i1 钳制）仍然归一', () => {
    const w = trilinearWeights(grid, gridBounds(grid).max);
    expect(w).not.toBeNull();
    expect(w!.i1).toBe(grid.nx - 1);
    expect(w!.tx).toBe(0);
  });
});
