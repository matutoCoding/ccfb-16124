import type { GridSpec, Vec3 } from './types';

/** 规则网格索引：index = i + nx*(j + ny*k)，i->x, j->y, k->z */
export function gridIndex(grid: GridSpec, i: number, j: number, k: number): number {
  return i + grid.nx * (j + grid.ny * k);
}

export function gridPointCount(grid: GridSpec): number {
  return grid.nx * grid.ny * grid.nz;
}

/** 格点中心世界坐标 */
export function nodePosition(grid: GridSpec, i: number, j: number, k: number): Vec3 {
  return {
    x: grid.origin.x + i * grid.spacing.x,
    y: grid.origin.y + j * grid.spacing.y,
    z: grid.origin.z + k * grid.spacing.z,
  };
}

/** 世界坐标 -> 连续网格坐标（浮点 i,j,k），越界返回 null */
export function worldToGridCoord(grid: GridSpec, p: Vec3): Vec3 | null {
  const fx = (p.x - grid.origin.x) / grid.spacing.x;
  const fy = (p.y - grid.origin.y) / grid.spacing.y;
  const fz = (p.z - grid.origin.z) / grid.spacing.z;
  if (
    fx < 0 || fy < 0 || fz < 0 ||
    fx > grid.nx - 1 || fy > grid.ny - 1 || fz > grid.nz - 1
  ) {
    return null;
  }
  return { x: fx, y: fy, z: fz };
}

export interface TrilinearWeights {
  i0: number; j0: number; k0: number;
  i1: number; j1: number; k1: number;
  tx: number; ty: number; tz: number;
}

export function trilinearWeights(grid: GridSpec, p: Vec3): TrilinearWeights | null {
  const c = worldToGridCoord(grid, p);
  if (!c) return null;
  const i0 = Math.floor(c.x);
  const j0 = Math.floor(c.y);
  const k0 = Math.floor(c.z);
  return {
    i0, j0, k0,
    i1: Math.min(i0 + 1, grid.nx - 1),
    j1: Math.min(j0 + 1, grid.ny - 1),
    k1: Math.min(k0 + 1, grid.nz - 1),
    tx: c.x - i0,
    ty: c.y - j0,
    tz: c.z - k0,
  };
}

/**
 * 三线性采样单个分量。NaN（缺测）格点不参与插值：
 * 8 个角点中有效的按权重归一化；全部无效返回 NaN。
 * WGSL 端 sampleField() 与此函数逐位同构，是 LIC 方向一致性的共同基准。
 */
export function sampleComponent(
  grid: GridSpec,
  field: Float32Array,
  p: Vec3,
): number {
  const w = trilinearWeights(grid, p);
  if (!w) return NaN;
  const { i0, j0, k0, i1, j1, k1, tx, ty, tz } = w;
  const c000 = field[gridIndex(grid, i0, j0, k0)];
  const c100 = field[gridIndex(grid, i1, j0, k0)];
  const c010 = field[gridIndex(grid, i0, j1, k0)];
  const c110 = field[gridIndex(grid, i1, j1, k0)];
  const c001 = field[gridIndex(grid, i0, j0, k1)];
  const c101 = field[gridIndex(grid, i1, j0, k1)];
  const c011 = field[gridIndex(grid, i0, j1, k1)];
  const c111 = field[gridIndex(grid, i1, j1, k1)];
  const wx0 = 1 - tx, wy0 = 1 - ty, wz0 = 1 - tz;
  const weights = [
    wx0 * wy0 * wz0, tx * wy0 * wz0,
    wx0 * ty * wz0, tx * ty * wz0,
    wx0 * wy0 * tz, tx * wy0 * tz,
    wx0 * ty * tz, tx * ty * tz,
  ];
  const corners = [c000, c100, c010, c110, c001, c101, c011, c111];
  let sum = 0;
  let wsum = 0;
  for (let n = 0; n < 8; n++) {
    const v = corners[n];
    if (Number.isFinite(v)) {
      sum += v * weights[n];
      wsum += weights[n];
    }
  }
  return wsum > 0 ? sum / wsum : NaN;
}

/** 采样完整矢量 + 温度，缺测分量返回 NaN */
export function sampleField(
  grid: GridSpec,
  u: Float32Array,
  v: Float32Array,
  w: Float32Array,
  t: Float32Array,
  p: Vec3,
): { u: number; v: number; w: number; t: number } {
  return {
    u: sampleComponent(grid, u, p),
    v: sampleComponent(grid, v, p),
    w: sampleComponent(grid, w, p),
    t: sampleComponent(grid, t, p),
  };
}

/** 点是否在网格包围盒内（含边界） */
export function inBounds(grid: GridSpec, p: Vec3): boolean {
  return worldToGridCoord(grid, p) !== null;
}

/** 网格包围盒 */
export function gridBounds(grid: GridSpec): { min: Vec3; max: Vec3 } {
  return {
    min: { ...grid.origin },
    max: {
      x: grid.origin.x + (grid.nx - 1) * grid.spacing.x,
      y: grid.origin.y + (grid.ny - 1) * grid.spacing.y,
      z: grid.origin.z + (grid.nz - 1) * grid.spacing.z,
    },
  };
}
