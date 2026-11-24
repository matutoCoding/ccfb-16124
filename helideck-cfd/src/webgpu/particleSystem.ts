import commonWgsl from './shaders/common.wgsl?raw';
import particlesWgsl from './shaders/particles.wgsl?raw';
import sceneWgsl from './shaders/scene.wgsl?raw';
import type { FieldTextures } from './fieldTextures';
import type { GridSpec } from '../domain/types';
import type { SceneLayouts } from './layouts';

const PARTICLE_FLOATS = 8; // pos.xyzw + seed.xyzw

/**
 * GPU 粒子系统：
 *  - compute 管线在切片平面附近平流粒子（物理速度，子步长 ≤0.35 格距）
 *  - 渲染管线画面向相机的广告牌三角形，颜色按速度
 * 粒子寿命结束/出界/进入缺测区即重撒，密度恒定。
 */
export class ParticleSystem {
  private device: GPUDevice;
  private computePipeline: GPUComputePipeline;
  private renderPipeline: GPURenderPipeline;
  private particleBuffer: GPUBuffer;
  private computeUniform: GPUBuffer;
  private computeBind: GPUBindGroup;
  private renderBind: GPUBindGroup;
  private gridUniform: GPUBuffer;
  readonly count: number;

  constructor(
    device: GPUDevice,
    format: GPUTextureFormat,
    fields: FieldTextures,
    layouts: SceneLayouts,
    count = 4000,
  ) {
    this.device = device;
    this.count = count;
    const grid = fields.grid;

    // 计算管线独立布局：binding0-2 三维纹理，3 uniform，4 粒子存储
    const computeBGL = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const computeLayout = device.createPipelineLayout({ bindGroupLayouts: [computeBGL] });

    const cModule = device.createShaderModule({
      code: commonWgsl + '\n' + particlesWgsl.replace('#include_common', ''),
    });
    this.computePipeline = device.createComputePipeline({
      layout: computeLayout,
      compute: { module: cModule, entryPoint: 'csMain' },
    });

    const rModule = device.createShaderModule({
      code: commonWgsl + '\n' + sceneWgsl.replace('#include_common', ''),
    });
    this.renderPipeline = device.createRenderPipeline({
      // 与场景共用四组布局，group0 相机/体块、group1 粒子资源
      layout: layouts.pipelineLayout,
      vertex: { module: rModule, entryPoint: 'particleVs' },
      fragment: {
        module: rModule,
        entryPoint: 'particleFs',
        targets: [{ format, blend: ALPHA_BLEND }],
      },
      primitive: { topology: 'triangle-list' },
    });

    this.particleBuffer = device.createBuffer({
      size: count * PARTICLE_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.seedParticles(grid);

    // ParticleUniforms: GridUniforms(48) + params(16) + extra(16) + seed(16) = 96
    this.computeUniform = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.computeBind = device.createBindGroup({
      layout: computeBGL,
      entries: [
        ...fields.bindEntries(0),
        { binding: 3, resource: { buffer: this.computeUniform } },
        { binding: 4, resource: { buffer: this.particleBuffer } },
      ],
    });

    this.gridUniform = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.writeGrid(grid);
    this.renderBind = device.createBindGroup({
      layout: layouts.group1,
      entries: [
        { binding: 0, resource: { buffer: this.particleBuffer } },
        ...fields.bindEntries(1).slice(0, 3),
        { binding: 4, resource: { buffer: this.gridUniform } },
      ],
    });
  }

  private seedParticles(grid: GridSpec): void {
    const data = new Float32Array(this.count * PARTICLE_FLOATS);
    for (let i = 0; i < this.count; i++) {
      const base = i * PARTICLE_FLOATS;
      data[base] = grid.origin.x + Math.random() * (grid.nx - 1) * grid.spacing.x;
      data[base + 1] = grid.origin.y + Math.random() * (grid.ny - 1) * grid.spacing.y;
      data[base + 2] = grid.origin.z + Math.random() * (grid.nz - 1) * grid.spacing.z;
      data[base + 3] = Math.random() * 8 + 2;
      data[base + 4] = Math.random();
    }
    this.device.queue.writeBuffer(this.particleBuffer, 0, data);
  }

  private writeGrid(grid: GridSpec): void {
    const d = new Float32Array(12);
    d.set([grid.origin.x, grid.origin.y, grid.origin.z, 0], 0);
    d.set([grid.spacing.x, grid.spacing.y, grid.spacing.z, 0], 4);
    d.set([grid.nx, grid.ny, grid.nz, 0], 8);
    this.device.queue.writeBuffer(this.gridUniform, 0, d);
  }

  /** 每帧推进；axis/position 决定粒子被约束的切片平面 */
  update(
    encoder: GPUCommandEncoder,
    grid: GridSpec,
    dt: number,
    axis: number,
    position: number,
    sliceHalfThickness: number,
  ): void {
    const d = new Float32Array(20);
    d.set([grid.origin.x, grid.origin.y, grid.origin.z, 0], 0);
    d.set([grid.spacing.x, grid.spacing.y, grid.spacing.z, 0], 4);
    d.set([grid.nx, grid.ny, grid.nz, 0], 8);
    d.set([dt, this.count, axis, position], 12);
    d.set([sliceHalfThickness, 0.3, 0, 0], 16);
    this.device.queue.writeBuffer(this.computeUniform, 0, d);

    const pass = encoder.beginComputePass();
    pass.setPipeline(this.computePipeline);
    pass.setBindGroup(0, this.computeBind);
    pass.dispatchWorkgroups(Math.ceil(this.count / 64));
    pass.end();
  }

  render(pass: GPURenderPassEncoder, sceneBindGroup: GPUBindGroup): void {
    pass.setPipeline(this.renderPipeline);
    pass.setBindGroup(0, sceneBindGroup);
    pass.setBindGroup(1, this.renderBind);
    // 每实例一个 3 顶点广告牌三角形
    pass.draw(3, this.count);
  }
}

const ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
