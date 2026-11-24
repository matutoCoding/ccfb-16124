import type {
  DirectionField, GridSpec, PlatformModule, RouteSample, Vec3,
} from '../domain/types';
import { gridBounds } from '../domain/grid';
import type { IsoMesh } from '../domain/isosurface';
import { initWebGPU, FpsMeter } from './gpuContext';
import { OrbitCamera } from './camera';
import { FieldTextures } from './fieldTextures';
import { SliceRenderer, type SliceAxis, type ColorMode } from './sliceRenderer';
import { ParticleSystem } from './particleSystem';
import { SceneRenderer } from './sceneRenderer';

export interface EngineState {
  axis: SliceAxis;
  slicePosition: number;
  colorMode: ColorMode;
  speedRange: number;
  kernelLength: number;
  showParticles: boolean;
  showIso: boolean;
  showRoutes: boolean;
  refZ: number;
  showRefLayer: boolean;
}

/**
 * 可视化总引擎。
 * 渲染顺序：不透明体块（写深度）-> 等温面半透明 -> 切片 LIC 平面 -> 粒子 -> 航线。
 * LIC 相位按当地平均流速推进，实现"风大流动快"。
 */
export class VisualizationEngine {
  private canvas: HTMLCanvasElement;
  private context!: GPUCanvasContext;
  private device!: GPUDevice;
  private format!: GPUTextureFormat;
  private camera: OrbitCamera;
  private fps = new FpsMeter();
  private fields!: FieldTextures;
  private slice!: SliceRenderer;
  private particles!: ParticleSystem;
  private scene!: SceneRenderer;
  private depthTexture!: GPUTexture;
  private sceneBind!: GPUBindGroup;
  private grid!: GridSpec;
  private field!: DirectionField;
  private isoMeshes: { mesh: IsoMesh; level: number }[] = [];
  private routeSamples: RouteSample[] = [];
  private routeBind?: GPUBindGroup;
  private raf = 0;
  private lastTime = 0;
  private phase = 0;
  private running = false;
  private resizeObserver?: ResizeObserver;
  onFps?: (fps: number, scale: number) => void;

  state: EngineState = {
    axis: 2,
    slicePosition: 0,
    colorMode: 'speed',
    speedRange: 25,
    kernelLength: 10,
    showParticles: true,
    showIso: true,
    showRoutes: true,
    refZ: 33,
    showRefLayer: false,
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.camera = new OrbitCamera(canvas);
  }

  static async create(canvas: HTMLCanvasElement): Promise<VisualizationEngine> {
    const engine = new VisualizationEngine(canvas);
    await engine.init();
    return engine;
  }

  async init(): Promise<void> {
    const gpu = await initWebGPU(this.canvas);
    this.device = gpu.device;
    this.format = gpu.format;
    this.context = gpu.context;
    this.scene = new SceneRenderer(this.device, this.format);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas);
    this.resize();
  }

  setData(
    grid: GridSpec,
    field: DirectionField,
    modules: PlatformModule[],
    isoMeshes: { mesh: IsoMesh; level: number }[],
    routeSamples: RouteSample[],
  ): void {
    this.fields?.destroy();
    this.grid = grid;
    this.field = field;
    this.isoMeshes = isoMeshes;
    this.routeSamples = routeSamples;

    this.fields = new FieldTextures(this.device, grid, field);
    this.slice = new SliceRenderer(this.device, this.format, this.fields);
    this.particles = new ParticleSystem(this.device, this.format, this.fields, this.scene.sceneLayouts, 4000);
    this.sceneBind = this.scene.buildSceneBindGroup(modules);
    if (routeSamples.length) this.routeBind = this.scene.updateRoute(routeSamples);

    const bounds = gridBounds(grid);
    this.state.slicePosition = this.clampSlice(bounds.min[axisName(this.state.axis)] +
      (bounds.max[axisName(this.state.axis)] - bounds.min[axisName(this.state.axis)]) * 0.5);
    this.state.refZ = this.state.refZ;
    this.resize();
  }

  /** 仅替换场（风向过渡/插值时复用纹理对象，避免重建管线） */
  updateField(field: DirectionField): void {
    this.field = field;
    this.fields.upload(field);
  }

  setState(patch: Partial<EngineState>): void {
    Object.assign(this.state, patch);
    if (patch.slicePosition !== undefined) {
      this.state.slicePosition = this.clampSlice(patch.slicePosition);
    }
  }

  private clampSlice(v: number): number {
    if (!this.grid) return v;
    const b = gridBounds(this.grid);
    const ax = axisName(this.state.axis);
    return Math.min(b.max[ax], Math.max(b.min[ax], v));
  }

  /** 一键贴到甲板上方参考层（30ft） */
  snapToRefLayer(refZ: number): void {
    this.state.axis = 2;
    this.state.slicePosition = this.clampSlice(refZ);
    this.state.showRefLayer = true;
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.depthTexture?.destroy();
    this.depthTexture = this.device.createTexture({
      size: [w, h],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.slice?.resize(w, h);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.frame(now);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private frame(now: number): void {
    const dt = Math.min(0.05, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const frameMs = now - (this.lastTime - dt * 1000);
    const fps = this.fps.tick(now);
    if (this.slice.adaptScale(frameMs)) this.resize();
    this.onFps?.(fps, this.slice.scale);

    // 相位推进：按全场平均速度缩放（风大流快）
    const meanSpeed = averageSpeed(this.field);
    const spacing = Math.min(this.grid.spacing.x, this.grid.spacing.y, this.grid.spacing.z);
    this.phase += (meanSpeed / Math.max(spacing, 0.1)) * dt * 1.5;

    const encoder = this.device.createCommandEncoder();

    // 粒子计算
    if (this.state.showParticles) {
      const halfThickness = spacing * 1.5;
      this.particles.update(
        encoder, this.grid, dt,
        this.state.axis, this.state.slicePosition, halfThickness,
      );
    }

    // LIC 离屏
    this.slice.render(this.grid, {
      axis: this.state.axis,
      position: this.state.slicePosition,
      colorMode: this.state.colorMode,
      speedRange: this.state.speedRange,
      phase: this.phase,
      kernelLength: this.state.kernelLength,
      showRefLayer: this.state.showRefLayer,
      refZ: this.state.refZ,
    }, encoder);

    // 主场景
    this.scene.updateCamera(this.camera, this.canvas.width / this.canvas.height);
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.07, g: 0.09, b: 0.12, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    // 显式布局：先绑定占位 group，保证 4 个槽位都有效，再按需覆盖
    const placeholders = this.scene.ensurePlaceholderGroups();
    placeholders.forEach((g, i) => pass.setBindGroup(i, g));

    this.scene.renderBoxes(pass, this.sceneBind);
    if (this.state.showIso) {
      for (const iso of this.isoMeshes) {
        this.scene.renderIso(pass, iso.mesh, iso.level === 2);
      }
    }
    const corners = this.sliceCorners();
    this.scene.renderSlicePlane(pass, corners, this.slice.textureView);
    if (this.state.showParticles) {
      this.particles.render(pass, this.sceneBind);
    }
    if (this.state.showRoutes && this.routeBind) {
      // 航线在 group2，渲染后恢复占位，避免影响后续 draw
      this.scene.renderRoute(pass, this.routeBind, this.routeSamples.length);
    }
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  /** 切片平面四边形角点（与 slice.wgsl 的 uv->世界映射保持同一约定） */
  private sliceCorners(): [Vec3, Vec3, Vec3, Vec3] {
    const b = gridBounds(this.grid);
    const ax = this.state.axis;
    const p = this.state.slicePosition;
    if (ax === 0) {
      return [
        { x: p, y: b.min.y, z: b.min.z },
        { x: p, y: b.max.y, z: b.min.z },
        { x: p, y: b.max.y, z: b.max.z },
        { x: p, y: b.min.y, z: b.max.z },
      ];
    }
    if (ax === 1) {
      return [
        { x: b.min.x, y: p, z: b.min.z },
        { x: b.max.x, y: p, z: b.min.z },
        { x: b.max.x, y: p, z: b.max.z },
        { x: b.min.x, y: p, z: b.max.z },
      ];
    }
    return [
      { x: b.min.x, y: b.min.y, z: p },
      { x: b.min.x, y: b.max.y, z: p },
      { x: b.max.x, y: b.max.y, z: p },
      { x: b.max.x, y: b.min.y, z: p },
    ];
  }

  dispose(): void {
    this.stop();
    this.resizeObserver?.disconnect();
    this.camera.dispose();
    this.fields?.destroy();
    this.depthTexture?.destroy();
  }
}

function axisName(axis: SliceAxis): keyof Vec3 {
  return axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
}

function averageSpeed(field: DirectionField): number {
  let sum = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(field.u.length / 5000));
  for (let i = 0; i < field.u.length; i += step) {
    if (Number.isFinite(field.u[i])) {
      sum += Math.hypot(field.u[i], field.v[i], field.w[i]);
      n++;
    }
  }
  return n ? sum / n : 0;
}
