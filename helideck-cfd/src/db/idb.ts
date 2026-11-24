import type {
  DirectionField, PlatformProject, WindDataset,
} from '../domain/types';

/**
 * IndexedDB 持久层。
 * 三个对象仓：
 *  projects  — 平台项目（结构化克隆）
 *  datasets  — 风场元数据（网格、风向、质量报告）
 *  fields    — 每个风向的分量二进制（ArrayBuffer，键 = `${datasetId}:dir:${index}`）
 * 大分量不进元数据记录，避免克隆/序列化开销。
 */

const DB_NAME = 'helideck-cfd';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_DATASETS = 'datasets';
const STORE_FIELDS = 'fields';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_DATASETS)) db.createObjectStore(STORE_DATASETS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_FIELDS)) db.createObjectStore(STORE_FIELDS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) => new Promise<T>((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }),
  );
}

// ---------- 项目 ----------

export async function saveProject(project: PlatformProject): Promise<void> {
  project.updatedAt = Date.now();
  await tx(STORE_PROJECTS, 'readwrite', (s) => s.put(structuredClone(project)));
}

export async function listProjects(): Promise<PlatformProject[]> {
  return tx(STORE_PROJECTS, 'readonly', (s) => s.getAll() as IDBRequest<PlatformProject[]>);
}

export async function getProject(id: string): Promise<PlatformProject | undefined> {
  return tx(STORE_PROJECTS, 'readonly', (s) => s.get(id));
}

export async function deleteProject(id: string): Promise<void> {
  await tx(STORE_PROJECTS, 'readwrite', (s) => s.delete(id));
}

// ---------- 风场元数据 ----------

export async function saveDataset(meta: WindDataset): Promise<void> {
  await tx(STORE_DATASETS, 'readwrite', (s) => s.put(structuredClone(meta)));
}

export async function listDatasets(projectId?: string): Promise<WindDataset[]> {
  const all = await tx(STORE_DATASETS, 'readonly', (s) => s.getAll() as IDBRequest<WindDataset[]>);
  return projectId ? all.filter((d) => d.projectId === projectId) : all;
}

export async function getDataset(id: string): Promise<WindDataset | undefined> {
  return tx(STORE_DATASETS, 'readonly', (s) => s.get(id));
}

export async function deleteDataset(id: string): Promise<void> {
  const meta = await getDataset(id);
  if (meta) {
    for (const key of meta.fieldKeys) {
      await tx(STORE_FIELDS, 'readwrite', (s) => s.delete(key));
    }
  }
  await tx(STORE_DATASETS, 'readwrite', (s) => s.delete(id));
}

// ---------- 风向分量二进制 ----------

interface FieldPayload {
  windDirDeg: number;
  windSpeed: number;
  u: ArrayBuffer;
  v: ArrayBuffer;
  w: ArrayBuffer;
  t: ArrayBuffer;
}

export function fieldKey(datasetId: string, dirIndex: number): string {
  return `${datasetId}:dir:${dirIndex}`;
}

export async function saveField(key: string, field: DirectionField): Promise<void> {
  const toBuffer = (arr: Float32Array): ArrayBuffer => {
    const copy = new ArrayBuffer(arr.byteLength);
    new Float32Array(copy).set(arr);
    return copy;
  };
  const payload: FieldPayload = {
    windDirDeg: field.windDirDeg,
    windSpeed: field.windSpeed,
    u: toBuffer(field.u),
    v: toBuffer(field.v),
    w: toBuffer(field.w),
    t: toBuffer(field.t),
  };
  await tx(STORE_FIELDS, 'readwrite', (s) => s.put(payload, key));
}

export async function loadField(key: string): Promise<DirectionField> {
  const p = await tx(STORE_FIELDS, 'readonly', (s) => s.get(key) as IDBRequest<FieldPayload>);
  if (!p) throw new Error(`风场分量不存在: ${key}`);
  const asArray = (b: ArrayBuffer | SharedArrayBuffer): ArrayBuffer => {
    const out = new ArrayBuffer(b.byteLength);
    new Uint8Array(out).set(new Uint8Array(b));
    return out;
  };
  return {
    windDirDeg: p.windDirDeg,
    windSpeed: p.windSpeed,
    u: new Float32Array(asArray(p.u)),
    v: new Float32Array(asArray(p.v)),
    w: new Float32Array(asArray(p.w)),
    t: new Float32Array(asArray(p.t)),
  };
}

/** 批量保存一个数据集的全部风向 */
export async function saveDatasetWithFields(
  meta: WindDataset,
  fields: DirectionField[],
): Promise<void> {
  for (let i = 0; i < fields.length; i++) {
    await saveField(meta.fieldKeys[i], fields[i]);
  }
  await saveDataset(meta);
}
