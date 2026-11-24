import type { Vec3 } from '../domain/types';

/**
 * 轨道相机：左键旋转、右键/中键平移、滚轮缩放。
 * 输出列主序 mat4（直接写入 WebGPU uniform）。
 */
export class OrbitCamera {
  target: Vec3 = { x: 0, y: 0, z: 15 };
  distance = 140;
  azimuth = Math.PI * 0.25;   // 绕 z 轴
  elevation = Math.PI * 0.32; // 与水平面夹角
  fovY = (50 * Math.PI) / 180;
  near = 0.5;
  far = 2000;

  private canvas: HTMLCanvasElement;
  private dragging: 'rotate' | 'pan' | null = null;
  private lastX = 0;
  private lastY = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  private onDown = (e: PointerEvent) => {
    this.dragging = e.button === 2 || e.button === 1 ? 'pan' : 'rotate';
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    if (this.dragging === 'rotate') {
      this.azimuth -= dx * 0.006;
      this.elevation = clamp(this.elevation + dy * 0.006, 0.08, Math.PI / 2 - 0.04);
    } else {
      const scale = this.distance * 0.0012;
      const right = this.rightVector();
      const up = this.upVector();
      this.target = {
        x: this.target.x - (right.x * dx - up.x * dy) * scale,
        y: this.target.y - (right.y * dx - up.y * dy) * scale,
        z: this.target.z - (right.z * dx - up.z * dy) * scale,
      };
    }
  };

  private onUp = () => { this.dragging = null; };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.distance = clamp(this.distance * Math.exp(e.deltaY * 0.001), 15, 800);
  };

  eye(): Vec3 {
    const ce = Math.cos(this.elevation);
    return {
      x: this.target.x + this.distance * ce * Math.sin(this.azimuth),
      y: this.target.y + this.distance * ce * Math.cos(this.azimuth),
      z: this.target.z + this.distance * Math.sin(this.elevation),
    };
  }

  private rightVector(): Vec3 {
    return { x: Math.cos(this.azimuth), y: -Math.sin(this.azimuth), z: 0 };
  }

  private upVector(): Vec3 {
    const ce = Math.cos(this.elevation);
    return {
      x: -Math.sin(this.elevation) * Math.sin(this.azimuth),
      y: -Math.sin(this.elevation) * Math.cos(this.azimuth),
      z: ce,
    };
  }

  rightVectorPublic(): Vec3 { return this.rightVector(); }
  upVectorPublic(): Vec3 { return this.upVector(); }

  /** 视图投影矩阵（列主序 Float32Array(16)） */
  viewProjMatrix(aspect: number): Float32Array {
    const eye = this.eye();
    const view = lookAt(eye, this.target, { x: 0, y: 0, z: 1 });
    const proj = perspective(this.fovY, aspect, this.near, this.far);
    return multiplyMat4(proj, view);
  }

  get isInteracting(): boolean {
    return this.dragging !== null;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function perspective(fovY: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  // 列主序
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, far * nf, -1,
    0, 0, far * near * nf, 0,
  ]);
}

function lookAt(eye: Vec3, center: Vec3, up: Vec3): Float32Array {
  let zx = eye.x - center.x;
  let zy = eye.y - center.y;
  let zz = eye.z - center.z;
  const zl = Math.hypot(zx, zy, zz);
  zx /= zl; zy /= zl; zz /= zl;
  let xx = up.y * zz - up.z * zy;
  let xy = up.z * zx - up.x * zz;
  let xz = up.x * zy - up.y * zx;
  const xl = Math.hypot(xx, xy, xz);
  xx /= xl; xy /= xl; xz /= xl;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye.x + xy * eye.y + xz * eye.z),
    -(yx * eye.x + yy * eye.y + yz * eye.z),
    -(zx * eye.x + zy * eye.y + zz * eye.z),
    1,
  ]);
}

function multiplyMat4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[0 * 4 + r] * b[c * 4 + 0] +
        a[1 * 4 + r] * b[c * 4 + 1] +
        a[2 * 4 + r] * b[c * 4 + 2] +
        a[3 * 4 + r] * b[c * 4 + 3];
    }
  }
  return out;
}
