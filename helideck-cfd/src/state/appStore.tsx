import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import type {
  DirectionField, PlatformProject, WindDataset,
} from '../domain/types';
import {
  deleteDataset, deleteProject, getDataset, listDatasets, listProjects,
  loadField, saveDatasetWithFields, saveProject,
} from '../db/idb';
import {
  autoGrid, exhaustsFromProject, generateSyntheticDataset,
} from '../domain/synthetic';
import { fieldKey } from '../db/idb';
import { applyTempRatioToFields } from '../domain/sectors';
import { createDefaultProject, uid } from '../domain/platform';

/**
 * 全局应用状态。
 * 风场分量体积大（34×23×15×4 分量 ×8 风向），只在内存保留当前数据集，
 * 切换数据集时从 IDB 重新载入；元数据列表常驻。
 */

export interface DatasetBundle {
  meta: WindDataset;
  fields: DirectionField[];
}

interface AppState {
  ready: boolean;
  projects: PlatformProject[];
  datasets: WindDataset[];
  currentProjectId: string | null;
  currentDatasetId: string | null;
  bundle: DatasetBundle | null;
  loadingField: boolean;
  createProject: (name: string) => Promise<PlatformProject>;
  updateProject: (p: PlatformProject) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  selectProject: (id: string | null) => void;
  selectDataset: (id: string | null) => Promise<void>;
  generateDataset: (name: string, missingFraction?: number) => Promise<void>;
  importDataset: (meta: WindDataset, fields: DirectionField[]) => Promise<void>;
  removeDataset: (id: string) => Promise<void>;
  /** 透平工况变化：内存场温升按比例缩放（规则 9），并持久化基准元数据 */
  applyTurbineChange: (project: PlatformProject) => Promise<void>;
  /** 当前内存场替换（风向过渡、温度缩放后调用） */
  replaceBundleFields: (fields: DirectionField[]) => void;
  refreshLists: () => Promise<void>;
}

const Ctx = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [projects, setProjects] = useState<PlatformProject[]>([]);
  const [datasets, setDatasets] = useState<WindDataset[]>([]);
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null);
  const [currentDatasetId, setCurrentDatasetId] = useState<string | null>(null);
  const [bundle, setBundle] = useState<DatasetBundle | null>(null);
  const [loadingField, setLoadingField] = useState(false);
  const baseTempRatio = useRef(1);

  const refreshLists = useCallback(async () => {
    const [ps, ds] = await Promise.all([listProjects(), listDatasets()]);
    setProjects(ps);
    setDatasets(ds);
  }, []);

  useEffect(() => {
    refreshLists().then(() => setReady(true));
  }, [refreshLists]);

  const createProject = useCallback(async (name: string) => {
    const p = createDefaultProject(name);
    await saveProject(p);
    await refreshLists();
    setCurrentProjectId(p.id);
    return p;
  }, [refreshLists]);

  const updateProject = useCallback(async (p: PlatformProject) => {
    await saveProject(p);
    await refreshLists();
  }, [refreshLists]);

  const removeProject = useCallback(async (id: string) => {
    const related = await listDatasets(id);
    for (const d of related) await deleteDataset(d.id);
    await deleteProject(id);
    if (currentProjectId === id) setCurrentProjectId(null);
    await refreshLists();
  }, [currentProjectId, refreshLists]);

  const selectProject = useCallback((id: string | null) => {
    setCurrentProjectId(id);
  }, []);

  const selectDataset = useCallback(async (id: string | null) => {
    if (!id) {
      setCurrentDatasetId(null);
      setBundle(null);
      return;
    }
    setLoadingField(true);
    try {
      const meta = await getDataset(id);
      if (!meta) throw new Error('数据集不存在');
      const fields = await Promise.all(meta.fieldKeys.map((k) => loadField(k)));
      setBundle({ meta, fields });
      setCurrentDatasetId(id);
      baseTempRatio.current = 1;
    } finally {
      setLoadingField(false);
    }
  }, []);

  const generateDataset = useCallback(async (name: string, missingFraction = 0) => {
    if (!currentProjectId) throw new Error('请先选择平台项目');
    const project = (await listProjects()).find((p) => p.id === currentProjectId);
    if (!project) throw new Error('平台项目不存在');
    const grid = autoGrid(project.modules, 4);
    const fields = generateSyntheticDataset(project, grid, {
      exhausts: exhaustsFromProject(project),
      missingFraction,
    });
    const id = uid('ds');
    const meta: WindDataset = {
      id,
      projectId: project.id,
      name,
      createdAt: Date.now(),
      grid,
      directions: fields.map((f) => f.windDirDeg),
      ambientTempK: project.ambientTempK,
      source: 'synthetic',
      fieldKeys: fields.map((_, i) => fieldKey(id, i)),
    };
    await saveDatasetWithFields(meta, fields);
    await refreshLists();
    await selectDataset(id);
  }, [currentProjectId, refreshLists, selectDataset]);

  const importDataset = useCallback(async (meta: WindDataset, fields: DirectionField[]) => {
    await saveDatasetWithFields(meta, fields);
    await refreshLists();
    await selectDataset(meta.id);
  }, [refreshLists, selectDataset]);

  const removeDataset = useCallback(async (id: string) => {
    await deleteDataset(id);
    if (currentDatasetId === id) {
      setCurrentDatasetId(null);
      setBundle(null);
    }
    await refreshLists();
  }, [currentDatasetId, refreshLists]);

  const applyTurbineChange = useCallback(async (project: PlatformProject) => {
    await saveProject(project);
    if (!bundle) {
      await refreshLists();
      return;
    }
    // 运行透平总排气相对满工况比例
    const totalFactor = exhaustsFromProject(project)
      .reduce((s, e) => s + e.factor, 0);
    const fullCount = project.modules.filter((m) => m.type === 'exhaust').length || 1;
    const ratio = totalFactor / fullCount;
    const scaled = applyTempRatioToFields(bundle.fields, project.ambientTempK, ratio);
    baseTempRatio.current = ratio;
    setBundle({ meta: bundle.meta, fields: scaled });
    await refreshLists();
  }, [bundle, refreshLists]);

  const replaceBundleFields = useCallback((fields: DirectionField[]) => {
    setBundle((b) => (b ? { meta: b.meta, fields } : b));
  }, []);

  const value = useMemo<AppState>(() => ({
    ready,
    projects,
    datasets,
    currentProjectId,
    currentDatasetId,
    bundle,
    loadingField,
    createProject,
    updateProject,
    removeProject,
    selectProject,
    selectDataset,
    generateDataset,
    importDataset,
    removeDataset,
    applyTurbineChange,
    replaceBundleFields,
    refreshLists,
  }), [
    ready, projects, datasets, currentProjectId, currentDatasetId, bundle, loadingField,
    createProject, updateProject, removeProject, selectProject, selectDataset,
    generateDataset, importDataset, removeDataset, applyTurbineChange, replaceBundleFields, refreshLists,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppState(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAppState 必须在 AppStateProvider 内使用');
  return v;
}
