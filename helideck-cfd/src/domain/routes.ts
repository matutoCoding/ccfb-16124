import type {
  DirectionField, GridSpec, PlatformProject, RouteAssessment, RouteSample, RuleThresholds,
} from './types';
import { sampleComponent } from './grid';
import { deckRegionFromProject } from './rules';

/**
 * 进近/离场航线（规则 6）。
 * 航线为过甲板中心、沿进近方位的水平直线，位于参考高度层；
 * 进近航段从外侧飞向甲板，离场航段反向，各取 2.5 倍甲板直径长度。
 * 沿航线按网格间距的 1/2 等距采样，三线性插值取场值。
 */

export interface RouteDef {
  name: string;
  /** 起点 */
  from: { x: number; y: number; z: number };
  /** 终点 */
  to: { x: number; y: number; z: number };
}

export function buildRoutes(project: PlatformProject): RouteDef[] {
  const region = deckRegionFromProject(project);
  if (!region) return [];
  const deck = project.modules.find((m) => m.type === 'helideck')!;
  const length = deck.helideck!.diameter * 2.5;
  const r = (region.approachBearingDeg * Math.PI) / 180;
  const dx = Math.sin(r);
  const dy = Math.cos(r);
  const z = region.refZ;
  const cx = region.center.x;
  const cy = region.center.y;
  return [
    {
      name: '进近航线',
      from: { x: cx + dx * length, y: cy + dy * length, z },
      to: { x: cx, y: cy, z },
    },
    {
      name: '离场航线',
      from: { x: cx, y: cy, z },
      to: { x: cx - dx * length, y: cy - dy * length, z },
    },
  ];
}

export function sampleRoute(
  grid: GridSpec,
  field: DirectionField,
  route: RouteDef,
  thresholds: RuleThresholds,
  ambientTempK: number,
  approachBearingDeg: number,
): RouteAssessment {
  const segLen = Math.hypot(route.to.x - route.from.x, route.to.y - route.from.y);
  const steps = Math.max(8, Math.ceil(segLen / (grid.spacing.x * 0.5)));
  const apprRad = (approachBearingDeg * Math.PI) / 180;
  const ax = Math.sin(apprRad);
  const ay = Math.cos(apprRad);

  const samples: RouteSample[] = [];
  for (let s = 0; s <= steps; s++) {
    const q = s / steps;
    const position = {
      x: route.from.x + (route.to.x - route.from.x) * q,
      y: route.from.y + (route.to.y - route.from.y) * q,
      z: route.from.z + (route.to.z - route.from.z) * q,
    };
    const u = sampleComponent(grid, field.u, position);
    const v = sampleComponent(grid, field.v, position);
    const w = sampleComponent(grid, field.w, position);
    const t = sampleComponent(grid, field.t, position);
    const valid = [u, v, w, t].every(Number.isFinite);
    const total = valid ? Math.hypot(u, v, w) : NaN;
    const cross = valid ? Math.abs(u * ay - v * ax) : NaN;
    const tempRise = valid ? t - ambientTempK : NaN;
    samples.push({
      distance: segLen * q,
      position,
      u: valid ? u : NaN,
      v: valid ? v : NaN,
      w: valid ? w : NaN,
      tempRise,
      totalSpeed: total,
      crossWind: cross,
      verticalExceed: valid && Math.abs(w) > thresholds.verticalWind,
      tempExceed: valid && tempRise > thresholds.tempRise,
    });
  }

  return {
    name: route.name,
    samples,
    verticalExceedSegments: extractSegments(samples, (x) => x.verticalExceed),
    tempExceedSegments: extractSegments(samples, (x) => x.tempExceed),
  };
}

/** 把连续超限的采样点合并为 [起,止] 距离段 */
function extractSegments(
  samples: RouteSample[],
  pred: (s: RouteSample) => boolean,
): [number, number][] {
  const segs: [number, number][] = [];
  let start: number | null = null;
  for (const s of samples) {
    if (pred(s)) {
      if (start === null) start = s.distance;
    } else if (start !== null) {
      segs.push([start, s.distance]);
      start = null;
    }
  }
  if (start !== null) segs.push([start, samples[samples.length - 1].distance]);
  return segs;
}
