import { useMemo, useRef, useState } from 'react';
import { useAppState } from '../state/appStore';
import type { ModuleType, PlatformModule, PlatformProject, TurbineConfig } from '../domain/types';
import { blocksToModules, uid } from '../domain/platform';
import { moduleAABB } from '../domain/platform';

const TYPE_LABELS: Record<ModuleType, string> = {
  living: '生活楼', flare: '火炬臂', exhaust: '透平排气口',
  crane: '吊机', helideck: '直升机甲板', block: '简化体块',
};

export function ProjectsPage() {
  const {
    projects, createProject, updateProject, removeProject,
    currentProjectId, selectProject, applyTurbineChange,
  } = useAppState();
  const [newName, setNewName] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const project = projects.find((p) => p.id === currentProjectId) ?? null;

  const create = async () => {
    const p = await createProject(newName.trim() || `平台 ${projects.length + 1}`);
    selectProject(p.id);
    setNewName('');
  };

  return (
    <div>
      <div className="page-head">
        <h1>平台项目</h1>
        <p>按模块搭建平台几何，甲板标高、气隙与透平工况均可修改；体块数据可从 JSON 导入。</p>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>项目列表</h2>
          <div className="row" style={{ marginBottom: 12 }}>
            <input placeholder="新项目名称" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button style={{ flex: '0 0 auto' }} onClick={create}>新建项目</button>
          </div>
          {projects.length === 0 && <div className="empty">还没有项目，点击"新建项目"生成演示平台</div>}
          <table>
            <thead><tr><th>名称</th><th>模块数</th><th>甲板标高</th><th style={{ width: 150 }}>操作</th></tr></thead>
            <tbody>
              {projects.map((p) => (
                <tr key={p.id} style={p.id === currentProjectId ? { background: 'rgba(56,189,248,.08)' } : undefined}>
                  <td>{p.name}</td>
                  <td>{p.modules.length}</td>
                  <td>{p.deckElevation} m</td>
                  <td>
                    <button className="btn-sm btn-ghost" onClick={() => selectProject(p.id)}>编辑</button>{' '}
                    <button className="btn-sm btn-danger" onClick={() => confirm(`删除项目「${p.name}」及其风场数据？`) && removeProject(p.id)}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {project ? <ProjectEditor key={project.id} project={project} onSave={updateProject} onTurbine={applyTurbineChange} onImportClick={() => fileRef.current?.click()} />
          : <div className="card empty">选择左侧项目进行编辑</div>}
      </div>

      <input
        ref={fileRef} type="file" accept=".json" hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file || !project) return;
          try {
            const text = await file.text();
            const blocks = JSON.parse(text);
            if (!Array.isArray(blocks)) throw new Error('文件应为体块数组');
            const mods = blocksToModules(blocks);
            await updateProject({ ...project, modules: [...project.modules, ...mods], updatedAt: Date.now() });
            alert(`已导入 ${mods.length} 个体块`);
          } catch (err) {
            alert(`导入失败：${(err as Error).message}`);
          }
          e.target.value = '';
        }}
      />
    </div>
  );
}

function ProjectEditor({
  project, onSave, onTurbine, onImportClick,
}: {
  project: PlatformProject;
  onSave: (p: PlatformProject) => Promise<void>;
  onTurbine: (p: PlatformProject) => Promise<void>;
  onImportClick: () => void;
}) {
  const [draft, setDraft] = useState<PlatformProject>(structuredClone(project));
  const dirty = JSON.stringify(draft) !== JSON.stringify(project);

  const patch = (p: Partial<PlatformProject>) => setDraft((d) => ({ ...d, ...p }));

  const updateModule = (id: string, p: Partial<PlatformModule>) =>
    setDraft((d) => ({ ...d, modules: d.modules.map((m) => (m.id === id ? { ...m, ...p } : m)) }));

  const addModule = (type: ModuleType) => {
    const m: PlatformModule = {
      id: uid('mod'), name: TYPE_LABELS[type], type,
      position: { x: 0, y: 0, z: 5 }, size: { x: 8, y: 8, z: 10 },
    };
    if (type === 'exhaust') {
      m.exhaust = { turbineId: `tb-${Date.now()}`, massFlow: 30, temperatureK: 620 };
    }
    if (type === 'helideck') {
      m.helideck = { diameter: 22.2, approachBearingDeg: 0 };
    }
    setDraft((d) => ({ ...d, modules: [...d.modules, m] }));
  };

  const removeModule = (id: string) =>
    setDraft((d) => ({ ...d, modules: d.modules.filter((m) => m.id !== id) }));

  const updateTurbine = (id: string, patchT: Partial<TurbineConfig>) =>
    setDraft((d) => ({ ...d, turbines: d.turbines.map((t) => (t.id === id ? { ...t, ...patchT } : t)) }));

  const deck = useMemo(() => draft.modules.find((m) => m.type === 'helideck'), [draft.modules]);

  return (
    <div className="card">
      <div className="flex-between">
        <h2 style={{ margin: 0 }}>编辑：{draft.name}</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-ghost btn-sm" onClick={onImportClick}>导入简化体块</button>
          <button disabled={!dirty} onClick={() => onSave(draft)}>保存修改</button>
        </div>
      </div>

      <h3>总体参数</h3>
      <div className="row">
        <label className="field"><span>项目名称</span>
          <input value={draft.name} onChange={(e) => patch({ name: e.target.value })} /></label>
        <label className="field"><span>甲板标高 (m)</span>
          <input type="number" value={draft.deckElevation} onChange={(e) => patch({ deckElevation: +e.target.value })} /></label>
        <label className="field"><span>气隙 (m)</span>
          <input type="number" value={draft.airGap} onChange={(e) => patch({ airGap: +e.target.value })} /></label>
      </div>
      <div className="row">
        <label className="field"><span>环境温度 (K)</span>
          <input type="number" step="0.1" value={draft.ambientTempK} onChange={(e) => patch({ ambientTempK: +e.target.value })} /></label>
        <label className="field"><span>参考高度 (m，30ft=9.144)</span>
          <input type="number" step="0.01" value={draft.refHeightM} onChange={(e) => patch({ refHeightM: +e.target.value })} /></label>
      </div>

      {deck && (
        <>
          <h3>直升机甲板</h3>
          <div className="row">
            <label className="field"><span>甲板直径 (m)</span>
              <input type="number" value={deck.helideck!.diameter}
                onChange={(e) => updateModule(deck.id, { helideck: { ...deck.helideck!, diameter: +e.target.value } })} /></label>
            <label className="field"><span>进近方位角 (°)</span>
              <input type="number" value={deck.helideck!.approachBearingDeg}
                onChange={(e) => updateModule(deck.id, { helideck: { ...deck.helideck!, approachBearingDeg: +e.target.value } })} /></label>
            <label className="field"><span>参考层标高 (m，自动)</span>
              <input value={(deck.position.z + draft.refHeightM).toFixed(2)} disabled /></label>
          </div>
        </>
      )}

      <h3>透平工况（修改后温升场与限制扇区联动重算）</h3>
      <table>
        <thead><tr><th>透平</th><th>运行</th><th>排气量 kg/s</th><th>排温 K</th></tr></thead>
        <tbody>
          {draft.turbines.map((t) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td><input type="checkbox" checked={t.running} style={{ width: 'auto' }}
                onChange={(e) => updateTurbine(t.id, { running: e.target.checked })} /></td>
              <td><input type="number" value={t.massFlow} onChange={(e) => updateTurbine(t.id, { massFlow: +e.target.value })} /></td>
              <td><input type="number" value={t.exhaustTempK} onChange={(e) => updateTurbine(t.id, { exhaustTempK: +e.target.value })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt8">
        <button className="btn-sm" disabled={!dirty} onClick={() => onTurbine(draft)}>应用工况并重算温升</button>
      </div>

      <h3>模块清单（{draft.modules.length}）</h3>
      <div className="scroll-x">
        <table>
          <thead><tr><th>名称</th><th>类型</th><th>中心 x,y,z (m)</th><th>尺寸 x,y,z (m)</th><th></th></tr></thead>
          <tbody>
            {draft.modules.map((m) => {
              const b = moduleAABB(m);
              return (
                <tr key={m.id}>
                  <td><input value={m.name} onChange={(e) => updateModule(m.id, { name: e.target.value })} /></td>
                  <td><span className="badge badge-blue">{TYPE_LABELS[m.type]}</span></td>
                  <td className="mono">{m.position.x.toFixed(1)}, {m.position.y.toFixed(1)}, {m.position.z.toFixed(1)}</td>
                  <td className="mono">{m.size.x.toFixed(1)}, {m.size.y.toFixed(1)}, {m.size.z.toFixed(1)}</td>
                  <td>
                    <button className="btn-sm btn-ghost" onClick={() => editModulePrompt(m, updateModule)}>编辑</button>{' '}
                    <button className="btn-sm btn-danger" onClick={() => removeModule(m.id)}>删</button>
                    <div className="muted mono" style={{ fontSize: 10 }}>
                      包围盒 [{b.min.x.toFixed(0)},{b.min.y.toFixed(0)},{b.min.z.toFixed(0)}]–[{b.max.x.toFixed(0)},{b.max.y.toFixed(0)},{b.max.z.toFixed(0)}]
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="mt8 flex-between">
        <div className="muted">添加模块：
          {(['living', 'flare', 'exhaust', 'crane', 'block'] as ModuleType[]).map((t) => (
            <button key={t} className="btn-sm btn-ghost" style={{ marginLeft: 6 }} onClick={() => addModule(t)}>+ {TYPE_LABELS[t]}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function editModulePrompt(m: PlatformModule, update: (id: string, p: Partial<PlatformModule>) => void) {
  const input = prompt(
    '输入中心坐标与尺寸（6 个数字，逗号分隔）：cx,cy,cz,sx,sy,sz',
    [m.position.x, m.position.y, m.position.z, m.size.x, m.size.y, m.size.z].join(','),
  );
  if (!input) return;
  const nums = input.split(',').map(Number);
  if (nums.length !== 6 || nums.some((n) => !Number.isFinite(n))) {
    alert('需要 6 个有效数字');
    return;
  }
  update(m.id, {
    position: { x: nums[0], y: nums[1], z: nums[2] },
    size: { x: nums[3], y: nums[4], z: nums[5] },
  });
}
