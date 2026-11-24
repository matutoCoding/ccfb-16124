/**
 * 风向 / 角度工具。
 * 风向为气象方位角：风吹来的方向，0=北，90=东，顺时针，单位度。
 */

/** 风向角 + 风速 -> 速度分量（u 东向，v 北向）。北风(0°)吹向南方 => v 为负。 */
export function windDirToVector(bearingDeg: number, speed: number): { u: number; v: number } {
  const r = (bearingDeg * Math.PI) / 180;
  return { u: -speed * Math.sin(r), v: -speed * Math.cos(r) };
}

/** 速度分量 -> 风向角（吹来方向），结果归一化到 [0,360) */
export function vectorToWindDir(u: number, v: number): number {
  // 运动方向方位角
  const travel = (Math.atan2(u, v) * 180) / Math.PI;
  return normalizeAngle(travel + 180);
}

/** 归一化到 [0,360) */
export function normalizeAngle(deg: number): number {
  const a = deg % 360;
  return a < 0 ? a + 360 : a;
}

/** 两方向角之差 a-b，结果落在 (-180,180] */
export function angleDiff(a: number, b: number): number {
  let d = normalizeAngle(a) - normalizeAngle(b);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** 圆周插值（角度） */
export function interpolateAngle(a: number, b: number, t: number): number {
  return normalizeAngle(a + angleDiff(b, a) * t);
}

/**
 * 在两个按风向排序的场之间做矢量线性插值（CFD 风向扫描的通用做法）。
 * NaN 为缺测：任一端缺测时取有效端，两端都缺测则结果缺测。
 */
export function blendComponent(a: number, b: number, t: number): number {
  const aBad = !Number.isFinite(a);
  const bBad = !Number.isFinite(b);
  if (aBad && bBad) return NaN;
  if (aBad) return b;
  if (bBad) return a;
  return a + (b - a) * t;
}

/**
 * 给定一组已有的风向（升序），找目标方位角所在的相邻风向区间。
 * 返回左右风向索引与插值系数 t（考虑 360° 环绕）。
 */
export function findWindBracket(
  bearings: number[],
  target: number,
): { left: number; right: number; t: number } {
  const sorted = [...bearings].map(normalizeAngle).sort((a, b) => a - b);
  const n = sorted.length;
  const tgt = normalizeAngle(target);
  // 正好落在某个已有风向上：直接命中，t=0
  const exact = bearings.findIndex((x) => Math.abs(angleDiff(x, tgt)) < 1e-9);
  if (exact >= 0) return { left: exact, right: exact, t: 0 };
  // 只有一个可用风向时全部取它
  if (n === 1) return { left: 0, right: 0, t: 0 };
  for (let i = 0; i < n; i++) {
    const a = sorted[i];
    const b = sorted[(i + 1) % n];
    if (i < n - 1) {
      if (tgt > a && tgt < b) {
        return { left: bearings.findIndex((x) => normalizeAngle(x) === a), right: bearings.findIndex((x) => normalizeAngle(x) === b), t: (tgt - a) / (b - a) };
      }
    } else {
      // 环绕区间 [a, b+360)
      const bWrap = b + 360;
      const tWrap = tgt < sorted[0] ? tgt + 360 : tgt;
      if (tWrap > a && tWrap < bWrap) {
        return { left: bearings.findIndex((x) => normalizeAngle(x) === a), right: bearings.findIndex((x) => normalizeAngle(x) === b), t: (tWrap - a) / (bWrap - a) };
      }
    }
  }
  return { left: 0, right: 0, t: 0 };
}
