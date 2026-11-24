/**
 * 入口点核对：Naga 已保证语法/类型正确，这里再核对每个业务着色器
 * 声明了引擎实际调用的 @vertex/@fragment/@compute 入口名，
 * 防止重命名后 JS 侧 entryPoint 字符串失配。
 */
import { parseWgsl, validate } from 'naga-wasm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'src', 'webgpu', 'shaders');
const common = readFileSync(path.join(dir, 'common.wgsl'), 'utf8');

const EXPECT = {
  'slice.wgsl': ['vsMain', 'fsMain'],
  'particles.wgsl': ['csMain'],
  'scene.wgsl': [
    'boxVs', 'boxFs', 'isoVs', 'isoFs', 'isoEdgeVs', 'isoEdgeFs',
    'particleVs', 'particleFs', 'routeVs', 'routeFs', 'slicePlaneVs', 'slicePlaneFs',
  ],
};

let fail = 0;
for (const [file, entries] of Object.entries(EXPECT)) {
  const raw = readFileSync(path.join(dir, file), 'utf8');
  const combined = common + raw.replace('#include_common', '');
  validate(parseWgsl(combined)); // Naga 校验，失败即抛
  for (const name of entries) {
    // 入口注解与 fn 之间可能夹着 @workgroup_size 等其他属性
    const re = new RegExp(`@(vertex|fragment|compute)[\\s\\S]*?fn\\s+${name}\\s*\\(`);
    if (!re.test(raw)) {
      console.error(`✗ ${file} 缺少入口点 ${name}`);
      fail++;
    }
  }
  console.log(`✓ ${file} — Naga 校验通过，${entries.length} 个入口点齐全`);
}
process.exit(fail ? 1 : 0);
