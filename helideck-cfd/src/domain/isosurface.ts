import type { GridSpec, Vec3 } from './types';

/**
 * Marching Tetrahedra 等值面提取（规则 5）。
 * 立方体按 6 个四面体分解，无二义性情形，表只有 16 种顶点构型，
 * 比 Marching Cubes 的 256 项三角表更易审计。输出普通三角形网格，
 * 2K 等温面额外输出线框边用于描边。
 */

export interface IsoMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  edges: Uint32Array;
}

// 6 个四面体的 4 顶点（立方体角点编号见 corner 函数）
const TETS: [number, number, number, number][] = [
  [0, 1, 2, 6],
  [0, 2, 3, 6],
  [0, 3, 7, 6],
  [0, 7, 4, 6],
  [0, 4, 5, 6],
  [0, 5, 1, 6],
];

// 四面体 6 条棱（顶点对）
const EDGE_PAIRS: [number, number][] = [
  [0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3],
];

function corner(i: number, j: number, k: number, c: number): [number, number, number] {
  return [i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1)];
}

export function extractIsosurface(
  grid: GridSpec,
  field: Float32Array,
  isoValue: number,
): IsoMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const edges: number[] = [];
  const idx = (i: number, j: number, k: number) => i + grid.nx * (j + grid.ny * k);
  const pos = (i: number, j: number, k: number): Vec3 => ({
    x: grid.origin.x + i * grid.spacing.x,
    y: grid.origin.y + j * grid.spacing.y,
    z: grid.origin.z + k * grid.spacing.z,
  });

  for (let k = 0; k < grid.nz - 1; k++) {
    for (let j = 0; j < grid.ny - 1; j++) {
      for (let i = 0; i < grid.nx - 1; i++) {
        const cv: number[] = [];
        const cp: Vec3[] = [];
        for (let c = 0; c < 8; c++) {
          const [ci, cj, ck] = corner(i, j, k, c);
          const val = field[idx(ci, cj, ck)];
          cv.push(val);
          cp.push(pos(ci, cj, ck));
        }
        // 含缺测格点的单元跳过（等值面不允许穿过缺测区）
        if (cv.some((v) => !Number.isFinite(v))) continue;

        for (const tet of TETS) {
          const vals = tet.map((c) => cv[c]);
          const pts = tet.map((c) => cp[c]);
          const caseIdx = (vals[0] > isoValue ? 1 : 0)
            | (vals[1] > isoValue ? 2 : 0)
            | (vals[2] > isoValue ? 4 : 0)
            | (vals[3] > isoValue ? 8 : 0);
          if (caseIdx === 0 || caseIdx === 15) continue;

          // 求每条棱的交点
          const edgePoint: (Vec3 | null)[] = new Array(6).fill(null);
          for (let e = 0; e < 6; e++) {
            const [a, b] = EDGE_PAIRS[e];
            const va = vals[a];
            const vb = vals[b];
            if ((va > isoValue) === (vb > isoValue)) continue;
            const tt = (isoValue - va) / (vb - va);
            edgePoint[e] = {
              x: pts[a].x + (pts[b].x - pts[a].x) * tt,
              y: pts[a].y + (pts[b].y - pts[a].y) * tt,
              z: pts[a].z + (pts[b].z - pts[a].z) * tt,
            };
          }

          // 构型三角化：inside 集合为 1 或 3 个顶点 => 1 个三角形；2 个 => 四边形(2 三角形)
          const inside = [0, 1, 2, 3].filter((v) => vals[v] > isoValue);
          const edgesOfInside = (v: number) => EDGE_PAIRS.map(([a, b], e) => (a === v || b === v ? e : -1)).filter((e) => e >= 0);
          const hitEdges = [...new Set(inside.flatMap(edgesOfInside))].filter((e) => edgePoint[e] !== null);

          const addVertex = (p: Vec3) => {
            const vi = positions.length / 3;
            positions.push(p.x, p.y, p.z);
            return vi;
          };
          const verts = hitEdges.map((e) => addVertex(edgePoint[e]!));
          if (verts.length === 3) {
            // 朝向：使法线朝低值区外（高值侧）
            const order = inside.length === 1 ? [0, 1, 2] : [2, 1, 0];
            indices.push(verts[order[0]], verts[order[1]], verts[order[2]]);
          } else if (verts.length === 4) {
            indices.push(verts[0], verts[1], verts[2], verts[0], verts[2], verts[3]);
          }
          for (let q = 0; q < verts.length; q++) {
            edges.push(verts[q], verts[(q + 1) % verts.length]);
          }
        }
      }
    }
  }

  const positionsArr = new Float32Array(positions);
  const normals = computeNormals(positionsArr, indices);
  return {
    positions: positionsArr,
    normals,
    indices: new Uint32Array(indices),
    edges: new Uint32Array(edges),
  };
}

function computeNormals(positions: Float32Array, indices: number[]): Float32Array {
  const normals = new Float32Array(positions.length);
  for (let q = 0; q < indices.length; q += 3) {
    const a = indices[q] * 3;
    const b = indices[q + 1] * 3;
    const c = indices[q + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const vi of [a, b, c]) {
      normals[vi] += nx;
      normals[vi + 1] += ny;
      normals[vi + 2] += nz;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len;
  }
  return normals;
}
