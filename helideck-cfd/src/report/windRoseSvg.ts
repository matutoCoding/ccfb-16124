import type { RuleThresholds, SectorAssessment, Verdict } from '../domain/types';

const COLORS: Record<Verdict, string> = {
  pass: '#34d399',
  caution: '#fbbf24',
  'no-fly': '#f87171',
};

/** 生成风玫瑰 SVG 字符串（同时用于页面预览与 HTML 报告内联，无外部依赖） */
export function windRoseSvg(
  sectors: SectorAssessment[],
  _thresholds: RuleThresholds,
  size = 460,
): string {
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size * 0.39;
  const rInner = size * 0.07;
  const sectorAngle = (360 / sectors.length) * (Math.PI / 180);

  const rings = [0.25, 0.5, 0.75, 1]
    .map((f) => `<circle cx="${cx}" cy="${cy}" r="${(rInner + (rOuter - rInner) * f).toFixed(1)}" fill="none" stroke="#d7dee8" stroke-width="1"/>`)
    .join('');

  const wedges = sectors.map((s) => {
    const a0 = s.bearingDeg * (Math.PI / 180) - sectorAngle / 2;
    const a1 = a0 + sectorAngle;
    const p = (a: number, r: number) => [
      cx + r * Math.cos(a - Math.PI / 2),
      cy + r * Math.sin(a - Math.PI / 2),
    ].map((n) => n.toFixed(2)).join(',');
    return `<path d="M${p(a0, rOuter)} A${rOuter},${rOuter} 0 0 1 ${p(a1, rOuter)} L${p(a1, rInner)} A${rInner},${rInner} 0 0 0 ${p(a0, rInner)} Z" fill="${COLORS[s.verdict]}" stroke="#fff" stroke-width="1"><title>${s.bearingDeg}°: ${s.verdict}</title></path>`;
  }).join('');

  const labels = ['N', 'E', 'S', 'W'].map((label, i) => {
    const a = (i * 90 - 90) * (Math.PI / 180);
    const x = cx + (rOuter + 22) * Math.cos(a);
    const y = cy + (rOuter + 22) * Math.sin(a);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="16" font-weight="700" fill="#334155" text-anchor="middle" dominant-baseline="middle">${label}</text>`;
  }).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" font-family="sans-serif">
  <rect width="${size}" height="${size}" fill="#ffffff"/>
  ${rings}
  ${wedges}
  ${labels}
  <text x="${cx}" y="${cy - 6}" font-size="14" font-weight="700" fill="#1e293b" text-anchor="middle">CAP437</text>
  <text x="${cx}" y="${cy + 12}" font-size="11" fill="#64748b" text-anchor="middle">36 扇区 × 10°</text>
</svg>`;
}
