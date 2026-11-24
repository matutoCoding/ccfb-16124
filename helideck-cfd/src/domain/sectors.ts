import type {
  DirectionField, GridSpec, PlatformProject, SectorAssessment, Vec3,
} from './types';
import { blendComponent, findWindBracket } from './angle';
import { assessDeckLevel, deckRegionFromProject, verdictFromAssessment } from './rules';
import { sampleRoute, buildRoutes } from './routes';

/**
 * 36 扇区扫描（规则 7）。
 * 在导入/生成的 8 个风向之间做矢量线性插值，得到 10° 间隔的 36 个方向，
 * 每个方向都走与原始风向完全相同的逐点 CAP437 判定，
 * 输出风玫瑰用的限制扇区结论。
 */

export const SECTOR_COUNT = 36;
export const SECTOR_STEP = 360 / SECTOR_COUNT;

/** 两个风向场逐格点混合（NaN 按缺测规则处理，见 blendComponent） */
export function blendFields(
  a: DirectionField,
  b: DirectionField,
  t: number,
  bearingDeg: number,
): DirectionField {
  const n = a.u.length;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const w = new Float32Array(n);
  const tp = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    u[i] = blendComponent(a.u[i], b.u[i], t);
    v[i] = blendComponent(a.v[i], b.v[i], t);
    w[i] = blendComponent(a.w[i], b.w[i], t);
    tp[i] = blendComponent(a.t[i], b.t[i], t);
  }
  return {
    windDirDeg: bearingDeg,
    windSpeed: a.windSpeed + (b.windSpeed - a.windSpeed) * t,
    u, v, w, t: tp,
  };
}

export interface SectorScanResult {
  sectors: SectorAssessment[];
}

/**
 * 全扇区扫描。
 * @param fields 已知风向场（任意数量，通常 8）
 * @param fieldAt 按需取场的回调（IDB 场景由应用层注入）
 */
export function scanAllSectors(
  grid: GridSpec,
  fields: DirectionField[],
  project: PlatformProject,
): SectorScanResult {
  const region = deckRegionFromProject(project);
  if (!region) throw new Error('平台缺少直升机甲板模块');
  const routes = buildRoutes(project);
  const bearings = fields.map((f) => f.windDirDeg);

  const sectors: SectorAssessment[] = [];
  for (let s = 0; s < SECTOR_COUNT; s++) {
    const bearing = s * SECTOR_STEP;
    const { left, right, t } = findWindBracket(bearings, bearing);
    const field = t === 0 || left === right
      ? fields[left]
      : blendFields(fields[left], fields[right], t, bearing);

    const deck = assessDeckLevel(grid, field, region, project.thresholds, project.ambientTempK);
    const { verdict, reasons } = verdictFromAssessment(deck);

    let exceedanceCount = 0;
    for (const route of routes) {
      const ra = sampleRoute(
        grid, field, route, project.thresholds,
        project.ambientTempK, region.approachBearingDeg,
      );
      exceedanceCount += ra.samples.filter((x) => x.verticalExceed || x.tempExceed).length;
    }

    sectors.push({
      bearingDeg: bearing,
      verdict: exceedanceCount > 0 && verdict === 'pass' ? 'caution' : verdict,
      reasons,
      maxVertical: deck.maxVertical,
      maxTempRise: deck.maxTempRise,
      maxTotal: deck.maxTotal,
      maxCross: deck.maxCross,
      exceedanceCount,
    });
  }
  return { sectors };
}

/** 任意目标方位角的混合场（可视化页面过渡动画用，规则 8） */
export function fieldAtBearing(
  fields: DirectionField[],
  bearingDeg: number,
): { field: DirectionField; left: number; right: number; t: number } {
  const bearings = fields.map((f) => f.windDirDeg);
  const { left, right, t } = findWindBracket(bearings, bearingDeg);
  const field = t === 0 || left === right
    ? fields[left]
    : blendFields(fields[left], fields[right], t, bearingDeg);
  return { field, left, right, t };
}

/** 工具：矢量场按标量比例缩放温度（透平工况联动，透传到扇区） */
export function applyTempRatioToFields(
  fields: DirectionField[],
  ambientTempK: number,
  ratio: number,
): DirectionField[] {
  return fields.map((f) => {
    const t = new Float32Array(f.t.length);
    for (let i = 0; i < f.t.length; i++) {
      t[i] = Number.isFinite(f.t[i]) ? ambientTempK + (f.t[i] - ambientTempK) * ratio : NaN;
    }
    return { ...f, t };
  });
}

export function bearingLabel(deg: number): string {
  const names = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return `${deg.toFixed(0)}° ${names[Math.round(deg / 45) % 8]}`;
}

export type { Vec3 };
