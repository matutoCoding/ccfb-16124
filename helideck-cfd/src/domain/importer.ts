import type { DirectionField, GridSpec } from './types';
import { gridIndex, gridPointCount } from './grid';
import { scanFieldQuality, type QualityLimits } from './quality';

/**
 * CFD 规则网格导入器。
 * JSON 格式（推荐，带模板）：
 * {
 *   "grid": { "nx":..,"ny":..,"nz":..,"origin":{x,y,z},"spacing":{x,y,z} },
 *   "windSpeed": 15, "ambientTempK": 303.15,
 *   "directions": [ { "windDirDeg": 0, "encoding": "base64-f32",
 *       "u": "...", "v": "...", "w": "...", "t": "..." } ]
 * }
 * 也支持分量以 number[] 直接内联；NaN 用 null 或 "NaN" 表示缺测。
 * CSV 格式（稀疏或稠密，表头固定）：
 *   windDirDeg,i,j,k,u,v,w,t
 * 每个风向一个文件或合并文件均可，缺失行按缺测格点处理。
 */

export interface ImportResult {
  grid: GridSpec;
  fields: DirectionField[];
  windSpeed: number;
  ambientTempK: number;
}

interface JsonDirection {
  windDirDeg: number;
  encoding?: 'base64-f32' | 'array';
  u?: string | (number | null)[];
  v?: string | (number | null)[];
  w?: string | (number | null)[];
  t?: string | (number | null)[];
}

interface JsonEnvelope {
  grid: GridSpec;
  windSpeed?: number;
  ambientTempK?: number;
  directions: JsonDirection[];
}

export function importJson(text: string): ImportResult {
  const envelope = JSON.parse(text) as JsonEnvelope;
  validateGrid(envelope.grid);
  const n = gridPointCount(envelope.grid);
  const fields = envelope.directions.map((d) => {
    const u = decodeComponent(d.u, n);
    const v = decodeComponent(d.v, n);
    const w = decodeComponent(d.w, n);
    const t = decodeComponent(d.t, n);
    return { windDirDeg: d.windDirDeg, windSpeed: envelope.windSpeed ?? 15, u, v, w, t };
  });
  return {
    grid: envelope.grid,
    fields,
    windSpeed: envelope.windSpeed ?? 15,
    ambientTempK: envelope.ambientTempK ?? 303.15,
  };
}

function decodeComponent(raw: string | (number | null)[] | undefined, n: number): Float32Array {
  if (raw === undefined) return new Float32Array(n).fill(NaN);
  if (Array.isArray(raw)) {
    if (raw.length !== n) {
      throw new Error(`分量长度 ${raw.length} 与网格格点数 ${n} 不一致`);
    }
    return Float32Array.from(raw.map((x) => (x === null || x === undefined ? NaN : x)));
  }
  // base64 -> Float32（小端，DataView 读取，与浏览器架构无关）
  const bin = atob(raw);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if (bytes.length !== n * 4) {
    throw new Error(`base64 分量字节数 ${bytes.length} 与预期 ${n * 4} 不一致`);
  }
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

function validateGrid(grid: GridSpec): void {
  if (!grid || grid.nx < 2 || grid.ny < 2 || grid.nz < 2) {
    throw new Error('网格定义无效：nx/ny/nz 必须 >= 2');
  }
  if (!grid.spacing || [grid.spacing.x, grid.spacing.y, grid.spacing.z].some((s) => !(s > 0))) {
    throw new Error('网格间距必须为正数');
  }
}

/** 解析 CSV（可含多个风向）。第一行必须是表头。 */
export function importCsv(text: string, grid: GridSpec, ambientTempK = 303.15): ImportResult {
  validateGrid(grid);
  const n = gridPointCount(grid);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const required = ['winddirdeg', 'i', 'j', 'k', 'u', 'v', 'w', 't'];
  for (const r of required) {
    if (!header.includes(r)) throw new Error(`CSV 缺少必需列: ${r}`);
  }
  const cDir = col('winddirdeg');
  const cI = col('i'), cJ = col('j'), cK = col('k');
  const cU = col('u'), cV = col('v'), cW = col('w'), cT = col('t');

  const byDir = new Map<number, { u: Float32Array; v: Float32Array; w: Float32Array; t: Float32Array; speed: number }>();
  const getOrCreate = (dir: number) => {
    let bucket = byDir.get(dir);
    if (!bucket) {
      bucket = {
        u: new Float32Array(n).fill(NaN),
        v: new Float32Array(n).fill(NaN),
        w: new Float32Array(n).fill(NaN),
        t: new Float32Array(n).fill(NaN),
        speed: 15,
      };
      byDir.set(dir, bucket);
    }
    return bucket;
  };

  for (let line = 1; line < lines.length; line++) {
    const cells = lines[line].split(',');
    const dir = Number(cells[cDir]);
    const i = Number(cells[cI]);
    const j = Number(cells[cJ]);
    const k = Number(cells[cK]);
    if (![dir, i, j, k].every(Number.isFinite) || i < 0 || j < 0 || k < 0
        || i >= grid.nx || j >= grid.ny || k >= grid.nz) {
      throw new Error(`第 ${line + 1} 行索引或风向无效`);
    }
    const bucket = getOrCreate(dir);
    const gi = gridIndex(grid, i, j, k);
    bucket.u[gi] = parseMaybeMissing(cells[cU]);
    bucket.v[gi] = parseMaybeMissing(cells[cV]);
    bucket.w[gi] = parseMaybeMissing(cells[cW]);
    bucket.t[gi] = parseMaybeMissing(cells[cT]);
  }

  const fields: DirectionField[] = [...byDir.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([dir, b]) => ({ windDirDeg: dir, windSpeed: b.speed, u: b.u, v: b.v, w: b.w, t: b.t }));
  if (fields.length === 0) throw new Error('CSV 中没有任何数据行');
  return { grid, fields, windSpeed: fields[0].windSpeed, ambientTempK };
}

function parseMaybeMissing(token: string): number {
  const s = token.trim();
  if (s === '' || s.toLowerCase() === 'nan' || s.toLowerCase() === 'null') return NaN;
  return Number(s);
}

/** 导出 JSON 模板（含 base64 编码示例），供外包单位按格式回填 */
export function buildImportTemplate(grid: GridSpec, bearings: number[], windSpeed: number, ambientTempK: number): string {
  const n = gridPointCount(grid);
  const encode = (fill: (idx: number) => number) => {
    const arr = new Float32Array(n);
    for (let i = 0; i < n; i++) arr[i] = fill(i);
    const bytes = new Uint8Array(n * 4);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < n; i++) view.setFloat32(i * 4, arr[i], true);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };
  const envelope: JsonEnvelope = {
    grid,
    windSpeed,
    ambientTempK,
    directions: bearings.map((windDirDeg) => ({
      windDirDeg,
      encoding: 'base64-f32',
      u: encode(() => 0),
      v: encode(() => 0),
      w: encode(() => 0),
      t: encode(() => ambientTempK),
    })),
  };
  return JSON.stringify(envelope);
}

/** 导入后质量检查入口（页面上以红/黄徽标展示） */
export function checkImportedFields(
  grid: GridSpec,
  fields: DirectionField[],
  limits?: QualityLimits,
) {
  return fields.map((f) => scanFieldQuality(grid, f, limits));
}
