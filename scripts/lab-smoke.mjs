// 面板静态冒烟（不启浏览器）：抓「改完代码就坏」的那类机械事故——
//   ① app.js 里 $('#xxx') 引用的 id 必须在 index.html 里存在（否则运行时 null 崩溃）
//   ② 不许再用 alert()/confirm()（Electron iframe 里可能被拦，点了像坏按钮）
//   ③ hidden 属性的样式覆盖必须还在（否则首屏会露出假的「风格已就绪」卡）
//   ④ 主题首帧兜底：body:not([data-scheme]) 的动画兜底不能丢
// 运行：node scripts/lab-smoke.mjs
import { readFileSync } from 'node:fs'

const read = (rel) => readFileSync(new URL(`../lab/${rel}`, import.meta.url), 'utf8')
const html = read('index.html')
const js = read('app.js')
const css = read('app.css')

const failures = []
const check = (ok, message) => { if (!ok) failures.push(message) }

// ① 选择器 ↔ DOM id
const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
const used = new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))
for (const id of used) check(declared.has(id), `app.js 用了 #${id}，但 index.html 里没有这个 id`)

// ② 原生弹窗（先剥注释：注释里提到 alert()/confirm() 不算违规）
const jsCode = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
check(!/\balert\s*\(/.test(jsCode), 'app.js 里还有 alert()：改成面板内联提示')
check(!/\bconfirm\s*\(/.test(jsCode), 'app.js 里还有 confirm()：改用 armConfirm 二次确认')

// ③ hidden 覆盖
check(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css), 'app.css 缺少 [hidden] { display: none !important }：首屏会露出假的风格卡')

// ④ 主题兜底
check(/body:not\(\[data-scheme\]\)/.test(css) && /@keyframes scheme-reveal/.test(css), 'app.css 缺少主题首帧兜底（脚本没跑起来会留下空白页）')

// ⑤ 关键流程函数的收发口仍在
for (const needle of ['beginAsk', 'handleAskResult', 'pollJob', 'armConfirm', 'restoreDraft']) {
  check(js.includes(`function ${needle}`), `app.js 缺少 ${needle}()`)
}
// ⑤b 状态变量必须先声明（否则函数一旦被提前调用就撞 TDZ）
for (const name of ['wbRefPath', 'wbStyle', 'wbSelectedId', 'pendingAsk', 'ASK_TIMEOUT_MS']) {
  const at = js.search(new RegExp(`^(let|const) ${name}\\b`, 'm'))
  check(at >= 0, `app.js 缺少状态声明 ${name}`)
  check(js.indexOf('function beginAsk') > at, `状态 ${name} 声明在 beginAsk 之后：可能撞 TDZ`)
}
// ⑥ 面板必须处理宿主的两条回执（client.js 实际发出的类型 ↔ app.js 是否认识）
const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const apiSource = readFileSync(new URL('../lib/api.js', import.meta.url), 'utf8')
const sentTypes = new Set([...client.matchAll(/post\(frame,\s*\{\s*type:\s*'([^']+)'/g)].map((m) => m[1]))
for (const type of sentTypes) {
  check(js.includes(type), `client.js 发了 ${type}，但 app.js 没有处理`)
}
for (const type of ['ask-dispatched', 'ask-failed']) {
  check(sentTypes.has(`image-prompt-studio:${type}`), `client.js 没有发 ${type} 回执`)
}

// ⑦ 前端调用的接口必须在 lib/api.js 里有对应路由（这条挡的是「把路由改名/字段漂移」这类静默坏按钮）
const calledPaths = new Set(
  [...js.matchAll(/fetchJSON\(\s*(?:`|')([^`']+)/g)]
    .map((m) => m[1].split('?')[0].trim())
    .filter((p) => p.startsWith('/')),
)
const apiRoutes = new Set([...apiSource.matchAll(/rest === '([^']+)'/g)].map((m) => m[1]))
// 正则失效会让上面两条检查空转：先断言真的抓到了东西
check(calledPaths.size >= 8, `只从 app.js 抓到 ${calledPaths.size} 个接口调用：正则可能失效了`)
check(apiRoutes.size >= 8, `只从 lib/api.js 抓到 ${apiRoutes.size} 条路由：正则可能失效了`)
check(sentTypes.size >= 3, `只从 client.js 抓到 ${sentTypes.size} 种消息类型：正则可能失效了`)
for (const path of calledPaths) {
  check(apiRoutes.has(path), `app.js 调了 ${path}，但 lib/api.js 没有对应路由`)
}

// ⑧ 主题不许再硬编码在 HTML 上（否则暗色首帧闪白回来）
check(!/data-scheme=/.test(html), 'index.html 又把 data-scheme 写死了：会暗色闪白')

if (failures.length) {
  console.error(`✗ 面板静态冒烟失败 ${failures.length} 项：`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log(`✓ 面板静态冒烟通过：${used.size} 个选择器全部有对应元素；${calledPaths.size} 个接口调用都能在 api.js 找到路由；${sentTypes.size} 种宿主消息都有处理；无 alert/confirm；hidden 与主题兜底在位`)
