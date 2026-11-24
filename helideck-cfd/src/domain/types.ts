/**
 * 领域模型类型定义。
 * 坐标系：x 东 (m)，y 北 (m)，z 垂直向上 (m)，原点在平台基准点。
 * 风向定义：风向 = 风吹来的方向的方位角（气象惯例，0=北风/从南向北吹，90=东风），单位 度。
 */

export type ModuleType =
  | 'living'      // 生活楼
  | 'flare'       // 火炬臂
  | 'exhaust'     // 透平排气口
  | 'crane'       // 吊机
  | 'helideck'    // 直升机甲板
  | 'block';      // 通用简化体块

export interface PlatformModule {
  id: string;
  name: string;
  type: ModuleType;
  /** 体块包围盒中心 (m) */
  position: Vec3;
  /** 体块尺寸 (m)，全尺寸 */
  size: Vec3;
  /** 仅排气口：排气量 kg/s、排气温度 K、关联透平编号 */
  exhaust?: {
    turbineId: string;
    massFlow: number;
    temperatureK: number;
  };
  /** 仅直升机甲板：直径 m、基准方位角（进近航道方向，从真北顺时针，度） */
  helideck?: {
    diameter: number;
    approachBearingDeg: number;
  };
  color?: string;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface TurbineConfig {
  id: string;
  name: string;
  /** 是否运行 */
  running: boolean;
  /** 排气量 kg/s */
  massFlow: number;
  /** 排气温度 K */
  exhaustTempK: number;
}

export interface PlatformProject {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** 甲板标高 m（相对海图基准） */
  deckElevation: number;
  /** 气隙 m（甲板到海平面） */
  airGap: number;
  modules: PlatformModule[];
  turbines: TurbineConfig[];
  /** 环境参考温度 K，温升 = 当地温度 - 环境温度 */
  ambientTempK: number;
  /** CAP437 评估参考高度（默认 30 英尺 = 9.144 m） */
  refHeightM: number;
  /** 规则阈值（可在页面调整） */
  thresholds: RuleThresholds;
}

export interface RuleThresholds {
  /** 垂直风速上限 m/s（CAP437 默认 0.9） */
  verticalWind: number;
  /** 温升上限 K（CAP437 默认 2） */
  tempRise: number;
  /** 总风速上限 m/s（默认 20，工程惯例值，可改） */
  totalWind: number;
  /** 侧风上限 m/s（0 = 不启用该条规则） */
  crossWind: number;
}

/** 规则网格定义 */
export interface GridSpec {
  nx: number;
  ny: number;
  nz: number;
  /** 网格原点（最小角点） */
  origin: Vec3;
  /** 网格间距 m */
  spacing: Vec3;
}

/** 单个风向的风场（规则网格，结构数组） */
export interface DirectionField {
  /** 风向（吹来方向，方位角度） */
  windDirDeg: number;
  /** 自由来流风速 m/s */
  windSpeed: number;
  /** 速度分量，长度 nx*ny*nz，NaN 表示缺测格点 */
  u: Float32Array;
  v: Float32Array;
  w: Float32Array;
  /** 温度 K，NaN 表示缺测 */
  t: Float32Array;
}

export interface WindDataset {
  id: string;
  projectId: string;
  name: string;
  createdAt: number;
  grid: GridSpec;
  /** 风向集合（通常 8 个） */
  directions: number[];
  ambientTempK: number;
  /** 数据来源：synthetic 内置生成 / import 外部导入 */
  source: 'synthetic' | 'import';
  /** 体块化数据单独存 IDB（方向索引 -> 存储键） */
  fieldKeys: string[];
  /** 导入质量报告 */
  quality?: DataQualityReport;
}

export interface DataQualityReport {
  totalPoints: number;
  missingCount: number;
  badCount: number;
  /** 坏数据明细（截断存储，最多 200 条） */
  samples: BadDataSample[];
}

export interface BadDataSample {
  i: number;
  j: number;
  k: number;
  reason: 'missing' | 'nan' | 'infinity' | 'out-of-range' | 'speed-spike';
  field?: string;
  value?: number;
}

export type Verdict = 'pass' | 'caution' | 'no-fly';

export interface SectorAssessment {
  /** 方位角 0..350，步长 10，共 36 个 */
  bearingDeg: number;
  verdict: Verdict;
  /** 触发的规则 */
  reasons: string[];
  maxVertical: number;
  maxTempRise: number;
  maxTotal: number;
  maxCross: number;
  /** 航线上的超限点数 */
  exceedanceCount: number;
}

export interface RouteSample {
  /** 沿航线距离 m */
  distance: number;
  position: Vec3;
  u: number;
  v: number;
  w: number;
  tempRise: number;
  totalSpeed: number;
  crossWind: number;
  verticalExceed: boolean;
  tempExceed: boolean;
}

export interface RouteAssessment {
  name: string;
  samples: RouteSample[];
  verticalExceedSegments: [number, number][];
  tempExceedSegments: [number, number][];
}
