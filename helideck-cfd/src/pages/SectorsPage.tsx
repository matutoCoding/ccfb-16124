import { useMemo, useState } from 'react';
import { useAppState } from '../state/appStore';
import { scanAllSectors } from '../domain/sectors';
import type { SectorAssessment, Verdict } from '../domain/types';

const VERDICT_STYLE: Record<Verdict, { fill: string; label: string }> = {
  pass: { fill: '#34d399', label: '可飞' },
  caution: { fill: '#fbbf24', label: '谨慎' },
  'no-fly': { fill: '#f87171', label: '禁飞' },
};

/**
 * 限制扇区页：36 个 10° 扇区的风玫瑰。
 * 每个扇区由 8 个 CFD 风向插值得到，结论走与原始网格完全相同的逐点规则。
 */
export function SectorsPage() {
  const { projects, currentProjectId, bundle } = useAppState();
  const project = projects.find((p) => p.id === currentProjectId) ?? null;
  const [selected, setSelected] = useState<number | null>(null);

  const scan = useMemo(() => {
    if (!bundle || !project) return null;
    return scanAllSectors(bundle.meta.grid, bundle.fields, project);
  }, [bundle, project]);

  if (!project) return <div className="empty">请先在「平台项目」选择平台</div>;
  if (!bundle) return <div className="empty">请先在「风场数据」页载入风场</div>;

  const sectors = scan!.sectors;
  const counts = sectors.reduce(
    (acc, s) => { acc[s.verdict]++; return acc; },
    { pass: 0, caution: 0, 'no-fly': 0 } as Record<Verdict, number>,
  );
  const selectedSector: SectorAssessment | null = selected !== null
    ? sectors.find((s) => s.bearingDeg === selected) ?? null
    : null;

  return (
    <div>
      <div className="page-head">
        <h1>限制扇区</h1>
        <p>8 个 CFD 风向插值扫描 36 个方向（10° 间隔），按 CAP437 阈值逐点判定；点击扇区查看极值与触发原因。</p>
      </div>

      <div className="grid-3">
        <div className="stat"><div className="k">可飞扇区</div><div className="v ok">{counts.pass}<span className="u"> / 36</span></div></div>
        <div className="stat"><div className="k">谨慎扇区</div><div className="v warn">{counts.caution}<span className="u"> / 36</span></div></div>
        <div className="stat"><div className="k">禁飞扇区</div><div className="v bad">{counts['no-fly']}<span className="u"> / 36</span></div></div>
      </div>

      <div className="wind-rose-wrap mt16">
        <div className="card" style={{ flex: '0 0 auto' }}>
          <WindRose sectors={sectors} onSelect={setSelected} selected={selected} />
          <div className="legend">
            <span><i style={{ background: VERDICT_STYLE.pass.fill }} />可飞</span>
            <span><i style={{ background: VERDICT_STYLE.caution.fill }} />谨慎（总风速/侧风超限）</span>
            <span><i style={{ background: VERDICT_STYLE['no-fly'].fill }} />禁飞（垂直风 &gt;{project.thresholds.verticalWind} m/s 或温升 &gt;{project.thresholds.tempRise} K）</span>
          </div>
        </div>

        <div className="card" style={{ flex: 1, minWidth: 320 }}>
          <h2>{selectedSector ? `${selectedSector.bearingDeg}° 扇区详情` : '扇区详情'}</h2>
          {!selectedSector && <div className="muted">点击风玫瑰上的任一扇区</div>}
          {selectedSector && (
            <>
              <div style={{ marginBottom: 12 }}>
                <span className="badge" style={{ background: `${VERDICT_STYLE[selectedSector.verdict].fill}22`, color: VERDICT_STYLE[selectedSector.verdict].fill }}>
                  结论：{VERDICT_STYLE[selectedSector.verdict].label}
                </span>
              </div>
              <table>
                <tbody>
                  <tr><td>最大垂直风速</td><td className={selectedSector.maxVertical > project.thresholds.verticalWind ? 'bad mono' : 'mono'}>
                    {selectedSector.maxVertical.toFixed(3)} m/s（阈值 {project.thresholds.verticalWind}）</td></tr>
                  <tr><td>最大温升</td><td className={selectedSector.maxTempRise > project.thresholds.tempRise ? 'bad mono' : 'mono'}>
                    {selectedSector.maxTempRise.toFixed(3)} K（阈值 {project.thresholds.tempRise}）</td></tr>
                  <tr><td>最大总风速</td><td className="mono">{selectedSector.maxTotal.toFixed(2)} m/s</td></tr>
                  <tr><td>最大侧风</td><td className="mono">{selectedSector.maxCross.toFixed(2)} m/s</td></tr>
                  <tr><td>航线超限采样点</td><td className="mono">{selectedSector.exceedanceCount}</td></tr>
                </tbody>
              </table>
              {selectedSector.reasons.length > 0 && (
                <>
                  <h3>触发规则（含原始网格 ijk 索引）</h3>
                  <ul className="mono" style={{ fontSize: 12, maxHeight: 260, overflow: 'auto', paddingLeft: 18 }}>
                    {selectedSector.reasons.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </>
              )}
            </>
          )}

          <h3 className="mt16">阈值设置（保存到项目）</h3>
          <div className="row">
            <label className="field"><span>垂直风速 (m/s)</span>
              <input type="number" step="0.1" value={project.thresholds.verticalWind}
                onChange={() => {/* 项目编辑在项目页，避免本页直接写库 */}} disabled /></label>
            <label className="field"><span>温升 (K)</span>
              <input type="number" step="0.1" value={project.thresholds.tempRise} disabled /></label>
          </div>
          <p className="muted" style={{ fontSize: 12 }}>阈值调整在「平台项目」页进行，修改后本页结论自动重算。</p>
        </div>
      </div>

      <div className="card mt16">
        <h2>全扇区明细表</h2>
        <div className="scroll-x">
          <table>
            <thead><tr><th>方位</th><th>结论</th><th>max|w| m/s</th><th>max ΔT K</th><th>max 总风速</th><th>航线超限点</th></tr></thead>
            <tbody>
              {sectors.map((s) => (
                <tr key={s.bearingDeg} onClick={() => setSelected(s.bearingDeg)}
                  style={{ cursor: 'pointer', ...(s.bearingDeg === selected ? { background: 'rgba(56,189,248,.1)' } : {}) }}>
                  <td className="mono">{s.bearingDeg}°</td>
                  <td><span className="badge" style={{ background: `${VERDICT_STYLE[s.verdict].fill}22`, color: VERDICT_STYLE[s.verdict].fill }}>
                    {VERDICT_STYLE[s.verdict].label}</span></td>
                  <td className="mono">{s.maxVertical.toFixed(2)}</td>
                  <td className="mono">{s.maxTempRise.toFixed(2)}</td>
                  <td className="mono">{s.maxTotal.toFixed(1)}</td>
                  <td className="mono">{s.exceedanceCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function WindRose({
  sectors, onSelect, selected,
}: {
  sectors: SectorAssessment[];
  onSelect: (bearing: number) => void;
  selected: number | null;
}) {
  const size = 380;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = 150;
  const rInner = 26;
  const sectorAngle = (360 / sectors.length) * (Math.PI / 180);

  // 气象惯例：0°(北) 在顶部，顺时针；SVG 角度以 +x 为 0，故旋转 -90°
  const polar = (bearingDeg: number, r: number) => {
    const a = (bearingDeg - 90) * (Math.PI / 180);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <circle key={f} cx={cx} cy={cy} r={rInner + (rOuter - rInner) * f}
          fill="none" stroke="#2a3a4e" strokeWidth="1" />
      ))}
      {sectors.map((s) => {
        const a0 = s.bearingDeg * (Math.PI / 180) - sectorAngle / 2;
        const a1 = a0 + sectorAngle;
        const p = (a: number, r: number) => [cx + r * Math.cos(a - Math.PI / 2), cy + r * Math.sin(a - Math.PI / 2)];
        const [x0, y0] = p(a0, rOuter);
        const [x1, y1] = p(a1, rOuter);
        const [x2, y2] = p(a1, rInner);
        const [x3, y3] = p(a0, rInner);
        const isSel = s.bearingDeg === selected;
        return (
          <path
            key={s.bearingDeg}
            d={`M${x0},${y0} A${rOuter},${rOuter} 0 0 1 ${x1},${y1} L${x2},${y2} A${rInner},${rInner} 0 0 0 ${x3},${y3} Z`}
            fill={VERDICT_STYLE[s.verdict].fill}
            fillOpacity={isSel ? 1 : 0.75}
            stroke="#0e141d"
            strokeWidth={isSel ? 2 : 1}
            onClick={() => onSelect(s.bearingDeg)}
            style={{ cursor: 'pointer' }}
          />
        );
      })}
      {['N', 'E', 'S', 'W'].map((label, i) => {
        const [x, y] = polar(i * 90, rOuter + 18);
        return <text key={label} x={x} y={y} fill="#8aa0b8" fontSize="14" fontWeight="700"
          textAnchor="middle" dominantBaseline="middle">{label}</text>;
      })}
      <text x={cx} y={cy - 6} fill="#dce6f2" fontSize="13" fontWeight="700" textAnchor="middle">CAP437</text>
      <text x={cx} y={cy + 11} fill="#8aa0b8" fontSize="10" textAnchor="middle">36 扇区</text>
    </svg>
  );
}
