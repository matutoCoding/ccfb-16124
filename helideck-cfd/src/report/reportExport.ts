import type {
  PlatformProject, RuleThresholds, SectorAssessment, Verdict,
} from '../domain/types';
import type { ExceedancePoint } from '../domain/rules';

export interface ReportData {
  project: PlatformProject;
  datasetName: string;
  generatedAt: string;
  recipient: string;
  roseSvg: string;
  sectors: SectorAssessment[];
  perDirection: {
    windDirDeg: number;
    verdict: Verdict;
    reasons: string[];
    maxVertical: number;
    maxTempRise: number;
    maxTotal: number;
    evaluated: number;
    missing: number;
    exceedCount: number;
  }[];
  exceedances: (ExceedancePoint & { windDirDeg: number })[];
  ambientTempK: number;
}

const VERDICT_TEXT: Record<Verdict, string> = {
  pass: '可飞', caution: '谨慎', 'no-fly': '禁飞',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]!));
}

/** 自包含 HTML 报告：内联 CSS 与 SVG，无外部资源，可直接邮件发送 */
export function buildReportHtml(d: ReportData): string {
  const t: RuleThresholds = d.project.thresholds;
  const counts = d.sectors.reduce(
    (acc, s) => { acc[s.verdict]++; return acc; },
    { pass: 0, caution: 0, 'no-fly': 0 } as Record<Verdict, number>,
  );

  const dirRows = d.perDirection.map((r) => `
    <tr>
      <td class="mono">${r.windDirDeg}°</td>
      <td><span class="badge ${r.verdict}">${VERDICT_TEXT[r.verdict]}</span></td>
      <td class="mono">${r.maxVertical.toFixed(3)}</td>
      <td class="mono">${r.maxTempRise.toFixed(3)}</td>
      <td class="mono">${r.maxTotal.toFixed(2)}</td>
      <td class="mono">${r.evaluated}</td>
      <td class="mono">${r.missing}</td>
      <td class="mono">${r.exceedCount}</td>
    </tr>`).join('');

  const sectorRows = d.sectors.map((s) => `
    <tr>
      <td class="mono">${s.bearingDeg}°</td>
      <td><span class="badge ${s.verdict}">${VERDICT_TEXT[s.verdict]}</span></td>
      <td class="mono">${s.maxVertical.toFixed(3)}</td>
      <td class="mono">${s.maxTempRise.toFixed(3)}</td>
      <td class="mono">${s.maxTotal.toFixed(2)}</td>
      <td class="mono">${s.exceedanceCount}</td>
    </tr>`).join('');

  const exRows = d.exceedances.map((p) => `
    <tr>
      <td class="mono">${p.windDirDeg}°</td>
      <td class="mono">(${p.i}, ${p.j}, ${p.k})</td>
      <td class="mono">(${p.position.x.toFixed(2)}, ${p.position.y.toFixed(2)}, ${p.position.z.toFixed(2)})</td>
      <td class="mono ${p.verticalExceed ? 'bad' : ''}">${p.vertical.toFixed(3)}</td>
      <td class="mono ${p.tempExceed ? 'bad' : ''}">${p.tempRise.toFixed(3)}</td>
      <td class="mono">${p.total.toFixed(2)}</td>
      <td>${[p.verticalExceed && '垂直风速', p.tempExceed && '温升', p.totalExceed && '总风速', p.crossExceed && '侧风'].filter(Boolean).join('、') || '—'}</td>
    </tr>`).join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(d.project.name)} CAP437 直升机甲板气流与排烟评审报告</title>
<style>
  body { font-family: 'Microsoft YaHei', 'Segoe UI', sans-serif; color: #1f2937; margin: 0; padding: 32px; background: #f8fafc; }
  .doc { max-width: 980px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 36px 42px; }
  h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 17px; margin: 28px 0 10px; border-left: 4px solid #0ea5e9; padding-left: 10px; }
  .meta { color: #64748b; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 8px; }
  th { background: #f1f5f9; text-align: left; padding: 7px 8px; border-bottom: 2px solid #cbd5e1; }
  td { padding: 6px 8px; border-bottom: 1px solid #e2e8f0; }
  .mono { font-family: Consolas, monospace; }
  .badge { padding: 2px 10px; border-radius: 999px; font-weight: 700; font-size: 11px; color: #fff; }
  .badge.pass { background: #10b981; } .badge.caution { background: #f59e0b; } .badge.no-fly { background: #ef4444; }
  .bad { color: #dc2626; font-weight: 700; }
  .summary { display: flex; gap: 14px; margin: 14px 0; }
  .stat { flex: 1; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px; text-align: center; }
  .stat .n { font-size: 28px; font-weight: 800; }
  .stat.pass .n { color: #10b981; } .stat.caution .n { color: #f59e0b; } .stat.no-fly .n { color: #ef4444; }
  .note { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 12px 14px; font-size: 12px; color: #92400e; margin-top: 14px; }
  .foot { margin-top: 36px; padding-top: 16px; border-top: 1px solid #e2e8f0; color: #94a3b8; font-size: 11px; }
</style></head>
<body><div class="doc">
  <h1>直升机甲板气流与排烟评估报告（CAP437）</h1>
  <div class="meta">
    平台：<b>${esc(d.project.name)}</b> ｜ 数据集：${esc(d.datasetName)} ｜ 生成时间：${d.generatedAt}<br>
    致：${esc(d.recipient)} ｜ 环境温度：${d.ambientTempK.toFixed(2)} K ｜ 甲板参考高度：${d.project.refHeightM.toFixed(3)} m（30 ft）
  </div>

  <h2>1. 评估准则</h2>
  <div class="meta">
    垂直风速阈值 |w| &gt; <b>${t.verticalWind} m/s</b>；温升阈值 ΔT &gt; <b>${t.tempRise} K</b>；
    总风速阈值 &gt; <b>${t.totalWind} m/s</b>${t.crossWind > 0 ? `；侧风阈值 &gt; <b>${t.crossWind} m/s</b>` : ''}。
    垂直风或温升超限判禁飞，总风速/侧风超限判谨慎。判定直接遍历 CFD 规则网格参考层格点，未做插值平滑。
  </div>

  <h2>2. 限制扇区风玫瑰（36 方向 × 10°）</h2>
  <div class="summary">
    <div class="stat pass"><div class="n">${counts.pass}</div><div>可飞扇区</div></div>
    <div class="stat caution"><div class="n">${counts.caution}</div><div>谨慎扇区</div></div>
    <div class="stat no-fly"><div class="n">${counts['no-fly']}</div><div>禁飞扇区</div></div>
  </div>
  ${d.roseSvg}

  <h2>3. 原始 CFD 风向逐点评估（${d.perDirection.length} 个风向）</h2>
  <table><thead><tr><th>风向</th><th>结论</th><th>max|w| m/s</th><th>max ΔT K</th><th>max 总风速 m/s</th><th>评估点数</th><th>缺测</th><th>超限点</th></tr></thead>
  <tbody>${dirRows}</tbody></table>

  <h2>4. 全扇区扫描明细</h2>
  <table><thead><tr><th>方位</th><th>结论</th><th>max|w|</th><th>max ΔT</th><th>max 总风速</th><th>航线超限点</th></tr></thead>
  <tbody>${sectorRows}</tbody></table>

  <h2>5. 超限点清单（${d.exceedances.length} 点，含原始网格索引与世界坐标）</h2>
  ${d.exceedances.length === 0 ? '<div class="meta">本数据集在当前阈值下无超限点。</div>' : `
  <table><thead><tr><th>风向</th><th>网格 ijk</th><th>世界坐标 (m)</th><th>|w| m/s</th><th>ΔT K</th><th>总风速</th><th>超限类型</th></tr></thead>
  <tbody>${exRows}</tbody></table>`}

  <div class="note">
    说明：本报告由直升机甲板气流与排烟评估系统自动生成。扇区结论基于 ${d.perDirection.length} 个 CFD 风向的圆周矢量插值（10° 间隔）；
    超限点坐标为 CFD 规则网格节点坐标，可与原始计算结果逐点核对。缺测格点不参与统计。
  </div>
  <div class="foot">Helideck CFD Assessment System · 数据本地处理，未上传外部服务器</div>
</div></body></html>`;
}
