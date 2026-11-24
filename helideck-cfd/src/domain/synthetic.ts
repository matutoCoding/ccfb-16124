import type {
  DirectionField, GridSpec, PlatformModule, PlatformProject, Vec3,
} from './types';
import { moduleAABB } from './platform';
import { gridIndex, nodePosition } from './grid';
import { windDirToVector } from './angle';

/**
 * 合成风场生成器（工程近似模型，非 CFD 求解）。
 * 用途：无外包 CFD 数据时的演示与全链路测试数据，包含：
 *  - 自由来流 + 体块尾流亏损 + 近尾流回流（反向速度）
 *  - 建筑前缘上洗气流与屋顶分离
 *  - 透平排气浮力羽流（弯曲、扩散、温升衰减）
 * 所有随机项使用确定性 LCG，同参数结果可复现，便于单元测试与逐点核对。
 */

export interface ExhaustRuntime {
  position: Vec3;
  massFlow: number;
  exhaustTempK: number;
  /** 运行比例（0..1），由透平开关/流量推导 */
  factor: number;
}

export interface SyntheticOptions {
  windSpeed?: number;
  bearings?: number[];
  exhausts?: ExhaustRuntime[];
  ambientTempK?: number;
  /** 注入缺测格点（测试用）：占比 0..1 */
  missingFraction?: number;
  seed?: number;
}

/** 确定性线性同余随机数 */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 按平台包围盒外扩 20m、4m 间距自动生成规则网格 */
export function autoGrid(modules: PlatformModule[], spacing = 4): GridSpec {
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const m of modules) {
    const b = moduleAABB(m);
    minX = Math.min(minX, b.min.x); minY = Math.min(minY, b.min.y);
    maxX = Math.max(maxX, b.max.x); maxY = Math.max(maxY, b.max.y);
    maxZ = Math.max(maxZ, b.max.z);
  }
  const margin = 20;
  const origin = { x: Math.floor((minX - margin) / spacing) * spacing, y: Math.floor((minY - margin) / spacing) * spacing, z: 0 };
  const nx = Math.ceil((maxX - origin.x + margin) / spacing) + 1;
  const ny = Math.ceil((maxY - origin.y + margin) / spacing) + 1;
  const nz = Math.ceil((maxZ + margin) / spacing) + 1;
  return { nx, ny, nz, origin, spacing: { x: spacing, y: spacing, z: spacing } };
}

interface SolidBox { min: Vec3; max: Vec3; }

function isSolid(p: Vec3, boxes: SolidBox[]): boolean {
  for (const b of boxes) {
    if (p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z) {
      return true;
    }
  }
  return false;
}

const DEFAULT_BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];

/** 生成全部风向的合成风场 */
export function generateSyntheticDataset(
  project: PlatformProject,
  grid: GridSpec,
  opts: SyntheticOptions = {},
): DirectionField[] {
  const bearings = opts.bearings ?? DEFAULT_BEARINGS;
  const windSpeed = opts.windSpeed ?? 15;
  const ambient = opts.ambientTempK ?? project.ambientTempK;
  // 默认从项目透平配置推导排气运行参数（规则 9 联动入口）
  const exhausts = opts.exhausts ?? exhaustsFromProject(project);
  const boxes: SolidBox[] = project.modules
    .filter((m) => m.type !== 'flare')
    .map(moduleAABB);

  return bearings.map((bearing) =>
    generateOneDirection(grid, boxes, exhausts, bearing, windSpeed, ambient, opts.missingFraction ?? 0, opts.seed ?? 42),
  );
}

function generateOneDirection(
  grid: GridSpec,
  boxes: SolidBox[],
  exhausts: ExhaustRuntime[],
  bearingDeg: number,
  windSpeed: number,
  ambient: number,
  missingFraction: number,
  seed: number,
): DirectionField {
  const n = grid.nx * grid.ny * grid.nz;
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const w = new Float32Array(n);
  const t = new Float32Array(n).fill(ambient);
  const { u: u0, v: v0 } = windDirToVector(bearingDeg, windSpeed);
  const wind = { x: u0, y: v0 };
  const wlen = Math.hypot(wind.x, wind.y) || 1;
  const wdir = { x: wind.x / wlen, y: wind.y / wlen };
  const rand = lcg(seed + Math.round(bearingDeg) * 7919);

  for (let k = 0; k < grid.nz; k++) {
    for (let j = 0; j < grid.ny; j++) {
      for (let i = 0; i < grid.nx; i++) {
        const idx = gridIndex(grid, i, j, k);
        const p = nodePosition(grid, i, j, k);

        if (isSolid(p, boxes)) {
          u[idx] = 0; v[idx] = 0; w[idx] = 0;
          t[idx] = ambient;
          continue;
        }

        let cu = wind.x;
        let cv = wind.y;
        let cw = 0;

        // --- 体块空气动力学尾流（投影到水平面的 2.5D 模型） ---
        for (const b of boxes) {
          if (p.z > b.max.z || p.z < b.min.z - 2) continue;
          const c = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
          const rel = { x: p.x - c.x, y: p.y - c.y };
          const down = rel.x * wdir.x + rel.y * wdir.y;       // 沿风向距离（下游为正）
          const lateral = -rel.x * wdir.y + rel.y * wdir.x;    // 横向距离
          const halfW = Math.abs((b.max.x - b.min.x) * wdir.y) / 2
                      + Math.abs((b.max.y - b.min.y) * wdir.x) / 2;
          const blockH = b.max.z - b.min.z;
          if (down > 0 && down < 12 * halfW + blockH * 2) {
            const growth = 0.18 * down;
            const sigma = halfW + growth;
            const gauss = Math.exp(-(lateral * lateral) / (2 * sigma * sigma));
            const decay = Math.exp(-down / (6 * halfW + blockH));
            const deficit = 0.85 * gauss * decay;
            cu *= 1 - deficit;
            cv *= 1 - deficit;
            // 近尾流回流：建筑背风面 2.5 倍高度内直接替换为反向速度，
            // 形成稳定可识别的再循环区（投影到自由来流方向为负）
            if (down < 2.5 * blockH && Math.abs(lateral) < halfW * 1.2) {
              const back = 0.35 * Math.exp(-(lateral * lateral) / (2 * halfW * halfW))
                         * Math.cos((down / (2.5 * blockH)) * Math.PI / 2);
              const along = cu * wdir.x + cv * wdir.y;
              const target = -windSpeed * back;
              const replace = target - along;
              cu += wdir.x * replace;
              cv += wdir.y * replace;
            }
            // 尾流区垂直方向的湍流起伏
            cw += 0.25 * windSpeed * gauss * decay * Math.sin((p.z - b.min.z) * 0.7 + down * 0.5);
          }
          // 前缘上洗：迎风面上方气流抬升
          if (down <= 0 && down > -4 && p.z > b.max.z - 2 && p.z < b.max.z + 0.9 * blockH
              && Math.abs(lateral) < halfW * 1.3) {
            const strength = 0.5 * Math.exp(down * 0.8) * Math.exp(-Math.pow((p.z - b.max.z) / (0.7 * blockH), 2));
            cw += windSpeed * strength;
            cu *= 1 - strength * 0.3;
            cv *= 1 - strength * 0.3;
          }
        }

        // --- 透平排气浮力羽流 ---
        let tempRise = 0;
        for (const ex of exhausts) {
          if (ex.factor <= 0) continue;
          const rel = { x: p.x - ex.position.x, y: p.y - ex.position.y };
          const down = rel.x * wdir.x + rel.y * wdir.y;
          if (down < -2) continue;
          const lateral = -rel.x * wdir.y + rel.y * wdir.x;
          // 浮力弯曲抬升
          const rise = 2.2 * Math.sqrt(Math.max(down, 0)) + 0.35 * down;
          const centerZ = ex.position.z + rise;
          const sigma = 1.6 + 0.12 * down;
          const gauss = Math.exp(
            -(lateral * lateral + (p.z - centerZ) * (p.z - centerZ)) / (2 * sigma * sigma),
          );
          const axial = Math.exp(-down / 45);
          const sourceRise = (ex.exhaustTempK - ambient) * (ex.massFlow / 30) * 0.12;
          tempRise += ex.factor * sourceRise * gauss * axial;
          // 羽流夹带：局部向上速度
          cw += ex.factor * 1.4 * gauss * axial * Math.exp(-down / 30);
        }

        u[idx] = cu;
        v[idx] = cv;
        w[idx] = cw;
        t[idx] = ambient + tempRise;
      }
    }
  }

  // 确定性缺测注入
  if (missingFraction > 0) {
    for (let idx = 0; idx < n; idx++) {
      if (rand() < missingFraction) {
        u[idx] = NaN; v[idx] = NaN; w[idx] = NaN; t[idx] = NaN;
      }
    }
  }

  return { windDirDeg: bearingDeg, windSpeed, u, v, w, t };
}

/** 由项目透平配置推导运行时排气参数（位置取排气模块顶部） */
export function exhaustsFromProject(project: PlatformProject): ExhaustRuntime[] {
  return project.modules
    .filter((m) => m.type === 'exhaust' && m.exhaust)
    .map((m) => {
      const tb = project.turbines.find((x) => x.id === m.exhaust!.turbineId);
      const baseFlow = m.exhaust!.massFlow;
      const baseTemp = m.exhaust!.temperatureK;
      const flow = tb?.massFlow ?? baseFlow;
      const temp = tb?.exhaustTempK ?? baseTemp;
      const running = tb?.running ?? true;
      // 运行比例：开关 × 流量相对铭牌比例
      const factor = running ? flow / baseFlow : 0;
      return {
        position: { x: m.position.x, y: m.position.y, z: m.position.z + m.size.z / 2 },
        massFlow: running ? flow : 0,
        exhaustTempK: temp,
        factor,
      };
    });
}

/**
 * 透平工况变化后的温升重算（规则 9）。
 * 原始场 t 保留为基准温升（满工况），按比例缩放：
 *   ΔT_new = ΔT_base * Σ(运行透平 factor_new) / Σ(factor_base)
 * 速度场中的羽流夹带项不单独剥离，扇区评估只依赖缩放后的温度。
 */
export function rescaleTemperature(
  field: DirectionField,
  ambientTempK: number,
  ratio: number,
): DirectionField {
  const t = new Float32Array(field.t.length);
  for (let i = 0; i < field.t.length; i++) {
    if (Number.isFinite(field.t[i])) {
      t[i] = ambientTempK + (field.t[i] - ambientTempK) * ratio;
    } else {
      t[i] = NaN;
    }
  }
  return { ...field, t };
}
