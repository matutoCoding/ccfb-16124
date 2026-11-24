import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppState } from '../state/appStore';
import { useResolvedField } from '../state/useResolvedField';
import { VisualizationEngine, type EngineState } from '../webgpu/visualizationEngine';
import { gridBounds } from '../domain/grid';
import type { SliceAxis } from '../webgpu/sliceRenderer';
import type { RouteSample } from '../domain/types';

export function VisualizationPage() {
  const { projects, currentProjectId, bundle, loadingField } = useAppState();
  const project = projects.find((p) => p.id === currentProjectId) ?? null;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<VisualizationEngine | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [scale, setScale] = useState(0.75);
  const [ready, setReady] = useState(false);
  const [axis, setAxis] = useState<SliceAxis>(2);
  const [slicePos, setSlicePos] = useState(0);
  const [colorMode, setColorMode] = useState<'speed' | 'vertical'>('speed');
  const [kernel, setKernel] = useState(10);
  const [showParticles, setShowParticles] = useState(true);
  const [showIso, setShowIso] = useState(true);
  const [showRoutes, setShowRoutes] = useState(true);

  const fields = bundle?.fields ?? null;
  const grid = bundle?.meta.grid ?? null;
  const { bearing, displayBearing, setBearing, resolved, isoMeshes, routes } =
    useResolvedField(fields, project, grid);

  const bounds = useMemo(() => (grid ? gridBounds(grid) : null), [grid]);
  const routeSamples = useMemo<RouteSample[]>(
    () => routes.flatMap((r) => r.samples),
    [routes],
  );
  const refZ = useMemo(() => {
    const deck = project?.modules.find((m) => m.type === 'helideck');
    return deck ? deck.position.z + (project?.refHeightM ?? 9.144) : 33;
  }, [project]);

  // 引擎初始化（只一次）
  useEffect(() => {
    let engine: VisualizationEngine | null = null;
    let cancelled = false;
    if (!canvasRef.current) return;
    VisualizationEngine.create(canvasRef.current)
      .then((e) => {
        if (cancelled) { e.dispose(); return; }
        engine = e;
        engineRef.current = e;
        e.onFps = (f, s) => { setFps(Math.round(f)); setScale(s); };
        e.start();
        setReady(true);
      })
      .catch((err) => setError(err.message));
    return () => {
      cancelled = true;
      engine?.dispose();
      engineRef.current = null;
    };
  }, []);

  // 数据集切换 -> 重传几何/纹理
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !resolved || !grid || !project) return;
    engine.setData(grid, resolved, project.modules, isoMeshes, routeSamples);
    const b = gridBounds(grid);
    setSlicePos((b.min.z + b.max.z) / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle?.meta.id]);

  // 场变化（风向过渡/温度缩放）-> 只更新纹理
  useEffect(() => {
    if (engineRef.current && resolved && ready) {
      engineRef.current.updateField(resolved);
    }
  }, [resolved, ready]);

  // 等温面/航线更新
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !resolved || !grid || !project) return;
    engine.setData(grid, resolved, project.modules, isoMeshes, routeSamples);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isoMeshes, routes]);

  // 控件状态同步到引擎
  useEffect(() => {
    engineRef.current?.setState({
      axis, slicePosition: slicePos, colorMode, kernelLength: kernel,
      showParticles, showIso, showRoutes, refZ,
    } as Partial<EngineState>);
  }, [axis, slicePos, colorMode, kernel, showParticles, showIso, showRoutes, refZ]);

  const axisBounds = bounds ? [bounds.min[axis === 0 ? 'x' : axis === 1 ? 'y' : 'z'], bounds.max[axis === 0 ? 'x' : axis === 1 ? 'y' : 'z']] : [0, 1];

  return (
    <div>
      <div className="page-head">
        <h1>气流可视化</h1>
        <p>线积分卷积（LIC）流向纹理 + GPU 粒子平流 + 排气等温面；纹理方向与速度场偏差由单元测试保证 &lt;3°。</p>
      </div>

      {error && <div className="card bad">WebGPU 初始化失败：{error}。请使用 Chrome/Edge 113+ 并检查显卡驱动。</div>}
      {!bundle && !error && <div className="empty">请先到「风场数据」页载入一个数据集</div>}

      {bundle && (
        <div className="viz-layout">
          <div className="viz-canvas-wrap">
            <canvas ref={canvasRef} />
            <div className="hud">
              <span>FPS <b className={fps >= 55 ? 'ok' : fps >= 30 ? 'warn' : 'bad'}>{fps}</b></span>
              <span>分辨率倍率 <b>{Math.round(scale * 100)}%</b></span>
              <span>显示风向 <b>{displayBearing.toFixed(0)}°</b></span>
              <span className="muted">左键旋转 · 右键平移 · 滚轮缩放</span>
            </div>
          </div>

          <div className="viz-panel">
            <h2 style={{ marginTop: 0 }}>风向</h2>
            <label className="field">
              <span>目标风向 {bearing}°（拖动后流场平滑过渡，不跳变）</span>
              <input type="range" min="0" max="359" value={bearing} onChange={(e) => setBearing(+e.target.value)} />
            </label>
            <div className="row">
              {bundle.meta.directions.map((d) => (
                <button key={d} className="btn-sm btn-ghost" onClick={() => setBearing(d)}>{d}°</button>
              ))}
            </div>

            <h2 style={{ marginTop: 18 }}>切片 LIC</h2>
            <div className="pill-tabs" style={{ marginBottom: 10 }}>
              {(['x 纵向', 'y 横向', 'z 水平'] as const).map((label, i) => (
                <button key={label} className={axis === i ? 'active' : ''} onClick={() => {
                  setAxis(i as SliceAxis);
                  if (bounds) {
                    const key = i === 0 ? 'x' : i === 1 ? 'y' : 'z';
                    setSlicePos((bounds.min[key] + bounds.max[key]) / 2);
                  }
                }}>{label}</button>
              ))}
            </div>
            <label className="field">
              <span>切片位置 {slicePos.toFixed(1)} m（可拖动）</span>
              <input type="range" min={axisBounds[0]} max={axisBounds[1]} step={(axisBounds[1] - axisBounds[0]) / 200}
                value={slicePos} onChange={(e) => setSlicePos(+e.target.value)} />
            </label>
            <button className="btn-sm" style={{ width: '100%' }} onClick={() => {
              setAxis(2);
              setSlicePos(refZ);
            }}>一键贴到甲板上方 30 英尺层（{refZ.toFixed(2)} m）</button>

            <h3>颜色映射</h3>
            <div className="pill-tabs">
              <button className={colorMode === 'speed' ? 'active' : ''} onClick={() => setColorMode('speed')}>速度大小</button>
              <button className={colorMode === 'vertical' ? 'active' : ''} onClick={() => setColorMode('vertical')}>垂直分量</button>
            </div>

            <h3>纹理核长度（流线积分步数）</h3>
            <div className="slider-wrap">
              <input type="range" min="4" max="20" value={kernel} onChange={(e) => setKernel(+e.target.value)} />
              <span className="mono">{kernel}</span>
            </div>

            <h2 style={{ marginTop: 18 }}>显示图层</h2>
            <label className="field"><span><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={showParticles} onChange={(e) => setShowParticles(e.target.checked)} />动态粒子（风大流动快，回流/分离区可辨识）</span></label>
            <label className="field"><span><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={showIso} onChange={(e) => setShowIso(e.target.checked)} />排气等温面（2K 描边 + 4K/7K 半透明）</span></label>
            <label className="field"><span><input type="checkbox" style={{ width: 'auto', marginRight: 8 }} checked={showRoutes} onChange={(e) => setShowRoutes(e.target.checked)} />进近/离场航线（超限段红色）</span></label>

            {loadingField && <div className="mt16 muted">正在从 IndexedDB 载入风场…</div>}
            {!ready && !error && <div className="mt16 muted">WebGPU 引擎启动中…</div>}
          </div>
        </div>
      )}
    </div>
  );
}
