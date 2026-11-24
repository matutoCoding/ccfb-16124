import { describe, it, expect } from 'vitest';
import { createDefaultProject } from '../src/domain/platform';
import {
  autoGrid, generateSyntheticDataset, exhaustsFromProject, rescaleTemperature,
} from '../src/domain/synthetic';
import { scanFieldQuality } from '../src/domain/quality';
import { gridIndex } from '../src/domain/grid';

describe('合成风场', () => {
  const project = createDefaultProject();
  const grid = autoGrid(project.modules, 4);

  it('生成 8 个风向，格点数与网格定义一致', () => {
    const fields = generateSyntheticDataset(project, grid);
    expect(fields).toHaveLength(8);
    expect(fields.map((f) => f.windDirDeg)).toEqual([0, 45, 90, 135, 180, 225, 270, 315]);
    const n = grid.nx * grid.ny * grid.nz;
    for (const f of fields) {
      expect(f.u.length).toBe(n);
      expect(f.t.length).toBe(n);
    }
  });

  it('确定性：同参数两次生成逐位相同', () => {
    const a = generateSyntheticDataset(project, grid, { seed: 7 });
    const b = generateSyntheticDataset(project, grid, { seed: 7 });
    for (let d = 0; d < 8; d++) {
      for (let i = 0; i < a[d].u.length; i++) {
        expect(a[d].u[i]).toBe(b[d].u[i]);
        expect(a[d].t[i]).toBe(b[d].t[i]);
      }
    }
  });

  it('体块内部为零速度且无温升', () => {
    const [f] = generateSyntheticDataset(project, grid);
    // 生活楼中心附近格点
    const living = project.modules.find((m) => m.type === 'living')!;
    const i = Math.round((living.position.x - grid.origin.x) / 4);
    const j = Math.round((living.position.y - grid.origin.y) / 4);
    const k = Math.round(living.position.z / 4);
    const idx = gridIndex(grid, i, j, k);
    expect(f.u[idx]).toBe(0);
    expect(f.v[idx]).toBe(0);
    expect(f.w[idx]).toBe(0);
    // float32 存储，温度按单精度容差核对
    expect(Math.abs(f.t[idx] - project.ambientTempK)).toBeLessThan(1e-3);
  });

  it('排气羽流在排气口下游产生 >2K 温升区', () => {
    const fields = generateSyntheticDataset(project, grid);
    const southWind = fields.find((f) => f.windDirDeg === 180)!; // 南风：向北吹
    // 全场至少存在若干 >2K 的格点
    const hotCount = [...southWind.t].filter((x) => x - project.ambientTempK > 2).length;
    expect(hotCount).toBeGreaterThan(5);
  });

  it('近尾流存在反向速度（回流区可被识别）', () => {
    const fields = generateSyntheticDataset(project, grid);
    let foundReversal = false;
    for (const f of fields) {
      // 自由来流方向投影为负即回流
      const r = (f.windDirDeg * Math.PI) / 180;
      const wu = -Math.sin(r), wv = -Math.cos(r);
      for (let i = 0; i < f.u.length; i++) {
        if (Number.isNaN(f.u[i])) continue;
        if (f.u[i] * wu + f.v[i] * wv < -0.5) { foundReversal = true; break; }
      }
    }
    expect(foundReversal).toBe(true);
  });

  it('缺测注入后质量扫描能逐点发现', () => {
    const fields = generateSyntheticDataset(project, grid, { missingFraction: 0.05, seed: 3 });
    const report = scanFieldQuality(grid, fields[0]);
    expect(report.missingCount).toBeGreaterThan(0);
    expect(report.samples.length).toBeGreaterThan(0);
    expect(report.samples.every((s) => s.reason === 'missing')).toBe(true);
  });

  it('无缺测时质量报告零问题', () => {
    const fields = generateSyntheticDataset(project, grid);
    const report = scanFieldQuality(grid, fields[0]);
    expect(report.missingCount).toBe(0);
    expect(report.badCount).toBe(0);
  });

  it('透平全关：排气 factor=0，温升场缩放为零', () => {
    const off = { ...project, turbines: project.turbines.map((t) => ({ ...t, running: false })) };
    const runtimes = exhaustsFromProject(off);
    expect(runtimes.every((r) => r.factor === 0)).toBe(true);
    const fields = generateSyntheticDataset(off, grid, { exhausts: runtimes });
    const maxRise = Math.max(...[...fields[0].t].map((x) => x - project.ambientTempK));
    // 无羽流贡献，仅余 float32 舍入噪声
    expect(Math.abs(maxRise)).toBeLessThan(1e-3);
  });

  it('rescaleTemperature 按比例缩放且保留 NaN', () => {
    const fields = generateSyntheticDataset(project, grid);
    const f = fields[0];
    const scaled = rescaleTemperature(f, project.ambientTempK, 0.5);
    for (let i = 0; i < f.t.length; i++) {
      if (Number.isNaN(f.t[i])) expect(Number.isNaN(scaled.t[i])).toBe(true);
      else expect(scaled.t[i] - project.ambientTempK).toBeCloseTo((f.t[i] - project.ambientTempK) * 0.5, 4);
    }
  });
});
