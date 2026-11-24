# 直升机甲板气流与排烟评估系统（CAP437）

海上油气平台直升机甲板的气流与排气评估 Web 应用。TypeScript + WebGPU + IndexedDB，
覆盖平台建模、CFD 规则网格导入/合成、LIC 流向可视化、限制扇区扫描、评审报告导出全流程，
数据全部本地处理，不上传外部服务器。

## 快速开始

```bash
npm install
npm run dev          # http://127.0.0.1:5173
npm test             # 73 项单元测试（领域逻辑 + 验收指标）
npm run validate:wgsl  # Naga 离线校验全部 WGSL 着色器
npm run build        # 类型检查 + WGSL 校验 + 生产构建
```

浏览器要求 Chrome/Edge 113+（WebGPU）。虚拟机/远程桌面若禁用 GPU，
应用会在可视化页显示明确降级提示，其余页面（建模、风场、扇区、报告）不受影响。

## 五个页面

| 页面 | 功能 |
|---|---|
| 平台项目 | 模块堆叠（生活楼/火炬臂/透平排气/吊机/甲板/体块），甲板标高、气隙、进近方位可改，JSON 体块导入，透平开关与工况编辑 |
| 风场数据 | 8 风向合成场（尾流+回流+上洗+浮力羽流）、CFD JSON/CSV 导入、缺测/坏数据质量报告（含 ijk 索引）、模板下载 |
| 气流可视化 | 任意切片 LIC 流向纹理（速度/垂直分量着色）、动态 GPU 粒子、排气等温面（2K 描边）、航线超限段、风向平滑过渡、30ft 层吸附 |
| 限制扇区 | 8 风向插值扫描 36 个 10° 扇区，风玫瑰 + 逐扇区极值/触发原因/全明细表 |
| 评审报告 | 自包含 HTML 报告（风玫瑰 SVG + 逐风向结论 + 全量超限点清单）+ JSON 数据导出 |

## 三条验收指标如何保证

### 1. LIC 流向偏差 < 3°
- LIC 积分在 `src/domain/lic.ts` 有纯 TS 参考实现：**弧长参数化 RK4**（速度归一化，步长=弧长米数，
  高速区不会一步跨出网格）+ 盒式核白噪声卷积。
- WGSL 端 `src/webgpu/shaders/common.wgsl` 的 `rk4()`/`licValue()`/`hashNoise()` 与 TS **逐式同构**，
  共用同一位运算格点哈希。
- `tests/direction-accuracy.test.ts` 在均匀场、含回流变化场上量化弦方向与场方向夹角：
  实测变化场 max=0.97°、mean=0.14°，步长减半误差 0.97°→0.39°（二阶收敛）。

### 2. 切片拖动稳定 60fps
- LIC 离屏渲染按 `renderScale`（0.5/0.75/1.0）降采样，`SliceRenderer.adaptScale()`
  按实测帧时间自动升降档（连续 30 帧 >22ms 降，120 帧 <12ms 升）。
- 风向/温度变化只重传纹理（`updateField`），不重建管线；页面 HUD 实时显示 FPS 与倍率。

### 3. 超限判定与原始网格逐点一致
- `src/domain/rules.ts#assessDeckLevel` 直接遍历参考层原始格点，不经过插值场，
  每个超限点保留 `(i,j,k)` 与世界坐标、实测值。
- `tests/rules.test.ts` 含独立参考实现的逐点集合比对、阈值边界（严格 `>`）、
  缺测剔除、圆盘外不计等用例。

## 架构

```
src/
  domain/        纯 TS 领域逻辑（无 DOM/GPU 依赖，全部可单测）
    grid.ts        规则网格索引、三线性采样（NaN 角点权重归一化）
    lic.ts         RK4 + LIC 参考实现、方向偏差度量
    synthetic.ts   合成风场（尾流/回流/羽流，确定性 LCG）
    rules.ts       CAP437 逐点规则引擎
    sectors.ts     8→36 风向圆周插值与扇区扫描
    isosurface.ts  Marching Tetrahedra 等值面
    importer.ts    CFD JSON/CSV 导入
  webgpu/        WebGPU 引擎
    shaders/       WGSL（common/slice/particles/scene）
    layouts.ts     显式共享 bind group 布局
    sliceRenderer / particleSystem / sceneRenderer / visualizationEngine
  db/idb.ts      IndexedDB（项目/数据集元数据 + 分量二进制分仓）
  pages/         五个 React 页面
  report/        HTML/SVG 报告生成
scripts/
  validate-wgsl.mjs   Naga(WASM) WGSL 解析+校验
  check-reflection.mjs 入口点完整性核对
  e2e-smoke.mjs       puppeteer 端到端冒烟
```

### 关键工程决策
- **不依赖 `float32-filterable` 可选特性**：3D 纹理全部 `textureLoad` + 手工三线性，任何基础适配器可运行。
- **显式管线布局**：场景多管线共用 4 组 bind group，避免 auto layout 生成不兼容 BGL。
- **不依赖 point-list 可选特性**：粒子用实例化广告牌三角形。
- **WGSL 兼容性**：用 `v != v` 判 NaN、FLT_MAX 哨兵代替部分版本缺失的 `isNan()`/`nan()`。

## 风向约定
风向为气象方位角（风吹来的方向，0=北，90=东，顺时针）。
坐标系 x 东、y 北、z 上，单位米；温度用绝对 K，温升 = 当地温度 − 环境温度。
