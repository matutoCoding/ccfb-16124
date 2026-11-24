/**
 * 端到端冒烟验证（手动运行：node --import tsx scripts/e2e-smoke.mjs 不适用，
 * 直接用 node 跑 puppeteer-core）。
 * 覆盖：应用启动 -> 新建项目 -> 生成 8 风向合成风场 -> WebGPU 引擎初始化
 *       -> 五页面切换 -> 捕获控制台错误与 WebGPU uncaptured error。
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://127.0.0.1:5199/';
const SHOT_DIR = 'e2e-shots';

const fs = await import('node:fs');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const flagSets = [
  ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-features=Vulkan'],
  ['--enable-unsafe-webgpu', '--use-angle=swiftshader'],
  ['--enable-unsafe-webgpu'],
];

let browser;
for (const flags of flagSets) {
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: 'new',
      args: ['--no-sandbox', '--window-size=1500,950', ...flags],
    });
    break;
  } catch (e) {
    console.log('flag set failed:', flags.join(' '), e.message);
  }
}
if (!browser) { console.error('Chrome 启动失败'); process.exit(1); }

const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[console.error] ${msg.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clickNav = async (label) => {
  const links = await page.$$('.nav-item');
  for (const l of links) {
    if ((await l.evaluate((el) => el.textContent))?.includes(label)) { await l.click(); return; }
  }
};

// 1. 启动
await page.goto(URL, { waitUntil: 'networkidle0' });
await sleep(500);
const hasGpu = await page.evaluate(() => 'gpu' in navigator);
console.log('WebGPU API available:', hasGpu);
await page.screenshot({ path: `${SHOT_DIR}/01-projects-empty.png` });

// 2. 新建项目
await page.click('button'); // 新建项目
await sleep(600);
await page.screenshot({ path: `${SHOT_DIR}/02-project-created.png` });

// 3. 风场数据页 -> 生成合成风场
await clickNav('风场数据');
await sleep(400);
const buttons = await page.$$('button');
for (const b of buttons) {
  const txt = await b.evaluate((el) => el.textContent);
  if (txt?.includes('生成 8 风向')) { await b.click(); break; }
}
// 风场生成 + IDB 写入
await page.waitForFunction(() => document.querySelectorAll('table tbody tr').length > 0, { timeout: 15000 });
await sleep(1500);
await page.screenshot({ path: `${SHOT_DIR}/03-wind-data.png` });

// 4. 可视化页（WebGPU）
await clickNav('气流可视化');
await sleep(4000); // 引擎初始化 + 首帧
const hud = await page.evaluate(() => {
  const el = document.querySelector('.hud');
  return el ? el.textContent : null;
});
console.log('HUD:', hud);
const vizError = await page.evaluate(() => {
  const el = document.querySelector('.bad');
  return el ? el.textContent : null;
});
console.log('Viz error banner:', vizError);
await page.screenshot({ path: `${SHOT_DIR}/04-visualization.png` });

// 拖动风向滑块
await page.evaluate(() => {
  const slider = document.querySelectorAll('input[type=range]')[0];
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(slider, '120');
  slider.dispatchEvent(new Event('input', { bubbles: true }));
});
await sleep(1200);
await page.screenshot({ path: `${SHOT_DIR}/05-viz-bearing120.png` });

// 5. 限制扇区
await clickNav('限制扇区');
await sleep(1500);
await page.screenshot({ path: `${SHOT_DIR}/06-sectors.png` });
const rosePaths = await page.$$eval('svg path', (ps) => ps.length);
console.log('wind rose wedges:', rosePaths);

// 6. 评审报告
await clickNav('评审报告');
await sleep(800);
await page.screenshot({ path: `${SHOT_DIR}/07-report.png` });

await sleep(500);
console.log('\n==== 捕获到的错误（前 30 条）====');
console.log(errors.length ? errors.slice(0, 30).join('\n') : '无错误');
const gpuErrors = errors.filter((e) => e.includes('WebGPU') || e.includes('GPU'));
console.log(`\nWebGPU 相关错误数: ${gpuErrors.length}`);

await browser.close();
fs.writeFileSync(`${SHOT_DIR}/errors.log`, errors.join('\n'));
process.exit(gpuErrors.length > 0 ? 2 : 0);
