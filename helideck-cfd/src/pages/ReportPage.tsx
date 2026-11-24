import { useMemo, useState } from 'react';
import { useAppState } from '../state/appStore';
import { scanAllSectors } from '../domain/sectors';
import { assessDeckLevel, deckRegionFromProject, type ExceedancePoint } from '../domain/rules';
import { verdictFromAssessment } from '../domain/rules';
import type { Verdict } from '../domain/types';
import { windRoseSvg } from '../report/windRoseSvg';
import { buildReportHtml } from '../report/reportExport';

const VERDICT_LABEL: Record<Verdict, string> = {
  pass: '可飞', caution: '谨慎', 'no-fly': '禁飞',
};

/**
 * 评审报告页（规则 10）。
 * 导出物：单个自包含 HTML（风玫瑰 SVG 内联 + 逐风向摘要 + 超限点清单表），
 * 可直接邮件发送给直升机公司；另附 JSON 原始数据下载。
 */
export function ReportPage() {
  const { projects, currentProjectId, bundle } = useAppState();
  const project = projects.find((p) => p.id === currentProjectId) ?? null;
  const [recipient, setRecipient] = useState('直升机运营公司');
  const [exporting, setExporting] = useState(false);

  const scan = useMemo(() => {
    if (!bundle || !project) return null;
    return scanAllSectors(bundle.meta.grid, bundle.fields, project);
  }, [bundle, project]);

  const perDirection = useMemo(() => {
    if (!bundle || !project) return [];
    const region = deckRegionFromProject(project);
    if (!region) return [];
    return bundle.fields.map((f) => {
      const a = assessDeckLevel(
        bundle.meta.grid, f, region, project.thresholds, project.ambientTempK,
      );
      const { verdict, reasons } = verdictFromAssessment(a);
      return { field: f, assessment: a, verdict, reasons };
    });
  }, [bundle, project]);

  if (!project) return <div className="empty">请先选择平台项目</div>;
  if (!bundle || !scan) return <div className="empty">请先载入风场数据集</div>;

  const allExceedances: (ExceedancePoint & { windDirDeg: number })[] = perDirection.flatMap((d) =>
    d.assessment.points.map((p) => ({ ...p, windDirDeg: d.field.windDirDeg })));

  const doExport = async () => {
    setExporting(true);
    try {
      const rose = windRoseSvg(scan.sectors, project.thresholds);
      const html = buildReportHtml({
        project,
        datasetName: bundle.meta.name,
        generatedAt: new Date().toLocaleString('zh-CN'),
        recipient,
        roseSvg: rose,
        sectors: scan.sectors,
        perDirection: perDirection.map((d) => ({
          windDirDeg: d.field.windDirDeg,
          verdict: d.verdict,
          reasons: d.reasons,
          maxVertical: d.assessment.maxVertical,
          maxTempRise: d.assessment.maxTempRise,
          maxTotal: d.assessment.maxTotal,
          evaluated: d.assessment.evaluated,
          missing: d.assessment.missing,
          exceedCount: d.assessment.points.length,
        })),
        exceedances: allExceedances,
        ambientTempK: project.ambientTempK,
      });
      download(`${project.name}-CAP437评审报告.html`, new Blob([html], { type: 'text/html;charset=utf-8' }));

      const json = JSON.stringify({
        project: project.name,
        dataset: bundle.meta.name,
        generatedAt: new Date().toISOString(),
        thresholds: project.thresholds,
        sectors: scan.sectors,
        exceedances: allExceedances,
      }, null, 2);
      download(`${project.name}-超限数据.json`, new Blob([json], { type: 'application/json' }));
    } finally {
      setExporting(false);
    }
  };

  return (
    <div>
      <div className="page-head">
        <h1>评审报告</h1>
        <p>汇总限制扇区图、8 个风向的逐点评估结果与超限点清单（含原始网格 ijk 索引），导出后可直接发送直升机公司。</p>
      </div>

      <div className="card">
        <h2>导出设置</h2>
        <div className="row">
          <label className="field"><span>接收方</span>
            <input value={recipient} onChange={(e) => setRecipient(e.target.value)} /></label>
          <label className="field"><span>平台 / 数据集</span>
            <input value={`${project.name} / ${bundle.meta.name}`} disabled /></label>
        </div>
        <button onClick={doExport} disabled={exporting}>
          {exporting ? '生成中…' : '导出 HTML 评审报告 + JSON 超限数据'}
        </button>
        <p className="muted mt8" style={{ fontSize: 12 }}>
          报告含：风玫瑰限制扇区图（SVG 矢量）、每风向极值与结论、超限点清单（ijk 索引 + 世界坐标 + 实测值）、评估阈值与缺测统计。
          3D 切片截图请在「气流可视化」页用系统截图工具粘贴到报告附件（浏览器安全策略下网页无法自动抓取 WebGPU 画布以外的内容）。
        </p>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>逐风向结论（原始 CFD 风向）</h2>
          <table>
            <thead><tr><th>风向</th><th>结论</th><th>max|w|</th><th>max ΔT</th><th>超限点</th><th>缺测</th></tr></thead>
            <tbody>
              {perDirection.map((d) => (
                <tr key={d.field.windDirDeg}>
                  <td className="mono">{d.field.windDirDeg}°</td>
                  <td><span className={`badge ${d.verdict === 'pass' ? 'badge-green' : d.verdict === 'caution' ? 'badge-amber' : 'badge-red'}`}>
                    {VERDICT_LABEL[d.verdict]}</span></td>
                  <td className="mono">{d.assessment.maxVertical.toFixed(2)}</td>
                  <td className="mono">{d.assessment.maxTempRise.toFixed(2)}</td>
                  <td className="mono">{d.assessment.points.length}</td>
                  <td className="mono">{d.assessment.missing}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>超限点清单预览（共 {allExceedances.length} 点，报告含全量）</h2>
          <div className="scroll-x" style={{ maxHeight: 360, overflow: 'auto' }}>
            <table>
              <thead><tr><th>风向</th><th>ijk</th><th>|w| m/s</th><th>ΔT K</th><th>类型</th></tr></thead>
              <tbody>
                {allExceedances.slice(0, 100).map((p, i) => (
                  <tr key={i}>
                    <td className="mono">{p.windDirDeg}°</td>
                    <td className="mono">({p.i},{p.j},{p.k})</td>
                    <td className={p.verticalExceed ? 'bad mono' : 'mono'}>{p.vertical.toFixed(2)}</td>
                    <td className={p.tempExceed ? 'bad mono' : 'mono'}>{p.tempRise.toFixed(2)}</td>
                    <td>
                      {p.verticalExceed && <span className="badge badge-red">垂直风</span>}{' '}
                      {p.tempExceed && <span className="badge badge-red">温升</span>}{' '}
                      {p.totalExceed && <span className="badge badge-amber">总风速</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {allExceedances.length > 100 && <p className="muted">仅预览前 100 条，导出报告包含全部 {allExceedances.length} 条</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function download(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
