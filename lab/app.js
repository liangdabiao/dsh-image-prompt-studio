// 提示词工作台 · 面板逻辑（vanilla JS，无构建）
// 主流程只有两步：①图出风格（上传→agent 分析→写回面板→可存风格库）②风格生图（选风格+描述→出图）。
// 风格库可查看/管理；生成历史看结果。提示词 JSON 是内部机制，用户只在需要时展开看。
const $ = (sel) => document.querySelector(sel)
// 面板挂在 /image-prompt-studio/ 前缀下：相对 fetch 必须带上 base（否则落到宿主根路径 404）
const API = '/image-prompt-studio'

// ---------------------------------------------------------------- 主题（client.js postMessage 同步）
function applyScheme(scheme) {
  document.body.dataset.scheme = scheme === 'dark' ? 'dark' : 'light'
}
addEventListener('message', (e) => {
  if (e.origin !== location.origin) return
  const m = e.data
  if (m && m.type === 'image-prompt-studio:scheme' && m.scheme) applyScheme(m.scheme)
})

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
async function fetchJSON(url, options) {
  const res = await fetch(`${API}${url}`, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok && !body.error) throw new Error(`HTTP ${res.status}`)
  return body
}

async function loadStatus() {
  try {
    const s = await fetchJSON('/api/status')
    $('#status-version').textContent = `v${s.version ?? '?'}`
    const auth = $('#status-auth')
    if (s.auth?.configured) {
      auth.textContent = `apiz 已配置（${s.auth.source}）`
      auth.className = 'chip ok'
    } else {
      auth.textContent = 'apiz 未配置（CLI 兜底）'
      auth.className = 'chip err'
    }
    $('#status-stats').textContent = `历史 ${s.stats?.ok ?? 0} 张 / ${s.stats?.credits ?? 0} 积分`
  } catch {
    $('#status-version').textContent = '离线'
  }
}

// ---------------------------------------------------------------- 出图工作台（两步）
// 创作归对话里的 agent（读图分析/措辞/修改），面板只做：上传落盘、拼指令开对话、
// 展示 agent 用 ips_style 写回的风格、风格库存取、直连出图与历史。
function askAgent(prompt) {
  parent.postMessage({ type: 'image-prompt-studio:ask', prompt }, location.origin)
}

let wbRefPath = ''        // 第 1 步就绪的参考图路径（上传落盘或手填）
let wbStyle = null        // 当前风格槽（agent 写回）：{ prompt, referenceImage, note, updatedAt }
let wbStyles = []         // 风格库
let wbSelectedId = 'current' // 第 2 步选中的风格：'current' 或风格库 id
let stylePollTimer = null

function activeStyle() {
  if (wbSelectedId !== 'current') return wbStyles.find((s) => s.id === wbSelectedId) || wbStyle
  return wbStyle
}

function renderRefPreview(src) {
  const box = $('#wb-ref-preview')
  if (!src) { box.hidden = true; box.innerHTML = ''; return }
  box.hidden = false
  box.innerHTML = `<img src="${src}" alt="参考图预览">`
}

function mediaSrc(path) {
  return path ? `${API}/media?path=${encodeURIComponent(path)}` : ''
}

function renderStyleCard(style) {
  wbStyle = style
  const has = Boolean(style && style.prompt)
  $('#wb-style-empty').hidden = has
  $('#wb-style-card').hidden = !has
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
  $('#btn-wb-generate').disabled = !ready
  $('#btn-wb-direct').disabled = !ready
}

$('#wb-lib-select').addEventListener('change', () => {
  wbSelectedId = $('#wb-lib-select').value
  updateGenerateButtons()
})

async function pollStyle() {
  try {
    const r = await fetchJSON('/api/style')
    const style = r.style || null
    if (JSON.stringify(style) !== JSON.stringify(wbStyle)) renderStyleCard(style)
  } catch { /* 轮询抖动 */ }
}

async function loadLibrary() {
  try {
    const r = await fetchJSON('/api/styles')
    wbStyles = r.styles || []
    renderLibrary()
    renderStyleSelection()
  } catch { /* 状态条已有离线提示 */ }
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
    card.querySelector('[data-del]').addEventListener('click', async () => {
      if (!confirm(`删除风格「${s.name}」？`)) return
      await fetchJSON('/api/styles/delete', post({ id: s.id }))
      loadLibrary()
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
    report.innerHTML = `<div class="line ok">✅ 已就绪：${escapeHtml(r.file)}</div>`
    $('#btn-wb-analyze').disabled = false
  } catch (err) {
    report.innerHTML = `<div class="line err">❌ ${escapeHtml(String(err.message || err))}</div>`
  }
})

$('#wb-ref-path').addEventListener('input', () => {
  wbRefPath = $('#wb-ref-path').value.trim()
  $('#btn-wb-analyze').disabled = !wbRefPath
  renderRefPreview(wbRefPath && /^https?:/i.test(wbRefPath) ? wbRefPath : '')
})

// 第 1 步：开对话让 agent 分析风格并 ips_style 写回
$('#btn-wb-analyze').addEventListener('click', () => {
  const ref = wbRefPath || $('#wb-ref-path').value.trim()
  if (!ref) { alert('先上传一张图片或填参考图路径'); return }
  const prompt = [
    '请执行 image-prompt-studio skill 的「第 1 步 · 导图定风格」：',
    '',
    '参考图（直接读图分析，不要调外部视觉 API）：',
    `- ${ref}`,
    '',
    '要求：1) 按四维度提取特征（角色特征/场景环境/画面风格/构图与镜头角度），产出完整 26 字段风格提示词 JSON（不要 markdown 围栏）；2) 用 ips_validate 校验；3) 校验通过后**必须调 ips_style（action=set，prompt=风格 JSON，referenceImage=上面的参考图路径，note=一句话画风概括）写回面板**——用户在「出图工作台」第 2 步等着选这个风格；4) 完成后告诉用户可以回面板第 2 步出图（想留着常用就点「保存到风格库」）。',
  ].join('\n')
  $('#wb-step1-report').innerHTML = '<div class="line ok">已发起：agent 正在对话里分析这张图，完成后风格会自动出现在第 2 步（可留在本页等待）。</div>'
  askAgent(prompt)
})

// 第 1 步收尾：把当前风格存入风格库
$('#btn-wb-save').addEventListener('click', async () => {
  if (!wbStyle) return
  const name = $('#wb-save-name').value.trim() || `风格 ${new Date().toLocaleDateString('zh-CN')}`
  try {
    const r = await fetchJSON('/api/styles', post({ name, prompt: wbStyle.prompt, referenceImage: wbStyle.referenceImage, note: wbStyle.note }))
    if (!r.ok) throw new Error(r.error || '保存失败')
    $('#wb-save-name').value = ''
    $('#wb-step1-report').innerHTML = `<div class="line ok">✅ 已存入风格库：「${escapeHtml(r.style.name)}」（在「风格库」页可管理，第 2 步可选用）</div>`
    loadLibrary()
  } catch (err) {
    $('#wb-step1-report').innerHTML = `<div class="line err">❌ ${escapeHtml(String(err.message || err))}</div>`
  }
})

// 第 2 步·推荐：agent 精修（把描述融进主体，风格冻结）→ 带参考图出图
$('#btn-wb-generate').addEventListener('click', () => {
  const style = activeStyle()
  const desc = $('#wb-desc').value.trim()
  if (!style) { alert('先完成第 1 步，或从风格库选一套风格'); return }
  if (!desc) { alert('先写描述要求：想画什么？'); return }
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
    '要求：1) 按路径 B 最小化修改——把描述融进「场景.主体」等画面内容字段（人物/主体/动作/场景元素），风格模式、画面气质、审美控制、相机等风格字段逐字冻结；2) 用 ips_validate 校验 + ips_diff 冻结自检（改动只落在描述覆盖的节点）；3) 用 ips_generate 出图（referenceImages=[上面的参考图路径]，model 与用户在面板选的一致即可默认 GPT-Image flare low）；4) 完成后把成图路径告诉用户（面板「生成历史」会同步出现）。',
  ].join('\n')
  $('#wb-step2-report').innerHTML = '<div class="line ok">已发起：agent 正在对话里精修提示词并出图（约 2-9 分钟），完成后成图会出现在「生成历史」。</div>'
  askAgent(prompt)
})

// 第 2 步·快速：不改提示词，描述作为附加要求直连出图
$('#btn-wb-direct').addEventListener('click', async () => {
  const style = activeStyle()
  const desc = $('#wb-desc').value.trim()
  const report = $('#wb-step2-report')
  if (!style) { alert('先完成第 1 步，或从风格库选一套风格'); return }
  if (!desc) { alert('先写描述要求：想画什么？'); return }
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
    report.innerHTML = `<div class="line err">❌ ${escapeHtml(String(err.message || err))}</div>`
    updateGenerateButtons()
  }
})

function pollJob(jobId, box, onDone = null) {
  const timer = setInterval(async () => {
    try {
      const r = await fetchJSON(`/api/job?id=${encodeURIComponent(jobId)}`)
      const job = r.job || {}
      if (job.status === 'running') { box.innerHTML = '<div class="line warn">生成中…（apiz 单张 2-9 分钟，超时不重提交）</div>'; return }
      clearInterval(timer)
      if (onDone) onDone()
      if (job.status === 'done') {
        const rec = job.record
        const price = typeof rec.price === 'number' ? `，消耗 ${rec.price} 积分` : ''
        const refs = rec.referenceCount ? `，参考图 ${rec.referenceCount} 张已传回` : ''
        box.innerHTML = `<div class="line ok">✅ 出图完成（${Math.round(rec.durationMs / 1000)}s${price}${refs}）</div>` +
          (rec.warnings?.length ? `<div class="line warn">${escapeHtml(rec.warnings.join('；'))}</div>` : '') +
          (rec.files || []).map((f) => `<div class="line ok">${escapeHtml(f)}</div>`).join('')
        loadStatus()
        loadHistory()
      } else {
        box.innerHTML = `<div class="line err">❌ ${escapeHtml(job.error || '生成失败')}</div>`
      }
    } catch {
      /* 轮询抖动，下一轮继续 */
    }
  }, 3000)
}

// ---------------------------------------------------------------- 生成历史
async function loadHistory() {
  const box = $('#history-list')
  try {
    const r = await fetchJSON('/api/history?limit=60')
    $('#history-stats').textContent = `共 ${r.total} 条 · 成功 ${r.stats.ok} · 失败 ${r.stats.failed} · 累计 ${r.stats.credits} 积分`
    box.innerHTML = ''
    if (!r.list.length) { box.innerHTML = '<div class="muted">还没有出图记录</div>'; return }
    for (const rec of r.list) {
      const item = document.createElement('div')
      item.className = 'history-item'
      const first = rec.files?.[0]
      const img = first
        ? `<img src="${mediaSrc(first)}" alt="成图">`
        : '<div class="muted">无成图</div>'
      const when = (rec.createdAt || '').replace('T', ' ').slice(0, 19)
      const price = typeof rec.price === 'number' ? `${rec.price} 积分` : '—'
      item.innerHTML = `
        ${img}
        <div class="meta">
          <b>${escapeHtml(rec.model || rec.taskId || '')}</b><br>
          ${when} · ${price} · ${Math.round((rec.durationMs || 0) / 1000)}s<br>
          比例 ${escapeHtml(rec.aspectRatio || '—')}${rec.quality ? ` · ${escapeHtml(rec.quality)}` : ''}${rec.sizeTier ? ` · ${escapeHtml(rec.sizeTier)}` : ''} · 参考图 ${rec.referenceCount ?? 0} 张<br>
          prompt ${rec.promptChars ?? 0} 字符
          ${rec.warnings?.length ? `<div class="line warn">${escapeHtml(rec.warnings.join('；'))}</div>` : ''}
        </div>
        <div class="meta">
          ${(rec.files || []).map((f) => `<div class="path">${escapeHtml(f)}</div>`).join('')}
          <button class="btn ghost" data-del="${escapeAttr(rec.id)}">删除</button>
        </div>`
      item.querySelector('[data-del]').addEventListener('click', async () => {
        await fetchJSON('/api/history/remove', post({ id: rec.id }))
        loadHistory()
        loadStatus()
      })
      box.appendChild(item)
    }
  } catch (err) {
    box.innerHTML = `<div class="report"><div class="line err">${escapeHtml(String(err.message || err))}</div></div>`
  }
}

$('#btn-history-clear').addEventListener('click', async () => {
  if (!confirm('清空全部生成历史？（成图文件保留在磁盘）')) return
  await fetchJSON('/api/history/clear', post({}))
  loadHistory()
  loadStatus()
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

// ---------------------------------------------------------------- 启动
applyScheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
loadStatus()
loadLibrary()
pollStyle()
// 风格常驻轮询：agent 在对话里调 ips_style 写回后，第 2 步卡片自动亮起（不依赖用户刷新）
if (!stylePollTimer) { stylePollTimer = setInterval(() => { pollStyle() }, 2500) }
// 刷新后恢复第 1 步状态（路径已填则按钮可用）
wbRefPath = $('#wb-ref-path').value.trim()
$('#btn-wb-analyze').disabled = !wbRefPath
