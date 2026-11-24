import type {
  DirectionField, GridSpec, PlatformProject, RuleThresholds, Vec3,
} from './types';
import { gridIndex, nodePosition } from './grid';

/**
 * CAP437 规则引擎。
 * 所有判定直接遍历原始规则网格的离散格点（不经过插值场），
 * 每个超限点保留 ijk 索引与世界坐标，可与外包 CFD 原始数据逐点核对。
 */

export interface ExceedancePoint {
  i: number;
  j: number;
  k: number;
  position: Vec3;
  vertical: number;
  total: number;
  tempRise: number;
  cross: number;
  verticalExceed: boolean;
  tempExceed: boolean;
  totalExceed: boolean;
  crossExceed: boolean;
}

export interface DeckAssessment {
  points: ExceedancePoint[];
  maxVertical: number;
  maxTempRise: number;
  maxTotal: number;
  maxCross: number;
  evaluated: number;
  missing: number;
}

/** 直升机甲板水平圆盘（世界坐标 xy 范围） */
export interface DeckRegion {
  center: Vec3;
  /** 评估层标高（甲板 + 30ft 参考高度） */
  refZ: number;
  radius: number;
  /** 进近方位角（度），用于侧风分解 */
  approachBearingDeg: number;
}

export function deckRegionFromProject(project: PlatformProject): DeckRegion | null {
  const deck = project.modules.find((m) => m.type === 'helideck');
  if (!deck?.helideck) return null;
  return {
    center: deck.position,
    refZ: deck.position.z + project.refHeightM,
    radius: deck.helideck.diameter / 2,
    approachBearingDeg: deck.helideck.approachBearingDeg,
  };
}

/**
 * 对单个风向场做甲板参考层逐点评估。
 * 选取 k 层中 z 最接近参考标高的整层节点，
 * 仅统计水平投影落在甲板圆盘内的格点（与人工核对 CFD 截图的取点方式一致）。
 */
export function assessDeckLevel(
  grid: GridSpec,
  field: DirectionField,
  region: DeckRegion,
  thresholds: RuleThresholds,
  ambientTempK: number,
): DeckAssessment {
  // 找最接近参考标高的 k 层
  let kBest = 0;
  let bestD = Infinity;
  for (let k = 0; k < grid.nz; k++) {
    const z = grid.origin.z + k * grid.spacing.z;
    const d = Math.abs(z - region.refZ);
    if (d < bestD) { bestD = d; kBest = k; }
  }

  const points: ExceedancePoint[] = [];
  let maxVertical = 0;
  let maxTempRise = 0;
  let maxTotal = 0;
  let maxCross = 0;
  let evaluated = 0;
  let missing = 0;

  const apprRad = (region.approachBearingDeg * Math.PI) / 180;
  // 进近方向水平单位矢量（运动方向）
  const ax = Math.sin(apprRad);
  const ay = Math.cos(apprRad);

  for (let j = 0; j < grid.ny; j++) {
    for (let i = 0; i < grid.nx; i++) {
      const idx = gridIndex(grid, i, j, kBest);
      const p = nodePosition(grid, i, j, kBest);
      const dx = p.x - region.center.x;
      const dy = p.y - region.center.y;
      if (dx * dx + dy * dy > region.radius * region.radius) continue;

      const u = field.u[idx];
      const v = field.v[idx];
      const w = field.w[idx];
      const t = field.t[idx];
      if (![u, v, w, t].every(Number.isFinite)) {
        missing++;
        continue;
      }
      evaluated++;
      const vertical = Math.abs(w);
      const total = Math.hypot(u, v, w);
      const tempRise = t - ambientTempK;
      // 侧风 = 水平风在进近法向上的投影大小
      const cross = Math.abs(u * ay - v * ax);

      maxVertical = Math.max(maxVertical, vertical);
      maxTempRise = Math.max(maxTempRise, tempRise);
      maxTotal = Math.max(maxTotal, total);
      maxCross = Math.max(maxCross, cross);

      const verticalExceed = vertical > thresholds.verticalWind;
      const tempExceed = tempRise > thresholds.tempRise;
      const totalExceed = total > thresholds.totalWind;
      const crossExceed = thresholds.crossWind > 0 && cross > thresholds.crossWind;

      if (verticalExceed || tempExceed || totalExceed || crossExceed) {
        points.push({
          i, j, k: kBest, position: p,
          vertical, total, tempRise, cross,
          verticalExceed, tempExceed, totalExceed, crossExceed,
        });
      }
    }
  }

  return { points, maxVertical, maxTempRise, maxTotal, maxCross, evaluated, missing };
}

/** 单方向结论（甲板层） */
export function verdictFromAssessment(a: DeckAssessment): { verdict: 'pass' | 'caution' | 'no-fly'; reasons: string[] } {
  const reasons: string[] = [];
  let noFly = false;
  let caution = false;
  for (const p of a.points) {
    if (p.verticalExceed) { noFly = true; reasons.push(`垂直风速 ${p.vertical.toFixed(2)} m/s 超限 @(${p.i},${p.j},${p.k})`); }
    if (p.tempExceed) { noFly = true; reasons.push(`温升 ${p.tempRise.toFixed(2)} K 超限 @(${p.i},${p.j},${p.k})`); }
    if (p.totalExceed) { caution = true; reasons.push(`总风速 ${p.total.toFixed(2)} m/s 超限 @(${p.i},${p.j},${p.k})`); }
    if (p.crossExceed) { caution = true; reasons.push(`侧风 ${p.cross.toFixed(2)} m/s 超限 @(${p.i},${p.j},${p.k})`); }
  }
  if (noFly) return { verdict: 'no-fly', reasons: dedupe(reasons) };
  if (caution) return { verdict: 'caution', reasons: dedupe(reasons) };
  return { verdict: 'pass', reasons: [] };
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)].slice(0, 50);
}
