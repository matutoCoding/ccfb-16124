import { describe, it, expect } from 'vitest';
import {
  windDirToVector, vectorToWindDir, normalizeAngle, angleDiff,
  interpolateAngle, findWindBracket, blendComponent,
} from '../src/domain/angle';

describe('风向换算', () => {
  it('北风(0°) 吹向南方：v 为负', () => {
    const { u, v } = windDirToVector(0, 10);
    expect(u).toBeCloseTo(0, 10);
    expect(v).toBeCloseTo(-10, 10);
  });

  it('东风(90°) 吹向西方：u 为负', () => {
    const { u, v } = windDirToVector(90, 10);
    expect(u).toBeCloseTo(-10, 10);
    expect(v).toBeCloseTo(0, 10);
  });

  it('分量 -> 风向角往返一致（8 个风向）', () => {
    for (const d of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const { u, v } = windDirToVector(d, 12);
      expect(Math.abs(angleDiff(vectorToWindDir(u, v), d))).toBeLessThan(1e-10);
    }
  });

  it('normalizeAngle 处理负值与超 360', () => {
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(370)).toBe(10);
  });

  it('angleDiff 取最短弧', () => {
    expect(angleDiff(10, 350)).toBe(20);
    expect(angleDiff(350, 10)).toBe(-20);
  });

  it('圆周插值走短弧', () => {
    expect(interpolateAngle(350, 10, 0.5)).toBe(0);
    expect(interpolateAngle(10, 350, 0.5)).toBe(0);
  });
});

describe('风向区间查找', () => {
  const bearings = [0, 45, 90, 135, 180, 225, 270, 315];

  it('区间内插值系数正确', () => {
    const r = findWindBracket(bearings, 30);
    expect(r.left).toBe(0);
    expect(r.right).toBe(1);
    expect(r.t).toBeCloseTo(30 / 45, 10);
  });

  it('环绕区间（315 -> 360/0）正确', () => {
    const r = findWindBracket(bearings, 350);
    expect(bearings[r.left]).toBe(315);
    expect(bearings[r.right]).toBe(0);
    expect(r.t).toBeCloseTo(35 / 45, 10);
  });

  it('正好命中已有风向时 t=0', () => {
    const r = findWindBracket(bearings, 90);
    expect(r.t).toBe(0);
    expect(bearings[r.left]).toBe(90);
  });
});

describe('缺测混合', () => {
  it('一端 NaN 取另一端', () => {
    expect(blendComponent(NaN, 5, 0.7)).toBe(5);
    expect(blendComponent(5, NaN, 0.7)).toBe(5);
  });
  it('两端 NaN 仍为 NaN', () => {
    expect(Number.isNaN(blendComponent(NaN, NaN, 0.5))).toBe(true);
  });
  it('正常线性插值', () => {
    expect(blendComponent(0, 10, 0.25)).toBe(2.5);
  });
});
