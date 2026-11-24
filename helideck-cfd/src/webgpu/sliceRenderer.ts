import commonWgsl from './shaders/common.wgsl?raw';
import sliceWgsl from './shaders/slice.wgsl?raw';
import type { FieldTextures } from './fieldTextures';
import type { GridSpec } from '../domain/types';

export type SliceAxis = 0 | 1 | 2; // 0=x 1=y 2=z
export type ColorMode = 'speed' | 'vertical';

export interface SliceOptions {
  axis: SliceAxis;
  /** 切片世界坐标位置（米） */
  position: number;
  colorMode: ColorMode;
  /** 速度量程（颜色映射上限） */
  speedRange: number;
  /** 动画相位（每帧按流速推进） */
  phase: number;
  kernelLength: number;
  /** 参考层高亮（z 切片） */
  showRefLayer: boolean;
  refZ: number;
}

// SliceUniforms: GridUniforms(48) + params(16) + slice(16) + colorCfg(16) = 96
const UNIFORM_SIZE = 96;
const GRID_OFFSET = 0;
const PARAMS_OFFSET = 48;
const SLICE_OFFSET = 64;
const COLOR_OFFSET = 80;

/**
 * 切片 LIC 离屏渲染器。
 * LIC 积分成本与分辨率、kernel 长度成正比；为保证拖动 60fps：
 *  1) 内部渲染目标按 renderScale 降采样（默认 0.75），最终场景中双线性放大
 *  2) 暴露 adaptScale()，按实测帧时间自动在 0.5/0.75/1.0 间切换
 */
export class SliceRenderer {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline;
  private uniformBuffer: GPUBuffer;
  private target: GPUTexture;
  private targetView: GPUTextureView;
  private bindGroup: GPUBindGroup;
  private width = 1;
  private height = 1;
  private renderScale = 0.75;
  private lowFpsStreak = 0;
  private highFpsStreak = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat, fields: FieldTextures) {
    this.device = device;
    this.format = format;
    const module = device.createShaderModule({
      code: commonWgsl + '\n' + sliceWgsl.replace('#include_common', ''),
    });
    this.pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsMain' },
      fragment: { module, entryPoint: 'fsMain', targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.target = device.createTexture({
      size: [1, 1],
      format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.targetView = this.target.createView();
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        ...fields.bindEntries(0),
        { binding: 4, resource: { buffer: this.uniformBuffer } },
      ],
    });
  }

  get textureView(): GPUTextureView {
    return this.targetView;
  }

  get scale(): number {
    return this.renderScale;
  }

  resize(cssWidth: number, cssHeight: number): void {
    const w = Math.max(1, Math.floor(cssWidth * this.renderScale));
    const h = Math.max(1, Math.floor(cssHeight * this.renderScale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.target.destroy();
    this.target = this.device.createTexture({
      size: [w, h],
      format: this.format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.targetView = this.target.createView();
  }

  /**
   * 按实测帧时间自适应：
   * 连续 30 帧 >22ms 降一档；连续 120 帧 <12ms 升一档。
   */
  adaptScale(frameMs: number): boolean {
    if (frameMs > 22) {
      this.lowFpsStreak++;
      this.highFpsStreak = 0;
    } else if (frameMs < 12) {
      this.highFpsStreak++;
      this.lowFpsStreak = 0;
    } else {
      this.lowFpsStreak = 0;
      this.highFpsStreak = 0;
    }
    let changed = false;
    if (this.lowFpsStreak > 30 && this.renderScale > 0.5) {
      this.renderScale = Math.max(0.5, this.renderScale - 0.25);
      this.lowFpsStreak = 0;
      changed = true;
    } else if (this.highFpsStreak > 120 && this.renderScale < 1.0) {
      this.renderScale = Math.min(1.0, this.renderScale + 0.25);
      this.highFpsStreak = 0;
      changed = true;
    }
    return changed;
  }

  render(grid: GridSpec, opts: SliceOptions, encoder: GPUCommandEncoder): void {
    const data = new Float32Array(UNIFORM_SIZE / 4);
    // GridUniforms: origin(4) spacing(4) dims(4)
    data.set([grid.origin.x, grid.origin.y, grid.origin.z, 0], 0);
    data.set([grid.spacing.x, grid.spacing.y, grid.spacing.z, 0], 4);
    data.set([grid.nx, grid.ny, grid.nz, 0], 8);
    data.set(
      [this.width, this.height, opts.axis, opts.colorMode === 'speed' ? 0 : 1],
      PARAMS_OFFSET / 4,
    );
    data.set(
      [opts.position, Math.min(grid.spacing.x, grid.spacing.y, grid.spacing.z) * 0.4, opts.kernelLength, opts.phase],
      SLICE_OFFSET / 4,
    );
    data.set(
      [opts.speedRange, 7, opts.showRefLayer ? 1 : 0, opts.refZ],
      COLOR_OFFSET / 4,
    );
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.targetView,
        clearValue: { r: 0.05, g: 0.06, b: 0.08, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
  }
}

export { GRID_OFFSET };
