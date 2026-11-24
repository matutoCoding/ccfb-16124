import { describe, it, expect } from 'vitest';
import type {
  DirectionField, GridSpec, RuleThresholds,
} from '../src/domain/types';
import { assessDeckLevel, verdictFromAssessment, type DeckRegion, type ExceedancePoint } from '../src/domain/rules';
import { gridIndex } from '../src/domain/grid';

const grid: GridSpec = {
  nx: 11, ny: 11, nz: 5,
  origin: { x: 0, y: 0, z: 0 },
  spacing: { x: 2, y: 2, z: 2 },
};
const AMBIENT = 300;
const thresholds: RuleThresholds = {
  verticalWind: 0.9, tempRise: 2, totalWind: 20, crossWind: 0,
};
const region: DeckRegion = {
  center: { x: 10, y: 10, z: 0 },
  refZ: 4, // 最近 k=2 层
  radius: 6,
  approachBearingDeg: 0,
};

function emptyField(): DirectionField {
  const n = grid.nx * grid.ny * grid.nz;
  return {
    windDirDeg: 0, windSpeed: 10,
    u: new Float32Array(n), v: new Float32Array(n).fill(-10),
    w: new Float32Array(n), t: new Float32Array(n).fill(AMBIENT),
  };
}

/**
 * 验收指标 3：超限判定与原始网格逐点核对一致。
 * 手工布置已知超限格点，引擎输出必须与布置集合完全相等。
 */
describe('验收 3：逐点超限判定', () => {
  it('垂直风速超限点被精确捕获（含 ijk 与数值）', () => {
    const f = emptyField();
    // 参考层 k=2；选两个圆盘内格点
    const hot: [number, number, number][] = [[3, 4, 2], [5, 5, 2]];
    for (const [i, j, k] of hot) f.w[gridIndex(grid, i, j, k)] = 1.35;
    const r = assessDeckLevel(grid, f, region, thresholds, AMBIENT);
    const got = new Set(r.points.filter((p) => p.verticalExceed).map((p) => `${p.i},${p.j},${p.k}`));
    expect(got).toEqual(new Set(hot.map(([i, j, k]) => `${i},${j},${k}`)));
    const p0 = r.points.find((p) => p.i === 3 && p.j === 4)!;
    expect(p0.vertical).toBeCloseTo(1.35, 5);
    expect(r.maxVertical).toBeCloseTo(1.35, 5);
  });

  it('温升超限点精确捕获，未超限点不出现在清单', () => {
    const f = emptyField();
    f.t[gridIndex(grid, 4, 4, 2)] = AMBIENT + 3.4;   // 超限
    f.t[gridIndex(grid, 6, 6, 2)] = AMBIENT + 1.5;   // 不超限
    const r = assessDeckLevel(grid, f, region, thresholds, AMBIENT);
    const tempPoints = r.points.filter((p) => p.tempExceed);
    expect(tempPoints).toHaveLength(1);
    expect(tempPoints[0].i).toBe(4);
    expect(tempPoints[0].j).toBe(4);
    expect(tempPoints[0].tempRise).toBeCloseTo(3.4, 4);
    expect(r.maxTempRise).toBeCloseTo(3.4, 4);
  });

  it('阈值边界：等于阈值不算超限（严格 >）', () => {
    const f = emptyField();
    f.w[gridIndex(grid, 4, 4, 2)] = 0.9;
    f.t[gridIndex(grid, 5, 5, 2)] = AMBIENT + 2;
    const r = assessDeckLevel(grid, f, region, thresholds, AMBIENT);
    expect(r.points).toHaveLength(0);
  });

  it('圆盘外格点不参与评估', () => {
    const f = emptyField();
    // (0,0) 距中心 (10,10) 的水平距离 sqrt(200)≈14.1 > 6
    f.w[gridIndex(grid, 0, 0, 2)] = 50;
    const r = assessDeckLevel(grid, f, region, thresholds, AMBIENT);
    expect(r.points).toHaveLength(0);
  });

  it('缺测格点计入 missing 且不产生误报', () => {
    const f = emptyField();
    const idx = gridIndex(grid, 4, 4, 2);
    f.u[idx] = NaN; f.v[idx] = NaN; f.w[idx] = NaN; f.t[idx] = NaN;
    const r = assessDeckLevel(grid, f, region, thresholds, AMBIENT);
    expect(r.missing).toBe(1);
    expect(r.points).toHaveLength(0);
  });

  it('评估点数 + 缺测数 = 圆盘内格点总数', () => {
    const f = emptyField();
    const r = assessDeckLevel(grid, f, region, thresholds, AMBIENT);
    // 手工数圆盘内格点
    let expectCount = 0;
    for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
      const x = i * 2, y = j * 2;
      if ((x - 10) ** 2 + (y - 10) ** 2 <= 36) expectCount++;
    }
    expect(r.evaluated + r.missing).toBe(expectCount);
  });

  it('总风速超限时给 caution 而非 no-fly', () => {
    const f = emptyField();
    f.v[gridIndex(grid, 4, 4, 2)] = -25; // 总风速 25 > 20
    const r = assessDeckLevel(grid, f, region, thresholds, AMBIENT);
    const { verdict } = verdictFromAssessment(r);
    expect(verdict).toBe('caution');
  });

  it('垂直或温升超限 => no-fly 且原因含格点索引', () => {
    const f = emptyField();
    f.w[gridIndex(grid, 4, 4, 2)] = 2;
    const r = assessDeckLevel(grid, f, region, thresholds, AMBIENT);
    const { verdict, reasons } = verdictFromAssessment(r);
    expect(verdict).toBe('no-fly');
    expect(reasons.some((x) => x.includes('(4,4,2)'))).toBe(true);
  });

  it('与直接遍历原始网格的独立实现逐点一致', () => {
    // 独立参考实现（不调用引擎内部函数），随机布点后比对
    const f = emptyField();
    const seedVals: [number, number, number][] = [
      [2, 3, 2], [3, 3, 2], [7, 2, 2], [6, 7, 2], [1, 6, 2],
    ];
    for (const [i, j, k] of seedVals) {
      f.w[gridIndex(grid, i, j, k)] = 0.5 + (i * 0.31);
      f.t[gridIndex(grid, i, j, k)] = AMBIENT + (j * 0.47);
    }
    const r = assessDeckLevel(grid, f, region, thresholds, AMBIENT);

    // 独立实现
    const expectSet = new Set<string>();
    for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
      const x = i * 2, y = j * 2;
      if ((x - 10) ** 2 + (y - 10) ** 2 > 36) continue;
      const idx = gridIndex(grid, i, j, 2);
      const wEx = Math.abs(f.w[idx]) > 0.9;
      const tEx = f.t[idx] - AMBIENT > 2;
      if (wEx || tEx) expectSet.add(`${i},${j},2`);
    }
    const actualSet = new Set(r.points.map((p: ExceedancePoint) => `${p.i},${p.j},${p.k}`));
    expect(actualSet).toEqual(expectSet);
  });
});
