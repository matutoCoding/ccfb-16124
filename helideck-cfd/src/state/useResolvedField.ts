import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  DirectionField, GridSpec, PlatformProject, RouteAssessment,
} from '../domain/types';
import { fieldAtBearing } from '../domain/sectors';
import { extractIsosurface, type IsoMesh } from '../domain/isosurface';
import { buildRoutes, sampleRoute } from '../domain/routes';
import { deckRegionFromProject } from '../domain/rules';

const ISO_LEVELS = [2, 4, 7];

/**
 * 风场解析 hook：
 *  - bearing 任意方位角（0..359），在 CFD 风向间圆周插值
 *  - 拖动时用 rAF 平滑过渡（规则 8），显示方位以恒定角速度逼近目标，无跳变
 *  - 等温面按当前场提取（2K 描边），航线沿当前场采样
 */
export function useResolvedField(
  fields: DirectionField[] | null,
  project: PlatformProject | null,
  grid: GridSpec | null,
) {
  const [bearing, setBearingState] = useState(0);
  const [displayBearing, setDisplayBearing] = useState(0);
  const animRef = useRef<number>(0);
  const targetRef = useRef(0);
  const currentRef = useRef(0);

  const setBearing = (deg: number) => {
    const t = ((deg % 360) + 360) % 360;
    targetRef.current = t;
    setBearingState(t);
  };

  useEffect(() => {
    const tick = () => {
      const target = targetRef.current;
      const cur = currentRef.current;
      let diff = target - cur;
      if (diff > 180) diff -= 360;
      if (diff < -180) diff += 360;
      if (Math.abs(diff) < 0.05) {
        currentRef.current = target;
      } else {
        // 每帧最多 2.5°，与帧间隔无关的恒定角速度过渡
        currentRef.current = (currentRef.current + Math.sign(diff) * Math.min(Math.abs(diff), 2.5) + 360) % 360;
      }
      setDisplayBearing(currentRef.current);
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  const resolved = useMemo<DirectionField | null>(() => {
    if (!fields || fields.length === 0) return null;
    if (fields.length === 1) return fields[0];
    return fieldAtBearing(fields, displayBearing).field;
  }, [fields, displayBearing]);

  const isoMeshes = useMemo(() => {
    if (!resolved || !grid || !project) return [];
    return ISO_LEVELS.map((level) => ({
      level,
      mesh: extractIsosurface(grid, resolved.t, project.ambientTempK + level),
    })).filter((x) => x.mesh.indices.length > 0);
  }, [resolved, grid, project]);

  const routes = useMemo<RouteAssessment[]>(() => {
    if (!resolved || !project || !grid) return [];
    const region = deckRegionFromProject(project);
    if (!region) return [];
    return buildRoutes(project).map((r) =>
      sampleRoute(grid, resolved, r, project.thresholds, project.ambientTempK, region.approachBearingDeg));
  }, [resolved, project, grid]);

  return { bearing, displayBearing, setBearing, resolved, isoMeshes, routes };
}

export type { IsoMesh };
