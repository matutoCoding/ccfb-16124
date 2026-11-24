/**
 * WebGPU 设备初始化与能力探测。
 * 不依赖 float32-filterable 可选特性（3D 纹理全部手工三线性采样），
 * 因此只需要基础 adapter 即可运行。
 */
export interface GpuHandle {
  device: GPUDevice;
  adapter: GPUAdapter;
  context: GPUCanvasContext;
  format: GPUTextureFormat;
}

export async function initWebGPU(canvas: HTMLCanvasElement): Promise<GpuHandle> {
  if (!('gpu' in navigator)) {
    throw new Error('当前浏览器不支持 WebGPU，请使用最新版 Chrome/Edge（113+）或开启实验标志。');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('未找到可用的 GPU 适配器（可能被虚拟机/驱动拦截）。');
  const device = await adapter.requestDevice();
  const context = canvas.getContext('webgpu');
  if (!context) throw new Error('无法获取 WebGPU canvas 上下文。');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'premultiplied' });

  device.lost.then((info) => {
    console.error('[WebGPU] device lost:', info.message);
  });
  device.addEventListener('uncapturederror', ((e: Event) => {
    const err = (e as GPUUncapturedErrorEvent).error;
    console.error('[WebGPU] uncaptured error:', err?.message ?? err);
  }) as EventListener);
  return { device, adapter, context, format };
}

/** 简单 FPS 统计：滑动窗口平均，供页面显示与自适应分辨率决策 */
export class FpsMeter {
  private frames: number[] = [];
  private last = performance.now();

  tick(now: number): number {
    const dt = now - this.last;
    this.last = now;
    if (dt > 0 && dt < 1000) this.frames.push(dt);
    if (this.frames.length > 60) this.frames.shift();
    return this.fps();
  }

  fps(): number {
    if (this.frames.length === 0) return 0;
    const avg = this.frames.reduce((a, b) => a + b, 0) / this.frames.length;
    return 1000 / avg;
  }

  /** 最近一帧毫秒 */
  frameMs(): number {
    return this.frames.length ? this.frames[this.frames.length - 1] : 0;
  }
}
