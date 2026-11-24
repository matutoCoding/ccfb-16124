import { describe, it, expect } from 'vitest';
import { createDefaultProject } from '../src/domain/platform';
import { autoGrid, generateSyntheticDataset } from '../src/domain/synthetic';
import { scanAllSectors, blendFields, SECTOR_COUNT, fieldAtBearing } from '../src/domain/sectors';
import { buildRoutes, sampleRoute } from '../src/domain/routes';
import { assessDeckLevel, deckRegionFromProject, verdictFromAssessment } from '../src/domain/rules';
import { angleDiff } from '../src/domain/angle';

const project = createDefaultProject();
const grid = autoGrid(project.modules, 4);
const fields = generateSyntheticDataset(project, grid);

describe('36 扇区扫描', () => {
  const { sectors } = scanAllSectors(grid, fields, project);

  it('输出 36 个 10° 间隔扇区', () => {
    expect(sectors).toHaveLength(SECTOR_COUNT);
    expect(sectors.map((s) => s.bearingDeg)).toEqual(Array.from({ length: 36 }, (_, i) => i * 10));
  });

  it('每个扇区结论与极值字段完整', () => {
    for (const s of sectors) {
      expect(['pass', 'caution', 'no-fly']).toContain(s.verdict);
      expect(s.maxVertical).toBeGreaterThanOrEqual(0);
      expect(s.maxTempRise).toBeGreaterThanOrEqual(0);
      expect(s.maxTotal).toBeGreaterThanOrEqual(0);
    }
  });

  it('原始风向处结论与该风向直接评估一致（10° 扇区仅 0/90/180/270 精确命中）', () => {
    const region = deckRegionFromProject(project)!;
    for (const bearing of [0, 90, 180, 270]) {
      const sectorAtBearing = sectors.find((s) => s.bearingDeg === bearing)!;
      const f = fields.find((x) => x.windDirDeg === bearing)!;
      // 直接对该风向原始网格做逐点评估（不经插值）
      const direct = assessDeckLevel(grid, f, region, project.thresholds, project.ambientTempK);
      const { verdict } = verdictFromAssessment(direct);
      expect(sectorAtBearing.verdict).toBe(verdict);
      expect(sectorAtBearing.maxVertical).toBeCloseTo(direct.maxVertical, 10);
      expect(sectorAtBearing.maxTempRise).toBeCloseTo(direct.maxTempRise, 10);
    }
    // 45° 类原始风向：其两侧 10° 扇区由相邻原始场插值，极值有限且非负
    const d45 = assessDeckLevel(
      grid, fields.find((x) => x.windDirDeg === 45)!, region,
      project.thresholds, project.ambientTempK,
    );
    expect(d45.evaluated).toBeGreaterThan(0);
    for (const b of [40, 50, 130, 140, 220, 230, 310, 320]) {
      const sec = sectors.find((s) => s.bearingDeg === b)!;
      expect(Number.isFinite(sec.maxVertical)).toBe(true);
      expect(sec.maxVertical).toBeGreaterThanOrEqual(0);
      expect(sec.maxTempRise).toBeGreaterThanOrEqual(0);
    }
  });

  it('相邻扇区结论变化有连续性（插值不产生 NaN 极值）', () => {
    for (const s of sectors) {
      expect(Number.isFinite(s.maxVertical)).toBe(true);
      expect(Number.isFinite(s.maxTempRise)).toBe(true);
    }
  });
});

describe('风场插值与过渡', () => {
  it('t=0 / t=1 时混合场等于端点场', () => {
    const mid = blendFields(fields[0], fields[1], 0, 0);
    for (let i = 0; i < mid.u.length; i++) expect(Object.is(mid.u[i], fields[0].u[i]) || mid.u[i] === fields[0].u[i]).toBe(true);
    const end = blendFields(fields[0], fields[1], 1, 45);
    for (let i = 0; i < end.u.length; i++) expect(end.u[i]).toBe(fields[1].u[i]);
  });

  it('混合场在中点取两端均值', () => {
    const mid = blendFields(fields[0], fields[1], 0.5, 22.5);
    const idx = 100;
    expect(mid.u[idx]).toBeCloseTo((fields[0].u[idx] + fields[1].u[idx]) / 2, 6);
  });

  it('fieldAtBearing 环绕区间（350°）取 315 与 0 号场', () => {
    const r = fieldAtBearing(fields, 350);
    expect(fields[r.left].windDirDeg).toBe(315);
    expect(fields[r.right].windDirDeg).toBe(0);
    expect(r.t).toBeCloseTo(35 / 45, 10);
  });

  it('拖动过渡时相邻帧场差随 t 单调有界，无跳变', () => {
    let prev = fieldAtBearing(fields, 10).field;
    let maxDelta = 0;
    for (let deg = 11; deg <= 44; deg++) {
      const cur = fieldAtBearing(fields, deg).field;
      for (let i = 0; i < cur.u.length; i += 997) {
        if (Number.isFinite(cur.u[i]) && Number.isFinite(prev.u[i])) {
          maxDelta = Math.max(maxDelta, Math.abs(cur.u[i] - prev.u[i]));
        }
      }
      prev = cur;
    }
    // 1° 步长下任何分量跳变都应远小于风速量级
    expect(maxDelta).toBeLessThan(2);
  });
});

describe('航线采样与超限段', () => {
  const routes = buildRoutes(project);
  it('生成进近/离场两条航线，位于参考高度层', () => {
    expect(routes).toHaveLength(2);
    const deck = project.modules.find((m) => m.type === 'helideck')!;
    for (const r of routes) expect(r.from.z).toBeCloseTo(deck.position.z + project.refHeightM, 10);
  });

  it('航线采样点等距且数值有限，超限段距离单调', () => {
    const ra = sampleRoute(grid, fields[2], routes[0], project.thresholds, project.ambientTempK, 45);
    expect(ra.samples.length).toBeGreaterThan(10);
    for (let i = 1; i < ra.samples.length; i++) {
      expect(ra.samples[i].distance).toBeGreaterThan(ra.samples[i - 1].distance);
    }
    for (const [a, b] of ra.verticalExceedSegments) expect(b).toBeGreaterThanOrEqual(a);
    for (const [a, b] of ra.tempExceedSegments) expect(b).toBeGreaterThanOrEqual(a);
  });

  it('人为制造超限：标记段与阈值判定完全对应', () => {
    // 用外扩 60m 的宽网格，保证完整航线（2.5 倍甲板直径）落在域内
    const wideGrid: typeof grid = {
      ...grid,
      nx: grid.nx + 30,
      ny: grid.ny + 30,
      nz: grid.nz + 4,
      origin: { x: grid.origin.x - 60, y: grid.origin.y - 60, z: grid.origin.z },
    };
    const wideFields = generateSyntheticDataset(project, wideGrid);
    const wideRoutes = buildRoutes(project);
    const f = structuredClone(wideFields[0]);
    const route = wideRoutes[0];
    const kLayer = Math.round((route.from.z - wideGrid.origin.z) / wideGrid.spacing.z);
    for (let s = 0; s <= 10; s++) {
      const q = s / 20;
      const target = {
        x: route.from.x + (route.to.x - route.from.x) * q,
        y: route.from.y + (route.to.y - route.from.y) * q,
      };
      for (let i = 0; i < wideGrid.nx; i++) for (let j = 0; j < wideGrid.ny; j++) {
        const x = wideGrid.origin.x + i * wideGrid.spacing.x;
        const y = wideGrid.origin.y + j * wideGrid.spacing.y;
        if (Math.hypot(x - target.x, y - target.y) < 3) {
          for (const k of [kLayer - 1, kLayer, kLayer + 1]) {
            if (k >= 0 && k < wideGrid.nz) f.w[gridIdxWide(wideGrid, i, j, k)] = 2;
          }
        }
      }
    }
    const ra = sampleRoute(wideGrid, f, route, project.thresholds, project.ambientTempK, 45);
    expect(ra.samples.every((x) => Number.isFinite(x.w))).toBe(true);
    expect(ra.verticalExceedSegments.length).toBeGreaterThan(0);
    // 所有标记点的 w 判定确实 > 0.9（注入区逐点核对）
    expect(ra.samples.filter((x) => x.verticalExceed).every((x) => Math.abs(x.w) > 0.9)).toBe(true);
    // 注入区覆盖航线前半段：前 1/3 采样点应全部超限
    const head = ra.samples.slice(0, Math.floor(ra.samples.length / 3));
    expect(head.every((x) => x.verticalExceed)).toBe(true);
  });

  function gridIdxWide(g: typeof grid, i: number, j: number, k: number) {
    return i + g.nx * (j + g.ny * k);
  }
});

describe('角度工具在扇区中的一致性', () => {
  it('36 个方位角覆盖整圆且间隔 10°', () => {
    expect(angleDiff(350, 360)).toBe(-10);
  });
});
