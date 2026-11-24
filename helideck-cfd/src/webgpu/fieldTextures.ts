import type { DirectionField, GridSpec } from '../domain/types';

/**
 * 一套风场在 GPU 上的 4 张 R32Float 三维纹理（u/v/w/t）。
 * 不用 rgba32 打包：分量独立，NaN 缺测语义在单通道上更清晰，
 * 且三线性手工采样只需 textureLoad。
 */
export class FieldTextures {
  readonly grid: GridSpec;
  u: GPUTexture;
  v: GPUTexture;
  w: GPUTexture;
  t: GPUTexture;

  private device: GPUDevice;

  constructor(device: GPUDevice, grid: GridSpec, field: DirectionField) {
    this.device = device;
    this.grid = grid;
    const size: GPUExtent3D = [grid.nx, grid.ny, grid.nz];
    const desc: GPUTextureDescriptor = {
      size,
      dimension: '3d',
      format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    };
    this.u = device.createTexture(desc);
    this.v = device.createTexture(desc);
    this.w = device.createTexture(desc);
    this.t = device.createTexture(desc);
    this.upload(field);
  }

  upload(field: DirectionField): void {
    this.writeOne(this.u, field.u);
    this.writeOne(this.v, field.v);
    this.writeOne(this.w, field.w);
    this.writeOne(this.t, field.t);
  }

  private writeOne(tex: GPUTexture, data: Float32Array): void {
    const copy = new Float32Array(data.length);
    copy.set(data);
    this.device.queue.writeTexture(
      { texture: tex },
      copy,
      { bytesPerRow: this.grid.nx * 4, rowsPerImage: this.grid.ny },
      [this.grid.nx, this.grid.ny, this.grid.nz],
    );
  }

  bindEntries(bindingBase = 0): GPUBindGroupEntry[] {
    return [
      { binding: bindingBase, resource: this.u.createView() },
      { binding: bindingBase + 1, resource: this.v.createView() },
      { binding: bindingBase + 2, resource: this.w.createView() },
      { binding: bindingBase + 3, resource: this.t.createView() },
    ];
  }

  destroy(): void {
    this.u.destroy();
    this.v.destroy();
    this.w.destroy();
    this.t.destroy();
  }
}
