import type { PlatformModule, PlatformProject, RuleThresholds, Vec3 } from './types';

export const DEFAULT_THRESHOLDS: RuleThresholds = {
  verticalWind: 0.9,
  tempRise: 2,
  totalWind: 20,
  crossWind: 0,
};

let seq = 0;
export function uid(prefix = 'id'): string {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

export interface AABB {
  min: Vec3;
  max: Vec3;
}

export function moduleAABB(m: PlatformModule): AABB {
  return {
    min: {
      x: m.position.x - m.size.x / 2,
      y: m.position.y - m.size.y / 2,
      z: m.position.z - m.size.z / 2,
    },
    max: {
      x: m.position.x + m.size.x / 2,
      y: m.position.y + m.size.y / 2,
      z: m.position.z + m.size.z / 2,
    },
  };
}

export function findHelideck(project: PlatformProject): PlatformModule | undefined {
  return project.modules.find((m) => m.type === 'helideck');
}

export function findExhausts(project: PlatformProject): PlatformModule[] {
  return project.modules.filter((m) => m.type === 'exhaust');
}

/** 默认演示平台：生活楼 + 火炬臂 + 2 台透平排气 + 吊机 + 直升机甲板 */
export function createDefaultProject(name = '示例平台 A'): PlatformProject {
  const now = Date.now();
  const modules: PlatformModule[] = [
    {
      id: uid('mod'), name: '生活楼', type: 'living',
      position: { x: -18, y: -6, z: 14 }, size: { x: 24, y: 16, z: 22 },
      color: '#7fb3d5',
    },
    {
      id: uid('mod'), name: '火炬臂', type: 'flare',
      position: { x: -46, y: 20, z: 20 }, size: { x: 34, y: 4, z: 4 },
      color: '#e59866',
    },
    {
      id: uid('mod'), name: '1 号透平排气', type: 'exhaust',
      position: { x: -10, y: 2, z: 30 }, size: { x: 2.4, y: 2.4, z: 8 },
      exhaust: { turbineId: 'tb-1', massFlow: 32, temperatureK: 623 },
      color: '#cd6155',
    },
    {
      id: uid('mod'), name: '2 号透平排气', type: 'exhaust',
      position: { x: -14, y: 6, z: 30 }, size: { x: 2.4, y: 2.4, z: 8 },
      exhaust: { turbineId: 'tb-2', massFlow: 30, temperatureK: 618 },
      color: '#cd6155',
    },
    {
      id: uid('mod'), name: '吊机', type: 'crane',
      position: { x: 14, y: -14, z: 12 }, size: { x: 6, y: 6, z: 20 },
      color: '#f4d03f',
    },
    {
      id: uid('mod'), name: '直升机甲板', type: 'helideck',
      position: { x: 16, y: 14, z: 24 }, size: { x: 22.2, y: 22.2, z: 0.6 },
      helideck: { diameter: 22.2, approachBearingDeg: 45 },
      color: '#2ecc71',
    },
  ];

  return {
    id: uid('proj'),
    name,
    createdAt: now,
    updatedAt: now,
    deckElevation: 24,
    airGap: 14,
    modules,
    turbines: [
      { id: 'tb-1', name: '1 号透平', running: true, massFlow: 32, exhaustTempK: 623 },
      { id: 'tb-2', name: '2 号透平', running: true, massFlow: 30, exhaustTempK: 618 },
    ],
    ambientTempK: 303.15,
    refHeightM: 9.144,
    thresholds: { ...DEFAULT_THRESHOLDS },
  };
}

/** 简化体块导入格式（JSON：一组轴对齐盒子） */
export interface BlockImport {
  name: string;
  type: PlatformModule['type'];
  position: Vec3;
  size: Vec3;
  color?: string;
}

export function blocksToModules(blocks: BlockImport[]): PlatformModule[] {
  return blocks.map((b) => ({
    id: uid('mod'),
    name: b.name,
    type: b.type,
    position: { ...b.position },
    size: { ...b.size },
    color: b.color,
  }));
}
