// 提示词工作台 · 面板逻辑（vanilla JS，无构建）
// 主流程只有两步：①图出风格（上传→agent 分析→写回面板→可存风格库）②风格生图（选风格+描述→出图）。
// 风格库可查看/管理；生成历史看结果。提示词 JSON 是内部机制，用户只在需要时展开看。
const $ = (sel) => document.querySelector(sel)
// 面板挂在 /image-prompt-studio/ 前缀下：相对 fetch 必须带上 base（否则落到宿主根路径 404）
const API = '/image-prompt-studio'

// ---------------------------------------------------------------- 主题（client.js postMessage 同步）
let schemeSet = false
function applyScheme(scheme) {
  document.body.dataset.scheme = scheme === 'dark' ? 'dark' : 'light'
  schemeSet = true
}
addEventListener('message', (e) => {
  if (e.origin !== location.origin) return
  const m = e.data
  if (!m) return
  if (m.type === 'image-prompt-studio:scheme' && m.scheme) applyScheme(m.scheme)
  // 宿主开新对话的回执：dispatched = 指令已交给宿主（不等于对话已打开），failed = 明确失败。
  // 开对话会把 iframe 卸载，乐观提示会随页面消失，所以状态要落盘。
  if (m.type === 'image-prompt-studio:ask-dispatched') handleAskResult(true)
  if (m.type === 'image-prompt-studio:ask-failed') handleAskResult(false, m.message)
})

// ---------------------------------------------------------------- 状态（必须在下面的函数之前声明）
let wbRefPath = ''        // 第 1 步就绪的参考图路径（上传落盘或手填）
let wbStyle = null        // 当前风格槽（agent 写回）：{ prompt, referenceImage, note, updatedAt }
let wbStyles = []         // 风格库
let wbSelectedId = 'current' // 第 2 步选中的风格：'current' 或风格库 id
let stylePollTimer = null
// 已发起、等宿主回执的指令：等回执期间禁用按钮，避免连点开出多个会话（内存锁，秒级）
let pendingAsk = null
// 落盘回执：{ kind, at }。面板会被卸载，回来后靠它显示「上次已发到对话」；风格写回或 30 分钟后清除
let pendingReceipt = null
const ASK_TIMEOUT_MS = 180000

// 「开新对话」会把主区域切到对话，本页 iframe 随之卸载重载。所以用户已经填的东西要落盘，
// 回来时还原；pending 回执照样恢复，回来后还能看到「上次已发起」。
const DRAFT_KEY = 'image-prompt-studio:draft'
function readDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') } catch { return null }
}
function writeDraft(patch) {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...(readDraft() || {}), ...patch })) } catch { /* 隐私模式忽略 */ }
}
function persistDraft() {
  writeDraft({
    refPath: $('#wb-ref-path').value.trim(),
    desc: $('#wb-desc').value,
    selectedId: wbSelectedId,
    model: $('#wb-model').value,
    aspect: $('#wb-aspect').value,
    pending: pendingReceipt ? { kind: pendingReceipt.kind, at: pendingReceipt.at } : null,
  })
}

// ---------------------------------------------------------------- 页签
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab')
  if (!btn) return
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === btn))
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${btn.dataset.tab}`))
  if (btn.dataset.tab === 'history') loadHistory()
  if (btn.dataset.tab === 'library') loadLibrary()
})
function goto(tab) {
  $(`.tab[data-tab="${tab}"]`)?.click()
}

// ---------------------------------------------------------------- 状态条
// 401/403 = 宿主 token 鉴权失败，不是「apiz 未配置」。必须把真原因顶成横幅，
// 否则用户会拿着「去查 apiz key」的错提示排查一个不相关的方向。
class AuthError extends Error {
  constructor(status) {
    super(`未授权（HTTP ${status}）：登录可能已过期，请刷新页面重试`)
    this.status = status
    this.auth = true
  }
}

function showAuthBanner(message) {
  const el = $('#auth-banner')
  el.hidden = false
  el.textContent = message
}

function hideAuthBanner() {
  const el = $('#auth-banner')
  el.hidden = true
  el.textContent = ''
}

async function fetchJSON(url, options) {
  let res
  try {
    res = await fetch(`${API}${url}`, options)
  } catch (err) {
    throw new Error(`网络不可达：${(err && err.message) || err}`)
  }
  const body = await res.json().catch(() => ({}))
  if (res.status === 401 || res.status === 403) throw new AuthError(res.status)
  if (!res.ok && !body.error) throw new Error(`HTTP ${res.status}`)
  return body
}

/** 统一失败呈现：业务错误原样显示；鉴权错误额外顶一条横幅（同一个原因只用一种说法）。 */
function showFailure(box, err, prefix = '') {
  const text = `${prefix}${String((err && err.message) || err)}`
  if (err && err.auth) showAuthBanner(text)
  if (box) box.innerHTML = `<div class="line err">❌ ${escapeHtml(text)}</div>`
}

let apizReady = false // /api/status 说 apiz 可用，才允许「直接出图」（agent 那条还能走 CLI 兜底）
let apizKnown = false // 状态接口是否回报过（false = 还不知道，不能把「拿不到状态」说成「没配 key」）
async function loadStatus() {
  try {
    const s = await fetchJSON('/api/status')
    if (s.ok === false) { showAuthBanner(s.error || '状态接口异常'); return }
    apizKnown = true
    hideAuthBanner()
    $('#status-version').textContent = `v${s.version ?? '?'}`
    const auth = $('#status-auth')
    apizReady = Boolean(s.auth?.configured)
    if (apizReady) {
      auth.textContent = `apiz 已配置（${s.auth.source}）`
      auth.className = 'chip ok'
    } else {
      auth.textContent = 'apiz 未配置（面板不能直接出图）'
      auth.className = 'chip err'
    }
    const stats = s.stats || {}
    $('#status-stats').textContent = `历史 ${stats.ok ?? 0} 张 / ${stats.credits ?? 0} 积分`
    updateGenerateButtons()
  } catch (err) {
    $('#status-version').textContent = err.auth ? '未授权' : '离线'
    if (err.auth) showAuthBanner(err.message)
    else showAuthBanner(`状态接口不可用：${String((err && err.message) || err)}`)
  }
}

// ---------------------------------------------------------------- 出图工作台（两步）
// 创作归对话里的 agent（读图分析/措辞/修改），面板只做：上传落盘、拼指令开对话、
// 展示 agent 用 ips_style 写回的风格、风格库存取、直连出图与历史。
function askAgent(prompt) {
  parent.postMessage({ type: 'image-prompt-studio:ask', prompt }, location.origin)
}

/** 发起一条指令：锁按钮（防连点）+ 落盘回执（面板会被卸载，回来要靠它显示进行中）。 */
function beginAsk(kind, box, prompt) {
  const at = Date.now()
  pendingReceipt = { kind, at }
  pendingAsk = {
    kind,
    at,
    timer: setTimeout(() => {
      pendingAsk = null
      updateGenerateButtons()
      persistDraft()
      if (box) box.innerHTML = '<div class="line warn">3 分钟没收到宿主回执。先切到对话确认有没有新会话，再决定是否重试（别让同一件事跑两遍）。</div>'
    }, ASK_TIMEOUT_MS),
  }
  updateGenerateButtons()
  persistDraft()
  if (box) box.innerHTML = '<div class="line warn">正在把指令发到对话…</div>'
  askAgent(prompt)
}

function handleAskResult(dispatched, message) {
  const kind = pendingAsk ? pendingAsk.kind : (pendingReceipt ? pendingReceipt.kind : null)
  if (pendingAsk && pendingAsk.timer) clearTimeout(pendingAsk.timer)
  pendingAsk = null
  if (!kind) return
  const box = kind === 'analyze' ? $('#wb-step1-report') : $('#wb-step2-report')
  if (dispatched) {
    // 回执保留在 localStorage：面板马上会被卸载，回来后 restoreDraft 才能显示「进行中」。
    // 只把「已交给宿主」说成「已交给宿主」，不说「已打开对话」（startSession 不返回结果）。
    box.innerHTML = kind === 'analyze'
      ? '<div class="line ok">✅ 指令已发到对话：agent 会读图分析。完成后风格自动出现在第 2 步（点侧栏「提示词工作台」回来即可）。</div>'
      : '<div class="line ok">✅ 指令已发到对话：agent 会精修提示词并出图（约 2-9 分钟）。完成后回本页「生成历史」看成图。</div>'
    persistDraft()
    // 面板切走要几十~几百毫秒，这期间按钮仍锁定，避免连点开出多个会话
    setTimeout(() => updateGenerateButtons(), 1500)
    return
  }
  // 明确失败：撤掉回执、立刻解锁
  pendingReceipt = null
  writeDraft({ pending: null })
  updateGenerateButtons()
  showFailure(box, new Error(`没能把指令发到对话：${message || '未知原因'}。可以手动新建会话，把要求粘进去。`))
}

/** 回到本页时还原草稿与上次的回执（面板被卸载过，否则用户要重填一遍）。 */
function restoreDraft() {
  const d = readDraft()
  if (!d) return
  if (d.refPath) {
    $('#wb-ref-path').value = d.refPath
    wbRefPath = d.refPath
    const isHttp = /^https?:/i.test(d.refPath)
    renderRefPreview(d.refPath, { isLocal: !isHttp })
  }
  if (d.desc) $('#wb-desc').value = d.desc
  if (d.selectedId) wbSelectedId = d.selectedId
  if (d.model) $('#wb-model').value = d.model
  if (d.aspect) $('#wb-aspect').value = d.aspect
  if (d.pending) {
    // 超过 30 分钟的回执不再展示（早就该有结果了，别让用户以为还在跑）
    if (Date.now() - Number(d.pending.at || 0) > 30 * 60 * 1000) {
      writeDraft({ pending: null })
    } else {
      pendingReceipt = { kind: d.pending.kind, at: d.pending.at }
      const box = d.pending.kind === 'analyze' ? $('#wb-step1-report') : $('#wb-step2-report')
      box.innerHTML = d.pending.kind === 'analyze'
        ? '<div class="line warn">上次已把「分析这张图」发到对话：agent 完成后风格会自动出现在第 2 步。</div>'
        : '<div class="line warn">上次已把「生成图片」发到对话：完成后成图会出现在「生成历史」。</div>'
    }
  }
}

function activeStyle() {
  if (wbSelectedId !== 'current') return wbStyles.find((s) => s.id === wbSelectedId) || wbStyle
  return wbStyle
}

function renderRefPreview(src, { isLocal = false } = {}) {
  const box = $('#wb-ref-preview')
  // 本地路径不能直接当 img.src：走 /media（只放行 uploads/ 与登记过的本地参考图）
  const url = src ? (isLocal ? mediaSrc(src) : src) : ''
  if (!url) { box.hidden = true; box.innerHTML = ''; return }
  box.hidden = false
  box.innerHTML = `<img src="${escapeAttr(url)}" alt="参考图预览">`
}

function mediaSrc(path) {
  return path ? `${API}/media?path=${encodeURIComponent(path)}` : ''
}

function renderStyleCard(style) {
  wbStyle = style
  const has = Boolean(style && style.prompt)
  $('#wb-style-empty').hidden = has
  $('#wb-style-card').hidden = !has
  // 没有风格时「保存到风格库」必须是禁用态（否则点了没反应，像坏按钮）
  $('#btn-wb-save').disabled = !has
  renderStyleSelection()
  if (!has) return
  const p = style.prompt || {}
  $('#wb-style-title').textContent = '风格已就绪'
  $('#wb-style-summary').textContent = `风格：${String(p['风格模式'] || '').slice(0, 80)}`
  $('#wb-style-note').textContent = style.note ? `说明：${style.note}` : ''
  $('#wb-style-thumb').src = mediaSrc(style.referenceImage)
  $('#wb-json-pre').textContent = JSON.stringify(style.prompt, null, 2)
}

/** 第 2 步的风格选择器：当前风格 + 风格库条目。 */
function renderStyleSelection() {
  const options = []
  if (wbStyle) options.push({ id: 'current', label: `当前风格（${String(wbStyle.prompt?.['风格模式'] || '').slice(0, 24)}…）` })
  for (const s of wbStyles) options.push({ id: s.id, label: `${s.name}（${String(s.prompt?.['风格模式'] || '').slice(0, 24)}…）` })
  const row = $('#wb-lib-row')
  row.hidden = wbStyles.length === 0
  if (wbSelectedId === 'current' && !wbStyle && wbStyles.length) wbSelectedId = wbStyles[0].id
  if (!options.some((o) => o.id === wbSelectedId)) wbSelectedId = wbStyle ? 'current' : (wbStyles[0]?.id ?? 'current')
  const sel = $('#wb-lib-select')
  sel.innerHTML = ''
  sel.hidden = wbStyles.length === 0
  if (wbStyle) {
    const opt = document.createElement('option')
    opt.value = 'current'
    opt.textContent = options[0].label
    sel.appendChild(opt)
  }
  for (const o of options.filter((x) => x.id !== 'current')) {
    const opt = document.createElement('option')
    opt.value = o.id
    opt.textContent = o.label
    sel.appendChild(opt)
  }
  sel.value = wbSelectedId
  updateGenerateButtons()
}

function updateGenerateButtons() {
  const ready = Boolean(activeStyle())
  const busy = Boolean(pendingAsk)
  // 「② 生成图片」交给 agent：apiz 没配也能让 agent 用 CLI 兜底。
  // 「直接出图」走面板 HTTP 通道：没配 key 必然失败，先禁用并说明原因，别让用户等 2-9 分钟才看到报错。
  $('#btn-wb-generate').disabled = !ready || busy
  $('#btn-wb-direct').disabled = !ready || busy || !apizReady
  const hint = $('#wb-blocked')
  if (apizReady) {
    hint.hidden = true
    hint.textContent = ''
  } else {
    hint.hidden = false
    hint.textContent = apizKnown
      ? '「直接出图」需要 apiz API Key（设置 → 插件 → 提示词工作台 填 apizApiKey）；「② 生成图片」仍可用，agent 会按 skill 走 apiz CLI 兜底。'
      : '暂时读不到 apiz 配置状态（状态接口未就绪）：「直接出图」先禁用，稍后页面自动刷新状态；「② 生成图片」仍可用。'
  }
}

$('#wb-lib-select').addEventListener('change', () => {
  wbSelectedId = $('#wb-lib-select').value
  updateGenerateButtons()
  persistDraft()
})
// 模型/比例也要落盘：面板每步都会被卸载重载，否则回来就被重置回默认值
$('#wb-model').addEventListener('change', persistDraft)
$('#wb-aspect').addEventListener('change', persistDraft)

async function pollStyle() {
  try {
    const r = await fetchJSON('/api/style')
    const style = r.style || null
    if (JSON.stringify(style) !== JSON.stringify(wbStyle)) {
      renderStyleCard(style)
      settlePendingFromStyle()
    }
  } catch (err) {
    if (err.auth) showAuthBanner(err.message) // 轮询抖动不打扰；鉴权失败要说
  }
}

/** agent 写回风格后，把第 1 步的 pending 回执换成「已生成」。 */
function settlePendingFromStyle() {
  const d = readDraft()
  if (!d || !d.pending || d.pending.kind !== 'analyze') return
  if (!wbStyle || !wbStyle.updatedAt) return
  if (Date.parse(wbStyle.updatedAt) < d.pending.at - 2000) return
  writeDraft({ pending: null })
  pendingReceipt = null
  $('#wb-step1-report').innerHTML = '<div class="line ok">✅ 风格已生成并写回面板：第 2 步可以直接选它出图了。</div>'
}

async function loadLibrary() {
  try {
    const r = await fetchJSON('/api/styles')
    wbStyles = Array.isArray(r.styles) ? r.styles : []
    renderLibrary()
    renderStyleSelection()
  } catch (err) {
    if (err.auth) showAuthBanner(err.message)
  }
}

function renderLibrary() {
  const box = $('#library-list')
  const badge = $('#lib-count')
  badge.hidden = wbStyles.length === 0
  badge.textContent = `${wbStyles.length}`
  box.innerHTML = ''
  if (!wbStyles.length) { box.innerHTML = '<div class="muted">风格库还是空的：在工作台第 1 步生成风格后点「保存到风格库」。</div>'; return }
  for (const s of wbStyles) {
    const card = document.createElement('div')
    card.className = 'preset-card style-lib-card'
    card.innerHTML = `
      <img class="lib-thumb" src="${mediaSrc(s.referenceImage)}" alt="${escapeAttr(s.name)}">
      <div class="name">${escapeHtml(s.name)}</div>
      <div class="summary">${escapeHtml(String(s.prompt?.['风格模式'] || '').slice(0, 90))}</div>
      <div class="muted">${escapeHtml(s.note || '')}</div>
      <div class="col-actions">
        <button class="btn" data-use="${escapeAttr(s.id)}">用于生图</button>
        <button class="btn ghost" data-del="${escapeAttr(s.id)}">删除</button>
      </div>`
    card.querySelector('[data-use]').addEventListener('click', () => {
      wbSelectedId = s.id
      renderStyleSelection()
      goto('workbench')
    })
    card.querySelector('[data-del]').addEventListener('click', (e) => {
      // 不用 confirm()：Electron iframe 里可能被拦截，点了会像坏按钮；改成按钮二次确认
      armConfirm(e.currentTarget, '再点一次确认删除', async () => {
        try {
          await fetchJSON('/api/styles/delete', post({ id: s.id }))
          loadLibrary()
        } catch (err) {
          showFailure($('#library-list'), err)
        }
      })
    })
    box.appendChild(card)
  }
}

// 文件选择 → 落盘 uploads/（agent 读这个路径；出图时同路径传回）
$('#wb-file').addEventListener('change', async () => {
  const file = $('#wb-file').files[0]
  if (!file) return
  const report = $('#wb-step1-report')
  report.innerHTML = '<div class="line warn">上传中…</div>'
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error('读文件失败'))
      reader.readAsDataURL(file)
    })
    const r = await fetchJSON('/api/style/upload', post({ dataUrl, name: file.name }))
    if (!r.ok) throw new Error(r.error || '上传失败')
    wbRefPath = r.file
    $('#wb-ref-path').value = wbRefPath
    renderRefPreview(dataUrl)
    persistDraft()
    report.innerHTML = `<div class="line ok">✅ 已就绪：${escapeHtml(r.file)}</div>`
    $('#btn-wb-analyze').disabled = false
  } catch (err) {
    report.innerHTML = `<div class="line err">❌ ${escapeHtml(String(err.message || err))}</div>`
  }
})

let linkTimer = null
$('#wb-ref-path').addEventListener('input', () => {
  wbRefPath = $('#wb-ref-path').value.trim()
  $('#btn-wb-analyze').disabled = !wbRefPath || Boolean(pendingAsk)
  persistDraft()
  if (!wbRefPath) return  // 清空时先不动预览，避免打字过程中反复闪破图
  const isHttp = /^https?:/i.test(wbRefPath)
  if (isHttp) { renderRefPreview(wbRefPath, { isLocal: false }); return }
  // 手填的本地图不在 uploads/ 下：停手 600ms 后登记白名单，成功后预览才由 /media 提供。
  // 不回写输入框（否则光标跳末尾、和继续输入打架），非法/半截路径也不往报告区写（点「① 分析」时统一报）。
  clearTimeout(linkTimer)
  linkTimer = setTimeout(async () => {
    try {
      const r = await fetchJSON('/api/style/link', post({ path: wbRefPath }))
      if (r.ok && r.file) {
        renderRefPreview(r.file, { isLocal: true })
        $('#wb-step1-report').innerHTML = '<div class="line ok">✅ 参考图可用，可以点「① 分析这张图」。</div>'
      }
    } catch { /* 打字过程中的半截路径不打扰用户 */ }
  }, 600)
})

// 第 1 步：开对话让 agent 分析风格并 ips_style 写回
$('#btn-wb-analyze').addEventListener('click', async () => {
  const report = $('#wb-step1-report')
  let ref = wbRefPath || $('#wb-ref-path').value.trim()
  if (!ref) {
    showFailure(report, new Error('先上传一张图片或填参考图路径'))
    $('#wb-ref-path').focus()
    return
  }
  if (!/^https?:/i.test(ref)) {
    // 手填路径先登记（同时确认文件真的是图片），失败就别开对话
    try {
      const linked = await fetchJSON('/api/style/link', post({ path: ref }))
      if (linked.ok && linked.file) {
        ref = linked.file
        wbRefPath = ref
        $('#wb-ref-path').value = ref
        renderRefPreview(ref, { isLocal: true })
      }
    } catch (err) {
      showFailure(report, err)
      return
    }
  }
  const prompt = [
    '请执行 image-prompt-studio skill 的「第 1 步 · 导图定风格」：',
    '',
    '参考图（直接读图分析，不要调外部视觉 API）：',
    `- ${ref}`,
    '',
    '要求：1) 按四维度提取特征（角色特征/场景环境/画面风格/构图与镜头角度），产出完整 26 字段风格提示词 JSON（不要 markdown 围栏）；2) 用 ips_validate 校验；3) 校验通过后**必须调 ips_style（action=set，prompt=风格 JSON，referenceImage=上面的参考图路径，note=一句话画风概括）写回面板**——用户在「出图工作台」第 2 步等着选这个风格；4) 完成后告诉用户可以回面板第 2 步出图（想留着常用就点「保存到风格库」）。',
  ].join('\n')
  beginAsk('analyze', report, prompt)
})

// 第 1 步收尾：把当前风格存入风格库
$('#btn-wb-save').addEventListener('click', async () => {
  const report = $('#wb-step1-report')
  if (!wbStyle) { showFailure(report, new Error('还没有可保存的风格：先完成第 1 步')); return }
  const name = $('#wb-save-name').value.trim() || `风格 ${new Date().toLocaleDateString('zh-CN')}`
  try {
    const r = await fetchJSON('/api/styles', post({ name, prompt: wbStyle.prompt, referenceImage: wbStyle.referenceImage, note: wbStyle.note }))
    if (!r.ok) throw new Error(r.error || '保存失败')
    $('#wb-save-name').value = ''
    report.innerHTML = `<div class="line ok">✅ 已存入风格库：「${escapeHtml(r.style.name)}」（在「风格库」页可管理，第 2 步可选用）</div>`
    loadLibrary()
  } catch (err) {
    showFailure(report, err)
  }
})

// 第 2 步·推荐：agent 精修（把描述融进主体，风格冻结）→ 带参考图出图
$('#btn-wb-generate').addEventListener('click', () => {
  const report = $('#wb-step2-report')
  const style = activeStyle()
  const desc = $('#wb-desc').value.trim()
  if (!style) { showFailure(report, new Error('先完成第 1 步，或从风格库选一套风格')); return }
  if (!desc) {
    showFailure(report, new Error('先写描述要求：想画什么？'))
    $('#wb-desc').focus()
    return
  }
  const model = $('#wb-model').value
  const aspect = $('#wb-aspect').value
  const prompt = [
    '请执行 image-prompt-studio skill 的「第 2 步 · 风格生图」：',
    '',
    '选用风格（出图时必须把它的参考图作为风格参考传回）：',
    `- 参考图：${style.referenceImage || '（无，纯文生图）'}`,
    '- 风格 JSON：',
    '```json',
    JSON.stringify(style.prompt, null, 2),
    '```',
    '',
    `用户描述要求：${desc}`,
    '',
    `要求：1) 按路径 B 最小化修改——把描述融进「场景.主体」等画面内容字段（人物/主体/动作/场景元素），风格模式、画面气质、审美控制、相机等风格字段逐字冻结；2) 用 ips_validate 校验 + ips_diff 冻结自检（改动只落在描述覆盖的节点）；3) 用 ips_generate 出图：referenceImages=[上面的参考图路径]，model="${model}"，aspectRatio="${aspect}"——模型与比例就用这两个值，不要换成默认；4) 完成后把成图路径告诉用户（面板「生成历史」会同步出现）。`,
  ].join('\n')
  beginAsk('generate', report, prompt)
})

// 第 2 步·快速：不改提示词，描述作为附加要求直连出图
$('#btn-wb-direct').addEventListener('click', async () => {
  const style = activeStyle()
  const desc = $('#wb-desc').value.trim()
  const report = $('#wb-step2-report')
  if (!style) { showFailure(report, new Error('先完成第 1 步，或从风格库选一套风格')); return }
  if (!desc) {
    showFailure(report, new Error('先写描述要求：想画什么？'))
    $('#wb-desc').focus()
    return
  }
  try {
    $('#btn-wb-direct').disabled = true
    report.innerHTML = '<div class="line warn">已提交，任务运行中（单张约 2-9 分钟，超时不重提交）…</div>'
    const r = await fetchJSON('/api/generate', post({
      prompt: style.prompt,
      extraRequirements: `画面内容：${desc}。除画面内容外，风格、色彩与质感严格以 JSON 描述为准。`,
      model: $('#wb-model').value,
      aspectRatio: $('#wb-aspect').value,
      referenceImages: style.referenceImage ? [style.referenceImage] : [],
    }))
    if (!r.ok) throw new Error(r.error || '提交失败')
    pollJob(r.job, report, () => { updateGenerateButtons(); loadHistory(); loadStatus() })
  } catch (err) {
    showFailure(report, err)
    updateGenerateButtons()
  }
})

function pollJob(jobId, box, onDone = null) {
  const startedAt = Date.now()
  const MAX_MS = 30 * 60 * 1000 // 只停轮询，不重提交（重跑=重复扣费）
  let misses = 0
  const timer = setInterval(async () => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    if (Date.now() - startedAt > MAX_MS) {
      clearInterval(timer)
      if (onDone) onDone()
      box.innerHTML = '<div class="line warn">已等满 30 分钟仍未返回。任务可能还在服务端跑：别重复提交（会重复扣费），到「生成历史」看结果，或让 agent 用 apiz CLI 查这个任务。</div>'
      return
    }
    try {
      const r = await fetchJSON(`/api/job?id=${encodeURIComponent(jobId)}`)
      // 宿主重启后任务表被清空：后端返回 404 + {ok:false,error}，fetchJSON 不抛（有 error 字段），
      // 所以这里必须显式判定，否则「查不到任务」会被当成「生成失败」。
      if (r.ok === false || !r.job) {
        misses += 1
        if (misses < 3) {
          box.innerHTML = `<div class="line warn">暂时查不到任务 ${escapeHtml(jobId)}，正在重试（${misses}/3）…</div>`
          return
        }
        clearInterval(timer)
        if (onDone) onDone()
        box.innerHTML = `<div class="line err">❌ 查不到任务 ${escapeHtml(jobId)}（${escapeHtml(r.error || '任务表已清空')}）</div>` +
          '<div class="line warn">宿主重启会清空任务表：先到「生成历史」看有没有成图；确认真没结果再重新出图，别重复提交（重复扣费）。</div>'
        return
      }
      const job = r.job
      misses = 0
      if (job.status === 'running') {
        box.innerHTML = `<div class="line warn">生成中…已 ${elapsed}s（单张 2-9 分钟，超时不重提交）｜任务 ${escapeHtml(jobId)}</div>`
        return
      }
      clearInterval(timer)
      if (onDone) onDone()
      if (job.status === 'done') {
        const rec = job.record || {}
        const price = typeof rec.price === 'number' ? `，消耗 ${rec.price} 积分` : ''
        const refs = rec.referenceCount ? `，参考图 ${rec.referenceCount} 张已传回` : ''
        box.innerHTML = `<div class="line ok">✅ 出图完成（${Math.round((rec.durationMs || 0) / 1000)}s${price}${refs}）｜任务 ${escapeHtml(jobId)}</div>` +
          (rec.warnings?.length ? `<div class="line warn">${escapeHtml(rec.warnings.join('；'))}</div>` : '') +
          (rec.files || []).map((f) => `<div class="line ok">${escapeHtml(f)}</div>`).join('')
        loadStatus()
        loadHistory()
      } else {
        box.innerHTML = `<div class="line err">❌ ${escapeHtml(job.error || '生成失败')}｜任务 ${escapeHtml(jobId)}</div>` +
          (job.record?.id ? '<div class="line warn">这次失败已记入「生成历史」（失败记录可回看原因）。</div>' : '')
      }
    } catch (err) {
      if (err.auth) {
        clearInterval(timer)
        if (onDone) onDone()
        showFailure(box, err)
        return
      }
      misses += 1
      if (misses >= 3) {
        clearInterval(timer)
        if (onDone) onDone()
        box.innerHTML = `<div class="line err">❌ 查不到任务状态（${escapeHtml(String((err && err.message) || err))}）</div>` +
          '<div class="line warn">宿主重启会清空任务表：到「生成历史」看结果，别重复提交。</div>'
      }
    }
  }, 3000)
}

// ---------------------------------------------------------------- 生成历史
async function loadHistory() {
  const box = $('#history-list')
  try {
    const r = await fetchJSON('/api/history?limit=60')
    if (r.ok === false) throw new Error(r.error || '历史接口异常')
    const list = Array.isArray(r.list) ? r.list : []
    const stats = r.stats || {}
    $('#history-stats').textContent = `共 ${r.total ?? list.length} 条 · 成功 ${stats.ok ?? 0} · 失败 ${stats.failed ?? 0} · 累计 ${stats.credits ?? 0} 积分`
    box.innerHTML = ''
    if (!list.length) { box.innerHTML = '<div class="muted">还没有出图记录</div>'; return }
    for (const rec of list) {
      const item = document.createElement('div')
      item.className = 'history-item'
      const failed = rec.ok === false
      const first = rec.files?.[0]
      const img = failed
        ? '<div class="muted">失败</div>'
        : first ? `<img src="${mediaSrc(first)}" alt="成图">` : '<div class="muted">无成图</div>'
      const when = (rec.createdAt || '').replace('T', ' ').slice(0, 19)
      const price = typeof rec.price === 'number' ? `${rec.price} 积分` : '—'
      item.innerHTML = `
        ${img}
        <div class="meta">
          <b>${escapeHtml(rec.model || rec.taskId || '')}</b><br>
          ${when} · ${price} · ${Math.round((rec.durationMs || 0) / 1000)}s<br>
          比例 ${escapeHtml(rec.aspectRatio || '—')}${rec.quality ? ` · ${escapeHtml(rec.quality)}` : ''}${rec.sizeTier ? ` · ${escapeHtml(rec.sizeTier)}` : ''} · 参考图 ${rec.referenceCount ?? 0} 张<br>
          prompt ${rec.promptChars ?? 0} 字符
          ${failed ? `<div class="line err">❌ ${escapeHtml(rec.error || '生成失败')}</div>` : ''}
          ${rec.warnings?.length ? `<div class="line warn">${escapeHtml(rec.warnings.join('；'))}</div>` : ''}
        </div>
        <div class="meta">
          ${(rec.files || []).map((f) => `<div class="path">${escapeHtml(f)}</div>`).join('')}
          <button class="btn ghost" data-del="${escapeAttr(rec.id)}">删除</button>
        </div>`
      item.querySelector('[data-del]').addEventListener('click', (e) => {
        armConfirm(e.currentTarget, '再点一次确认删除', async () => {
          try {
            await fetchJSON('/api/history/remove', post({ id: rec.id }))
            loadHistory()
            loadStatus()
          } catch (err) {
            showFailure(box, err)
          }
        })
      })
      box.appendChild(item)
    }
  } catch (err) {
    showFailure(box, err)
  }
}

$('#btn-history-clear').addEventListener('click', (e) => {
  armConfirm(e.currentTarget, '再点一次确认清空', async () => {
    try {
      await fetchJSON('/api/history/clear', post({}))
      loadHistory()
      loadStatus()
    } catch (err) {
      showFailure($('#history-list'), err)
    }
  })
})

// ---------------------------------------------------------------- 工具函数
function post(body) {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function escapeAttr(text) {
  return escapeHtml(text).replace(/`/g, '&#96;')
}
/** 危险操作的二次确认：不用 confirm()（Electron iframe 里可能被拦，点了会像坏按钮）。 */
function armConfirm(btn, label, run) {
  if (btn.dataset.armed === '1') {
    delete btn.dataset.armed
    btn.textContent = btn.dataset.label || btn.textContent
    Promise.resolve().then(run)
    return
  }
  btn.dataset.armed = '1'
  btn.dataset.label = btn.textContent
  btn.textContent = label
  setTimeout(() => {
    if (btn.dataset.armed === '1') {
      delete btn.dataset.armed
      btn.textContent = btn.dataset.label
    }
  }, 5000)
}

// ---------------------------------------------------------------- 启动
// 不先按系统偏好画一帧：宿主 postMessage 到了再上色，300ms 没来才用系统偏好兜底（避免暗色闪白）。
setTimeout(() => { if (!schemeSet) applyScheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') }, 300)
loadStatus()
loadLibrary()
restoreDraft()
pollStyle()
// 风格常驻轮询：agent 在对话里调 ips_style 写回后，第 2 步卡片自动亮起（不依赖用户刷新）
if (!stylePollTimer) { stylePollTimer = setInterval(() => { pollStyle() }, 2500) }
// 刷新后恢复第 1 步状态（路径已填则按钮可用）
wbRefPath = $('#wb-ref-path').value.trim()
$('#btn-wb-analyze').disabled = !wbRefPath || Boolean(pendingAsk)
$('#wb-desc').addEventListener('input', persistDraft)
