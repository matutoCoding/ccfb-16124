/**
 * 显式管线布局定义。
 * 场景内多个管线（体块/等温面/航线/粒子/切片平面）共享同一组 bind group，
 * 必须使用同一份 GPUBindGroupLayout，auto layout 会按各着色器实际引用的
 * binding 子集生成不兼容的布局，导致 setBindGroup 校验失败。
 *
 * 与 scene.wgsl 的 @group 声明一一对应：
 *  group0: binding0 相机/场景 uniform，binding1 体块存储
 *  group1: 粒子存储 + u/v/w 三维纹理 + 网格 uniform
 *  group2: 航线点存储
 *  group3: 切片平面 uniform + 二维纹理 + 采样器
 */
export interface SceneLayouts {
  group0: GPUBindGroupLayout;
  group1: GPUBindGroupLayout;
  group2: GPUBindGroupLayout;
  group3: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;
}

export function createSceneLayouts(device: GPUDevice): SceneLayouts {
  const group0 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });
  const group1 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
      { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
      { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float', viewDimension: '3d' } },
      { binding: 4, visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const group2 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });
  const group3 = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
    ],
  });
  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [group0, group1, group2, group3],
  });
  return { group0, group1, group2, group3, pipelineLayout };
}
