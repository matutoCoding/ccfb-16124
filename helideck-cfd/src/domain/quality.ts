import type { BadDataSample, DataQualityReport, DirectionField, GridSpec } from './types';
import { gridIndex, gridPointCount } from './grid';

/** 物理合理性边界（可被导入参数覆盖） */
export interface QualityLimits {
  maxSpeed: number;   // m/s，默认 100
  minTempK: number;   // 默认 200
  maxTempK: number;   // 默认 400
}

export const DEFAULT_LIMITS: QualityLimits = { maxSpeed: 100, minTempK: 200, maxTempK: 400 };

const MAX_SAMPLES = 200;

/**
 * 逐格点扫描一套风场的数据质量。
 * 判据：
 *  - missing：任一分量为 NaN（导出端缺测约定）
 *  - nan/infinity：非法数值
 *  - out-of-range：超出物理合理性边界
 *  - speed-spike：总风速 > 4 倍自由来流风速（局部异常跳变）
 * 与规则评估共用同一份原始网格，不做任何平滑或补值。
 */
export function scanFieldQuality(
  grid: GridSpec,
  field: DirectionField,
  limits: QualityLimits = DEFAULT_LIMITS,
): DataQualityReport {
  const total = gridPointCount(grid);
  const samples: BadDataSample[] = [];
  let missingCount = 0;
  let badCount = 0;

  const push = (s: BadDataSample) => {
    badCount++;
    if (samples.length < MAX_SAMPLES) samples.push(s);
  };

  for (let k = 0; k < grid.nz; k++) {
    for (let j = 0; j < grid.ny; j++) {
      for (let i = 0; i < grid.nx; i++) {
        const idx = gridIndex(grid, i, j, k);
        const comps: [string, number][] = [
          ['u', field.u[idx]], ['v', field.v[idx]],
          ['w', field.w[idx]], ['t', field.t[idx]],
        ];
        let nodeMissing = false;
        for (const [name, val] of comps) {
          if (Number.isNaN(val)) {
            nodeMissing = true;
            push({ i, j, k, reason: 'missing', field: name });
            continue;
          }
          if (!Number.isFinite(val)) {
            push({ i, j, k, reason: 'infinity', field: name, value: val });
            continue;
          }
          if (name === 't') {
            if (val < limits.minTempK || val > limits.maxTempK) {
              push({ i, j, k, reason: 'out-of-range', field: name, value: val });
            }
          } else if (Math.abs(val) > limits.maxSpeed) {
            push({ i, j, k, reason: 'out-of-range', field: name, value: val });
          }
        }
        if (nodeMissing) {
          missingCount++;
          continue;
        }
        const speed = Math.hypot(field.u[idx], field.v[idx], field.w[idx]);
        if (speed > 4 * field.windSpeed && speed > limits.maxSpeed * 0.5) {
          push({ i, j, k, reason: 'speed-spike', value: speed });
        }
      }
    }
  }

  return { totalPoints: total, missingCount, badCount, samples };
}

/** 汇总多风向质量报告 */
export function mergeQuality(reports: DataQualityReport[]): DataQualityReport {
  return {
    totalPoints: reports.reduce((s, r) => s + r.totalPoints, 0),
    missingCount: reports.reduce((s, r) => s + r.missingCount, 0),
    badCount: reports.reduce((s, r) => s + r.badCount, 0),
    samples: reports.flatMap((r) => r.samples).slice(0, MAX_SAMPLES),
  };
}
