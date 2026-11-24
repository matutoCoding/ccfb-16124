/**
 * WGSL 离线校验：用 wgpu 官方 Naga（WASM）验证所有着色器的
 * 解析与类型/绑定规则，模拟运行时 common.wgsl + 业务着色器的拼接。
 * 虚拟机内 Chrome 被策略禁用 WebGPU，此脚本是 GPU 管线的主要静态保障。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseWgsl, validate, NagaError } from 'naga-wasm';

const here = path.dirname(fileURLToPath(import.meta.url));
const shaderDir = path.join(here, '..', 'src', 'webgpu', 'shaders');

const common = readFileSync(path.join(shaderDir, 'common.wgsl'), 'utf8');
const targets = ['slice.wgsl', 'particles.wgsl', 'scene.wgsl'];

let failures = 0;
for (const name of targets) {
  const src = readFileSync(path.join(shaderDir, name), 'utf8').replace('#include_common', '');
  const combined = `${common}\n${src}`;
  try {
    const mod = parseWgsl(combined);
    const info = validate(mod);
    const entries = Object.entries(info).length;
    console.log(`✓ ${name} — Naga 解析+校验通过（${combined.length} 字符，${entries} 个反射条目）`);
  } catch (e) {
    failures++;
    if (e instanceof NagaError) {
      console.error(`✗ ${name} [${e.kind}]\n${e.formatted}\n`);
    } else {
      console.error(`✗ ${name}:`, e.message);
    }
  }
}

// 单独校验 common 自身
try {
  validate(parseWgsl(common));
  console.log('✓ common.wgsl — 独立校验通过');
} catch (e) {
  failures++;
  console.error('✗ common.wgsl:', e.formatted ?? e.message);
}

// 防御：确认目录里没有遗漏的 wgsl
const all = readdirSync(shaderDir).filter((f) => f.endsWith('.wgsl'));
const extra = all.filter((f) => !['common.wgsl', ...targets].includes(f));
if (extra.length) {
  console.error('未覆盖的着色器文件:', extra);
  failures++;
}

process.exit(failures ? 1 : 0);
