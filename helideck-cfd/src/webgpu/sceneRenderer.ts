import commonWgsl from './shaders/common.wgsl?raw';
import sceneWgsl from './shaders/scene.wgsl?raw';
import type { PlatformModule, RouteSample, Vec3 } from '../domain/types';
import { moduleAABB } from '../domain/platform';
import type { IsoMesh } from '../domain/isosurface';
import type { OrbitCamera } from './camera';
import { createSceneLayouts, type SceneLayouts } from './layouts';

const MODULE_COLORS: Record<string, [number, number, number]> = {
  living: [0.5, 0.7, 0.84],
  flare: [0.9, 0.6, 0.4],
  exhaust: [0.8, 0.38, 0.33],
  crane: [0.96, 0.82, 0.25],
  helideck: [0.18, 0.8, 0.44],
  block: [0.65, 0.65, 0.7],
};

/**
 * 3D 场景渲染：平台体块（实例化）、等温面（半透明 + 2K 描边）、
 * 航线线段（超限段红色）、甲板圆盘。
 * 相机 uniform 与粒子/切片平面共享。
 */
export class SceneRenderer {
  private device: GPUDevice;
  private module: GPUShaderModule;
  private boxPipeline: GPURenderPipeline;
  private isoPipeline: GPURenderPipeline;
  private isoEdgePipeline: GPURenderPipeline;
  private routePipeline: GPURenderPipeline;
  private slicePlanePipeline: GPURenderPipeline;
  private cameraBuffer: GPUBuffer;
  private boxBuffer: GPUBuffer;
  private boxCount = 0;
  private sampler: GPUSampler;
  private slicePlaneBuffer: GPUBuffer;
  private slicePlaneBind?: GPUBindGroup;
  private slicePlaneTexture?: GPUTextureView;
  private layouts: SceneLayouts;

  /** 共享布局，供粒子渲染管线复用同一 pipeline layout */
  get sceneLayouts(): SceneLayouts {
    return this.layouts;
  }

  private placeholderGroups?: GPUBindGroup[];
  /**
   * 显式布局下每个 draw 都要求 4 个 group 齐备。
   * 返回一组占位绑定（最小资源），在 pass 开头统一 set，
   * 后续各 render 方法按需覆盖自己真正使用的 group。
   */
  ensurePlaceholderGroups(): GPUBindGroup[] {
    if (this.placeholderGroups) return this.placeholderGroups;
    const dev = this.device;
    const dummyStorage = dev.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE });
    const dummyUniform = dev.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM });
    const dummyTex = dev.createTexture({
      size: [1, 1, 1], dimension: '3d', format: 'r32float',
      usage: GPUTextureUsage.TEXTURE_BINDING,
    }).createView();
    const g1 = dev.createBindGroup({
      layout: this.layouts.group1,
      entries: [
        { binding: 0, resource: { buffer: dummyStorage } },
        { binding: 1, resource: dummyTex },
        { binding: 2, resource: dummyTex },
        { binding: 3, resource: dummyTex },
        { binding: 4, resource: { buffer: dummyUniform } },
      ],
    });
    const g2 = dev.createBindGroup({
      layout: this.layouts.group2,
      entries: [{ binding: 0, resource: { buffer: dummyStorage } }],
    });
    const g3 = dev.createBindGroup({
      layout: this.layouts.group3,
      entries: [
        { binding: 0, resource: { buffer: dummyUniform } },
        { binding: 1, resource: dev.createTexture({
          size: [1, 1], format: 'bgra8unorm', usage: GPUTextureUsage.TEXTURE_BINDING,
        }).createView() },
        { binding: 2, resource: this.sampler },
      ],
    });
    this.placeholderGroups = [this.buildCameraOnlyBind(), g1, g2, g3];
    return this.placeholderGroups;
  }

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.layouts = createSceneLayouts(device);
    this.module = device.createShaderModule({
      code: commonWgsl + '\n' + sceneWgsl.replace('#include_common', ''),
    });

    // Camera: mat4(64) + eye/right/up 三个 vec4(48) = 112；SceneUniforms 再加 misc(16) = 128
    this.cameraBuffer = device.createBuffer({ size: 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // SlicePlaneUniforms: Camera(112) + corners 4×vec4(64) = 176
    this.slicePlaneBuffer = device.createBuffer({ size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.boxPipeline = device.createRenderPipeline({
      layout: this.layouts.pipelineLayout,
      vertex: { module: this.module, entryPoint: 'boxVs' },
      fragment: { module: this.module, entryPoint: 'boxFs', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: DEPTH_STATE(format),
    });

    this.isoPipeline = device.createRenderPipeline({
      layout: this.layouts.pipelineLayout,
      vertex: { module: this.module, entryPoint: 'isoVs', buffers: [MESH_LAYOUT] },
      fragment: {
        module: this.module, entryPoint: 'isoFs',
        targets: [{ format, blend: ALPHA_BLEND }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: DEPTH_STATE(format),
    });

    this.isoEdgePipeline = device.createRenderPipeline({
      layout: this.layouts.pipelineLayout,
      vertex: { module: this.module, entryPoint: 'isoEdgeVs', buffers: [MESH_LAYOUT] },
      fragment: { module: this.module, entryPoint: 'isoEdgeFs', targets: [{ format }] },
      primitive: { topology: 'line-list' },
      depthStencil: DEPTH_STATE(format),
    });

    this.routePipeline = device.createRenderPipeline({
      layout: this.layouts.pipelineLayout,
      vertex: { module: this.module, entryPoint: 'routeVs' },
      fragment: { module: this.module, entryPoint: 'routeFs', targets: [{ format }] },
      primitive: { topology: 'line-strip' },
      depthStencil: DEPTH_STATE(format),
    });

    this.slicePlanePipeline = device.createRenderPipeline({
      layout: this.layouts.pipelineLayout,
      vertex: { module: this.module, entryPoint: 'slicePlaneVs' },
      fragment: {
        module: this.module, entryPoint: 'slicePlaneFs',
        targets: [{ format, blend: ALPHA_BLEND }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: DEPTH_STATE(format),
    });

    this.boxBuffer = device.createBuffer({ size: 48 * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  }

  /** 每帧写相机；Camera 112 字节同时复制到切片平面 uniform，misc 在偏移 112 */
  updateCamera(camera: OrbitCamera, aspect: number): void {
    const vp = camera.viewProjMatrix(aspect);
    const eye = camera.eye();
    const right = camera.rightVectorPublic();
    const up = camera.upVectorPublic();
    // Camera 结构：viewProj(16) + eye(4) + right(4) + up(4) = 24 浮点 = 96...
    // 实际 WGSL: mat4x4 占 64 字节(16 浮点)，后接 3 个 vec4，共 112 字节 = 28 浮点
    const data = new Float32Array(28);
    data.set(vp, 0);
    data.set([eye.x, eye.y, eye.z, 1], 16);
    data.set([right.x, right.y, right.z, 0], 20);
    data.set([up.x, up.y, up.z, 0], 24);
    this.device.queue.writeBuffer(this.cameraBuffer, 0, data);
    this.device.queue.writeBuffer(this.slicePlaneBuffer, 0, data);
    // SceneUniforms.misc（Camera 之后，偏移 112）：x=点精灵尺寸(米)
    this.device.queue.writeBuffer(this.cameraBuffer, 112, new Float32Array([1.6, 0, 0, 0]));
  }

  /** 场景根 bind group（binding0 相机，binding1 体块存储） */
  buildSceneBindGroup(modules: PlatformModule[]): GPUBindGroup {
    const boxes = modules.map((m) => {
      const b = moduleAABB(m);
      const c = MODULE_COLORS[m.type] ?? [0.7, 0.7, 0.7];
      return { b, c };
    });
    this.boxCount = boxes.length;
    const data = new Float32Array(this.boxCount * 12);
    boxes.forEach((box, i) => {
      const o = i * 12;
      data.set([box.b.min.x, box.b.min.y, box.b.min.z, 0], o);
      data.set([box.b.max.x, box.b.max.y, box.b.max.z, 0], o + 4);
      data.set([box.c[0], box.c[1], box.c[2], 1], o + 8);
    });
    const need = this.boxCount * 48;
    if (need > this.boxBuffer.size) {
      this.boxBuffer.destroy();
      this.boxBuffer = this.device.createBuffer({ size: need * 2, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    this.device.queue.writeBuffer(this.boxBuffer, 0, data);
    return this.device.createBindGroup({
      layout: this.layouts.group0,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.boxBuffer } },
      ],
    });
  }

  renderBoxes(pass: GPURenderPassEncoder, sceneBind: GPUBindGroup): void {
    pass.setPipeline(this.boxPipeline);
    pass.setBindGroup(0, sceneBind);
    pass.draw(36, this.boxCount);
  }

  private meshBuffers = new WeakMap<IsoMesh, { pos: GPUBuffer; idx: GPUBuffer; edge: GPUBuffer }>();

  private ensureMesh(mesh: IsoMesh) {
    let cached = this.meshBuffers.get(mesh);
    if (cached) return cached;
    const vcount = mesh.positions.length / 3;
    // 交错排列：[pos.xyz, normal.xyz] * 顶点数，arrayStride=24
    const interleaved = new Float32Array(vcount * 6);
    for (let i = 0; i < vcount; i++) {
      interleaved[i * 6] = mesh.positions[i * 3];
      interleaved[i * 6 + 1] = mesh.positions[i * 3 + 1];
      interleaved[i * 6 + 2] = mesh.positions[i * 3 + 2];
      interleaved[i * 6 + 3] = mesh.normals[i * 3];
      interleaved[i * 6 + 4] = mesh.normals[i * 3 + 1];
      interleaved[i * 6 + 5] = mesh.normals[i * 3 + 2];
    }
    const pos = this.device.createBuffer({
      size: Math.max(16, interleaved.byteLength),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(pos, 0, interleaved);
    const idx = this.device.createBuffer({
      size: Math.max(16, mesh.indices.byteLength),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    const idxCopy = new Uint32Array(mesh.indices.length);
    idxCopy.set(mesh.indices);
    this.device.queue.writeBuffer(idx, 0, idxCopy);
    // 描边线框：edges 存顶点索引对，作为索引缓冲配合位置顶点使用
    const edge = this.device.createBuffer({
      size: Math.max(16, mesh.edges.byteLength),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    const edgeCopy = new Uint32Array(mesh.edges.length);
    edgeCopy.set(mesh.edges);
    this.device.queue.writeBuffer(edge, 0, edgeCopy);
    cached = { pos, idx, edge };
    this.meshBuffers.set(mesh, cached);
    return cached;
  }

  renderIso(pass: GPURenderPassEncoder, mesh: IsoMesh, highlighted: boolean): void {
    const b = this.ensureMesh(mesh);
    pass.setPipeline(this.isoPipeline);
    pass.setBindGroup(0, this.buildCameraOnlyBind());
    pass.setVertexBuffer(0, b.pos);
    pass.setIndexBuffer(b.idx, 'uint32');
    pass.drawIndexed(mesh.indices.length);
    if (highlighted) {
      pass.setPipeline(this.isoEdgePipeline);
      // edge 缓冲里存的是顶点索引，line-list 需要实际位置：用索引缓冲配合同一个位置布局
      pass.setVertexBuffer(0, b.pos);
      pass.setIndexBuffer(b.edge, 'uint32');
      pass.drawIndexed(mesh.edges.length);
    }
  }

  private cameraOnly?: GPUBindGroup;
  private buildCameraOnlyBind(): GPUBindGroup {
    if (this.cameraOnly) return this.cameraOnly;
    // group0 含两个 binding，体块 binding 给一个最小占位 storage buffer
    if (!this.placeholderBoxBuffer) {
      this.placeholderBoxBuffer = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.STORAGE });
    }
    this.cameraOnly = this.device.createBindGroup({
      layout: this.layouts.group0,
      entries: [
        { binding: 0, resource: { buffer: this.cameraBuffer } },
        { binding: 1, resource: { buffer: this.placeholderBoxBuffer } },
      ],
    });
    return this.cameraOnly;
  }
  private placeholderBoxBuffer?: GPUBuffer;

  private routeBuffer?: GPUBuffer;
  updateRoute(samples: RouteSample[]): GPUBindGroup {
    // 每个点 8 浮点：pos.xyzw + flag.xyzw
    const data = new Float32Array(samples.length * 8);
    samples.forEach((s, i) => {
      const o = i * 8;
      data.set([s.position.x, s.position.y, s.position.z, 0], o);
      data.set([s.verticalExceed ? 1 : 0, s.tempExceed ? 1 : 0, 0, 0], o + 4);
    });
    if (!this.routeBuffer || this.routeBuffer.size < data.byteLength) {
      this.routeBuffer?.destroy();
      this.routeBuffer = this.device.createBuffer({
        size: Math.max(256, data.byteLength * 2),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    }
    this.device.queue.writeBuffer(this.routeBuffer, 0, data);
    return this.device.createBindGroup({
      layout: this.layouts.group2,
      entries: [{ binding: 0, resource: { buffer: this.routeBuffer } }],
    });
  }

  renderRoute(pass: GPURenderPassEncoder, bind: GPUBindGroup, pointCount: number): void {
    pass.setPipeline(this.routePipeline);
    // WGSL 中航线资源在 @group(2)
    pass.setBindGroup(2, bind);
    pass.draw(pointCount);
  }

  renderSlicePlane(
    pass: GPURenderPassEncoder,
    corners: [Vec3, Vec3, Vec3, Vec3],
    sliceTexture: GPUTextureView,
  ): void {
    const cornerData = new Float32Array(16);
    corners.forEach((c, i) => cornerData.set([c.x, c.y, c.z, 0], i * 4));
    // corners 位于 Camera(112 字节) 之后
    this.device.queue.writeBuffer(this.slicePlaneBuffer, 112, cornerData);
    if (!this.slicePlaneBind || this.slicePlaneTexture !== sliceTexture) {
      this.slicePlaneTexture = sliceTexture;
      this.slicePlaneBind = this.device.createBindGroup({
        layout: this.layouts.group3,
        entries: [
          { binding: 0, resource: { buffer: this.slicePlaneBuffer } },
          { binding: 1, resource: sliceTexture },
          { binding: 2, resource: this.sampler },
        ],
      });
    }
    pass.setPipeline(this.slicePlanePipeline);
    pass.setBindGroup(3, this.slicePlaneBind);
    pass.draw(6);
  }
}

const MESH_LAYOUT: GPUVertexBufferLayout = {
  arrayStride: 24,
  attributes: [
    { shaderLocation: 0, offset: 0, format: 'float32x3' },
    { shaderLocation: 1, offset: 12, format: 'float32x3' },
  ],
};

function DEPTH_STATE(_format: GPUTextureFormat): GPUDepthStencilState {
  return {
    format: 'depth24plus',
    depthWriteEnabled: true,
    depthCompare: 'less',
  };
}

const ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};
