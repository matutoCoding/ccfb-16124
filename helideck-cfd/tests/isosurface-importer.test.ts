import { describe, it, expect } from 'vitest';
import type { GridSpec } from '../src/domain/types';
import { extractIsosurface } from '../src/domain/isosurface';
import { gridIndex } from '../src/domain/grid';
import { importJson, importCsv, buildImportTemplate } from '../src/domain/importer';

const grid: GridSpec = {
  nx: 6, ny: 6, nz: 6,
  origin: { x: 0, y: 0, z: 0 },
  spacing: { x: 1, y: 1, z: 1 },
};

describe('Marching Tetrahedra 等值面', () => {
  it('球形高温核：2K 等值面产生闭合三角网格', () => {
    const n = 6 ** 3;
    const f = new Float32Array(n);
    for (let k = 0; k < 6; k++) for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) {
      const d = Math.hypot(i - 2.5, j - 2.5, k - 2.5);
      f[gridIndex(grid, i, j, k)] = 5 * Math.exp(-(d * d) / 4);
    }
    const mesh = extractIsosurface(grid, f, 2);
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.normals.length).toBe(mesh.positions.length);
    // 所有顶点都在网格域内
    for (let v = 0; v < mesh.positions.length; v += 3) {
      expect(mesh.positions[v]).toBeGreaterThanOrEqual(0);
      expect(mesh.positions[v]).toBeLessThanOrEqual(5);
    }
    // 边表引用的顶点索引都合法
    for (const e of mesh.edges) expect(e * 3).toBeLessThan(mesh.positions.length);
  });

  it('全场低于等值：输出空网格', () => {
    const mesh = extractIsosurface(grid, new Float32Array(216).fill(0), 2);
    expect(mesh.indices.length).toBe(0);
    expect(mesh.positions.length).toBe(0);
  });

  it('缺测单元被跳过，不产生三角形', () => {
    const f = new Float32Array(216).fill(5);
    f[gridIndex(grid, 0, 0, 0)] = NaN;
    const mesh = extractIsosurface(grid, f, 2);
    // 其余位置无等值面穿越（全在高值侧），仍为空
    expect(mesh.indices.length).toBe(0);
  });
});

describe('CFD 数据导入', () => {
  it('JSON 内联数组往返', () => {
    const n = 6 * 6 * 6;
    const envelope = {
      grid,
      windSpeed: 12,
      ambientTempK: 300,
      directions: [{
        windDirDeg: 0,
        encoding: 'array',
        u: Array.from({ length: n }, (_, i) => i * 0.01),
        v: new Array(n).fill(-10),
        w: new Array(n).fill(0),
        t: new Array(n).fill(300),
      }],
    };
    const r = importJson(JSON.stringify(envelope));
    expect(r.fields).toHaveLength(1);
    expect(r.fields[0].u[10]).toBeCloseTo(0.1, 6);
    expect(r.grid.nx).toBe(6);
  });

  it('null 被解析为 NaN 缺测', () => {
    const n = 8;
    const tiny: GridSpec = { nx: 2, ny: 2, nz: 2, origin: { x: 0, y: 0, z: 0 }, spacing: { x: 1, y: 1, z: 1 } };
    const r = importJson(JSON.stringify({
      grid: tiny,
      directions: [{ windDirDeg: 0, u: [null, 1, 1, 1, 1, 1, 1, 1], v: new Array(n).fill(0), w: new Array(n).fill(0), t: new Array(n).fill(300) }],
    }));
    expect(Number.isNaN(r.fields[0].u[0])).toBe(true);
  });

  it('分量长度不匹配时报错', () => {
    const tiny: GridSpec = { nx: 2, ny: 2, nz: 2, origin: { x: 0, y: 0, z: 0 }, spacing: { x: 1, y: 1, z: 1 } };
    expect(() => importJson(JSON.stringify({
      grid: tiny,
      directions: [{ windDirDeg: 0, u: [1, 2], v: [0, 0, 0, 0, 0, 0, 0, 0], w: new Array(8).fill(0), t: new Array(8).fill(300) }],
    }))).toThrow();
  });

  it('CSV 稠密行解析，缺失行保留 NaN', () => {
    const tiny: GridSpec = { nx: 2, ny: 2, nz: 2, origin: { x: 0, y: 0, z: 0 }, spacing: { x: 1, y: 1, z: 1 } };
    const csv = [
      'windDirDeg,i,j,k,u,v,w,t',
      '0,0,0,0,1,2,0.3,300',
      '0,1,0,0,1,2,0.3,301',
      '90,0,0,0,NaN,0,0,300',
    ].join('\n');
    const r = importCsv(csv, tiny, 300);
    expect(r.fields).toHaveLength(2);
    expect(r.fields[0].u[gridIndex(tiny, 1, 0, 0)]).toBe(1);
    expect(Number.isNaN(r.fields[1].u[0])).toBe(true);
    expect(Number.isNaN(r.fields[0].u[gridIndex(tiny, 1, 1, 1)])).toBe(true);
  });

  it('CSV 缺列时报错', () => {
    const tiny: GridSpec = { nx: 2, ny: 2, nz: 2, origin: { x: 0, y: 0, z: 0 }, spacing: { x: 1, y: 1, z: 1 } };
    expect(() => importCsv('i,j,k\n0,0,0', tiny)).toThrow();
  });

  it('base64 模板可被重新导入且数值一致', () => {
    const text = buildImportTemplate(grid, [0, 90], 15, 303.15);
    const r = importJson(text);
    expect(r.fields).toHaveLength(2);
    // float32 往返，容差按单精度量级
    expect(r.fields[0].t.every((x) => Math.abs(x - 303.15) < 1e-3)).toBe(true);
    expect(r.fields[0].u.every((x) => x === 0)).toBe(true);
  });
});
