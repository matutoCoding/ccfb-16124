import { useMemo, useRef, useState } from 'react';
import { useAppState } from '../state/appStore';
import { importCsv, importJson } from '../domain/importer';
import { scanFieldQuality, mergeQuality } from '../domain/quality';
import { gridPointCount } from '../domain/grid';
import { fieldKey } from '../db/idb';
import { uid } from '../domain/platform';
import type { WindDataset } from '../domain/types';

export function WindDataPage() {
  const {
    projects, currentProjectId, selectProject, datasets,
    currentDatasetId, selectDataset, generateDataset, importDataset, removeDataset, bundle,
  } = useAppState();
  const [dsName, setDsName] = useState('');
  const [missing, setMissing] = useState(0);
  const [busy, setBusy] = useState(false);
  const [importGridText, setImportGridText] = useState('');
  const jsonRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);

  const project = projects.find((p) => p.id === currentProjectId) ?? null;
  const projectDatasets = datasets.filter((d) => d.projectId === currentProjectId);

  const qualitySummary = useMemo(() => {
    if (!bundle) return null;
    const reports = bundle.fields.map((f) => scanFieldQuality(bundle.meta.grid, f));
    return mergeQuality(reports);
  }, [bundle]);

  const onGenerate = async () => {
    if (!project) return alert('请先选择平台项目');
    setBusy(true);
    try {
      await generateDataset(dsName.trim() || `${project.name}-合成风场`, missing / 100);
      setDsName('');
    } finally {
      setBusy(false);
    }
  };

  const onJson = async (file: File) => {
    try {
      const r = importJson(await file.text());
      const reports = r.fields.map((f) => scanFieldQuality(r.grid, f));
      const id = uid('ds');
      const meta: WindDataset = {
        id, projectId: project!.id, name: file.name.replace(/\.[^.]+$/, ''),
        createdAt: Date.now(), grid: r.grid,
        directions: r.fields.map((f) => f.windDirDeg),
        ambientTempK: r.ambientTempK, source: 'import',
        fieldKeys: r.fields.map((_, i) => fieldKey(id, i)),
        quality: mergeQuality(reports),
      };
      await importDataset(meta, r.fields);
    } catch (err) {
      alert(`JSON 导入失败：${(err as Error).message}`);
    }
  };

  const onCsv = async (file: File) => {
    try {
      if (!importGridText.trim()) {
        return alert('CSV 导入需要先在下方粘贴网格定义 JSON（nx,ny,nz,origin,spacing）');
      }
      const grid = JSON.parse(importGridText);
      const r = importCsv(await file.text(), grid, project?.ambientTempK ?? 303.15);
      const reports = r.fields.map((f) => scanFieldQuality(r.grid, f));
      const id = uid('ds');
      const meta: WindDataset = {
        id, projectId: project!.id, name: file.name.replace(/\.[^.]+$/, ''),
        createdAt: Date.now(), grid: r.grid,
        directions: r.fields.map((f) => f.windDirDeg),
        ambientTempK: r.ambientTempK, source: 'import',
        fieldKeys: r.fields.map((_, i) => fieldKey(id, i)),
        quality: mergeQuality(reports),
      };
      await importDataset(meta, r.fields);
    } catch (err) {
      alert(`CSV 导入失败：${(err as Error).message}`);
    }
  };

  return (
    <div>
      <div className="page-head">
        <h1>风场数据</h1>
        <p>规则网格速度三分量 + 温度，每个风向一套；支持内置合成（8 风向、尾流与排气羽流）与外部 CFD 文件导入。</p>
      </div>

      <div className="card">
        <h2>所属平台</h2>
        <select value={currentProjectId ?? ''} onChange={(e) => selectProject(e.target.value || null)}>
          <option value="">— 请选择平台项目 —</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {project && (
        <div className="grid-2">
          <div className="card">
            <h2>生成合成风场（测试数据）</h2>
            <label className="field"><span>数据集名称</span>
              <input value={dsName} onChange={(e) => setDsName(e.target.value)} placeholder={`${project.name}-合成风场`} /></label>
            <label className="field"><span>缺测格点注入比例：{missing}%（验证坏数据提示）</span>
              <input type="range" min="0" max="15" value={missing} onChange={(e) => setMissing(+e.target.value)} /></label>
            <button onClick={onGenerate} disabled={busy}>{busy ? '生成中…' : '生成 8 风向合成风场'}</button>
            <p className="muted mt8" style={{ fontSize: 12 }}>
              合成模型包含：体块尾流亏损、近尾流回流区、前缘上洗、透平浮力羽流（弯曲+扩散+温升衰减）。
              确定性随机种子，同参数结果逐位可复现。
            </p>
          </div>

          <div className="card">
            <h2>导入 CFD 结果</h2>
            <p className="muted" style={{ fontSize: 12 }}>
              JSON：grid 定义 + 每风向 u/v/w/t（base64-f32 或 number[]，null=缺测）。
              CSV：表头 windDirDeg,i,j,k,u,v,w,t，缺失行按缺测处理。
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn-ghost" onClick={() => jsonRef.current?.click()}>导入 JSON</button>
              <button className="btn-ghost" onClick={() => csvRef.current?.click()}>导入 CSV</button>
              <button className="btn-ghost" onClick={downloadTemplate(project)}>下载 JSON 模板</button>
            </div>
            <input ref={jsonRef} type="file" accept=".json" hidden onChange={(e) => e.target.files?.[0] && onJson(e.target.files[0])} />
            <input ref={csvRef} type="file" accept=".csv" hidden onChange={(e) => e.target.files?.[0] && onCsv(e.target.files[0])} />
            <h3>CSV 网格定义（粘贴 JSON）</h3>
            <textarea
              rows={4} style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
              placeholder='{"nx":34,"ny":23,"nz":15,"origin":{"x":-84,"y":-40,"z":0},"spacing":{"x":4,"y":4,"z":4}}'
              value={importGridText} onChange={(e) => setImportGridText(e.target.value)}
            />
          </div>
        </div>
      )}

      <div className="card">
        <h2>数据集列表</h2>
        {projectDatasets.length === 0 && <div className="empty">当前平台还没有风场数据</div>}
        <table>
          <thead><tr><th>名称</th><th>来源</th><th>网格</th><th>风向</th><th>数据质量</th><th style={{ width: 170 }}>操作</th></tr></thead>
          <tbody>
            {projectDatasets.map((d) => {
              const q = d.quality;
              return (
                <tr key={d.id} style={d.id === currentDatasetId ? { background: 'rgba(56,189,248,.08)' } : undefined}>
                  <td>{d.name}</td>
                  <td><span className={`badge ${d.source === 'synthetic' ? 'badge-blue' : 'badge-purple badge'}`}>
                    {d.source === 'synthetic' ? '合成' : '导入'}</span></td>
                  <td className="mono">{d.grid.nx}×{d.grid.ny}×{d.grid.nz} = {gridPointCount(d.grid).toLocaleString()} 点</td>
                  <td>{d.directions.map((x) => `${x}°`).join(' ')}</td>
                  <td>
                    {!q && <span className="badge badge-gray">未检查</span>}
                    {q && (q.missingCount === 0 && q.badCount === 0) && <span className="badge badge-green">合格</span>}
                    {q && q.missingCount > 0 && <span className="badge badge-amber">缺测 {q.missingCount}</span>}
                    {q && q.badCount > q.missingCount && <span className="badge badge-red">异常 {q.badCount - q.missingCount}</span>}
                  </td>
                  <td>
                    <button className="btn-sm btn-ghost" onClick={() => selectDataset(d.id)}>载入</button>{' '}
                    <button className="btn-sm btn-danger" onClick={() => confirm(`删除数据集「${d.name}」？`) && removeDataset(d.id)}>删除</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {bundle && (
        <div className="card">
          <h2>质量报告：{bundle.meta.name}</h2>
          {qualitySummary && (
            <>
              <div className="grid-3">
                <div className="stat"><div className="k">总网格点（8 风向合计）</div><div className="v">{qualitySummary.totalPoints.toLocaleString()}</div></div>
                <div className="stat"><div className="k">缺测格点</div>
                  <div className={`v ${qualitySummary.missingCount ? 'warn' : 'ok'}`}>{qualitySummary.missingCount}</div></div>
                <div className="stat"><div className="k">坏数据条目</div>
                  <div className={`v ${qualitySummary.badCount ? 'bad' : 'ok'}`}>{qualitySummary.badCount}</div></div>
              </div>
              {qualitySummary.samples.length > 0 && (
                <>
                  <h3>异常明细（前 {qualitySummary.samples.length} 条，含 ijk 索引可回查 CFD 原始文件）</h3>
                  <div className="scroll-x">
                    <table>
                      <thead><tr><th>i</th><th>j</th><th>k</th><th>原因</th><th>分量</th><th>值</th></tr></thead>
                      <tbody>
                        {qualitySummary.samples.map((s, ix) => (
                          <tr key={ix}>
                            <td className="mono">{s.i}</td><td className="mono">{s.j}</td><td className="mono">{s.k}</td>
                            <td><span className="badge badge-amber">{s.reason}</span></td>
                            <td className="mono">{s.field ?? '—'}</td>
                            <td className="mono">{s.value ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function downloadTemplate(project: { ambientTempK: number }) {
  return () => {
    const grid = {
      nx: 10, ny: 10, nz: 8,
      origin: { x: -20, y: -20, z: 0 },
      spacing: { x: 4, y: 4, z: 4 },
    };
    const n = grid.nx * grid.ny * grid.nz;
    const f32ToB64 = (fill: number) => {
      const bytes = new Uint8Array(n * 4);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < n; i++) view.setFloat32(i * 4, fill, true);
      let bin = '';
      bytes.forEach((b) => { bin += String.fromCharCode(b); });
      return btoa(bin);
    };
    const tpl = {
      grid, windSpeed: 15, ambientTempK: project.ambientTempK,
      directions: [0, 45, 90, 135, 180, 225, 270, 315].map((windDirDeg) => ({
        windDirDeg, encoding: 'base64-f32',
        u: f32ToB64(0), v: f32ToB64(-15), w: f32ToB64(0), t: f32ToB64(project.ambientTempK),
      })),
    };
    const blob = new Blob([JSON.stringify(tpl, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cfd-import-template.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
}
