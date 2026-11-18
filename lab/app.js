// 提示词工作台 · 面板逻辑（vanilla JS，无构建）
// 预设库 / 提示词编辑（校验+冻结比对）/ 出图（异步 job 轮询）/ 生成历史。
// 校验与比对走插件 /api/* 接口（与 ips_validate / ips_diff 工具同一内核）。
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
})
function goto(tab) {
  $(`.tab[data-tab="${tab}"]`)?.click()
}

// ---------------------------------------------------------------- 出图工作台（两步向导，唯一主流程）
// 创作归对话里的 agent（读图分析/措辞/修改），面板只做：上传落盘、拼指令开对话、
// 展示 agent 用 ips_style 写回的风格、直连出图与历史。提示词 JSON 对用户不可见（查看 JSON 仅读）。
function askAgent(prompt) {
  parent.postMessage({ type: 'image-prompt-studio:ask', prompt }, location.origin)
}

let wbRefPath = ''       // 第 1 步就绪的参考图路径（上传落盘或手填）
let wbStyle = null       // agent 写回的当前风格 { prompt, referenceImage, note, updatedAt }
let stylePollTimer = null

function renderRefPreview(src) {
  const box = $('#wb-ref-preview')
  if (!src) { box.hidden = true; box.innerHTML = ''; return }
  box.hidden = false
  box.innerHTML = `<img src="${src}" alt="参考图预览">`
}

function renderStyleCard(style) {
  wbStyle = style
  const has = Boolean(style && style.prompt)
  $('#wb-style-empty').hidden = has
  $('#wb-style-card').hidden = !has
  $('#btn-wb-generate').disabled = !has
  $('#btn-wb-direct').disabled = !has
  if (!has) return
  const p = style.prompt || {}
  $('#wb-style-summary').textContent = `风格：${String(p['风格模式'] || '').slice(0, 80)}`
  $('#wb-style-note').textContent = style.note ? `说明：${style.note}` : ''
  $('#wb-style-thumb').src = style.referenceImage ? `${API}/media?path=${encodeURIComponent(style.referenceImage)}` : ''
}

async function pollStyle() {
  try {
    const r = await fetchJSON('/api/style')
    const style = r.style || null
    if (JSON.stringify(style) !== JSON.stringify(wbStyle)) renderStyleCard(style)
  } catch { /* 轮询抖动 */ }
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
    '要求：1) 按四维度提取特征（角色特征/场景环境/画面风格/构图与镜头角度），产出完整 26 字段风格提示词 JSON（不要 markdown 围栏）；2) 用 ips_validate 校验；3) 校验通过后**必须调 ips_style（action=set，prompt=风格 JSON，referenceImage=上面的参考图路径，note=一句话画风概括）写回面板**——用户在「出图工作台」第 2 步等着选这个风格；4) 完成后告诉用户可以回面板第 2 步出图。',
  ].join('\n')
  $('#wb-step1-report').innerHTML = '<div class="line ok">已发起：agent 正在对话里分析这张图，完成后风格会自动出现在第 2 步（可留在本页等待）。</div>'
  askAgent(prompt)
})

// 第 2 步·推荐：agent 精修（把描述融进主体，风格冻结）→ 带参考图出图
$('#btn-wb-generate').addEventListener('click', () => {
  const desc = $('#wb-desc').value.trim()
  if (!wbStyle) { alert('还没有风格：先完成第 1 步'); return }
  if (!desc) { alert('先写描述要求：想画什么？'); return }
  const prompt = [
    '请执行 image-prompt-studio skill 的「第 2 步 · 风格出图」：',
    '',
    '当前风格（用户在第 1 步用这张参考图定下的，出图时必须把该原图作为风格参考传回）：',
    `- 参考图：${wbStyle.referenceImage}`,
    '- 风格 JSON：',
    '```json',
    JSON.stringify(wbStyle.prompt, null, 2),
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
  const desc = $('#wb-desc').value.trim()
  const report = $('#wb-step2-report')
  if (!wbStyle) { alert('还没有风格：先完成第 1 步'); return }
  if (!desc) { alert('先写描述要求：想画什么？'); return }
  try {
    $('#btn-wb-direct').disabled = true
    report.innerHTML = '<div class="line warn">已提交，任务运行中（单张约 2-9 分钟，超时不重提交）…</div>'
    const r = await fetchJSON('/api/generate', post({
      prompt: wbStyle.prompt,
      extraRequirements: `画面内容：${desc}。除画面内容外，风格、色彩与质感严格以 JSON 描述为准。`,
      model: $('#wb-model').value,
      aspectRatio: $('#wb-aspect').value,
      referenceImages: wbStyle.referenceImage ? [wbStyle.referenceImage] : [],
    }))
    if (!r.ok) throw new Error(r.error || '提交失败')
    pollJob(r.job, report, () => { $('#btn-wb-direct').disabled = !wbStyle; loadHistory(); loadStatus() })
  } catch (err) {
    report.innerHTML = `<div class="line err">❌ ${escapeHtml(String(err.message || err))}</div>`
    $('#btn-wb-direct').disabled = !wbStyle
  }
})

$('#btn-wb-view-json').addEventListener('click', () => {
  if (!wbStyle) return
  $('#editor-before').value = JSON.stringify(wbStyle.prompt, null, 2)
  goto('editor')
})
$('#btn-wb-clear-style').addEventListener('click', async () => {
  await fetchJSON('/api/style/clear', post({}))
  renderStyleCard(null)
})

// 风格常驻轮询：agent 在对话里调 ips_style 写回后，第 2 步卡片自动亮起（不依赖用户刷新）
if (!stylePollTimer) { pollStyle(); stylePollTimer = setInterval(pollStyle, 2500) }

// ---------------------------------------------------------------- 状态条
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
  } catch (err) {
    $('#status-version').textContent = '离线'
  }
}

async function fetchJSON(url, options) {
  const res = await fetch(`${API}${url}`, options)
  const body = await res.json().catch(() => ({}))
  if (!res.ok && !body.error) throw new Error(`HTTP ${res.status}`)
  return body
}

// ---------------------------------------------------------------- 预设库
let editorAfterTouched = false

async function loadPresets() {
  const box = $('#preset-list')
  try {
    const { presets } = await fetchJSON('/api/presets')
    box.innerHTML = ''
    if (!presets.length) { box.innerHTML = '<div class="muted">没有预设</div>'; return }
    for (const p of presets) {
      const card = document.createElement('div')
      card.className = 'preset-card'
      const badges = [
        p.builtin ? '<span class="badge">内置</span>' : '<span class="badge mut">用户</span>',
        p.override ? '<span class="badge warn">同名覆盖内置</span>' : '',
        p.partial ? '<span class="badge warn">部分结构</span>' : '',
      ].join('')
      card.innerHTML = `
        <div class="name">${escapeHtml(p.name)} ${badges}</div>
        <div class="summary">${escapeHtml((p.summary || '').slice(0, 120)) || '<span class="muted">（无摘要）</span>'}</div>
        <div class="col-actions"><button class="btn" data-load="${escapeAttr(p.name)}">加载进编辑器</button></div>`
      card.querySelector('[data-load]').addEventListener('click', () => loadPresetIntoEditor(p.name))
      box.appendChild(card)
    }
  } catch (err) {
    box.innerHTML = `<div class="report"><div class="line err">${escapeHtml(String(err.message || err))}</div></div>`
  }
}

async function loadPresetIntoEditor(name) {
  const r = await fetchJSON(`/api/preset?name=${encodeURIComponent(name)}`)
  $('#editor-before').value = JSON.stringify(r.data, null, 2)
  $('#editor-after').value = ''
  $('#validate-report').innerHTML = ''
  $('#diff-report').innerHTML = ''
  goto('editor')
  $('#editor-foot-note').textContent = `已加载预设「${name}」${r.builtin ? '（内置只读，存为预设请改名）' : ''}`
}

// ---------------------------------------------------------------- 提示词编辑：校验 + 比对
function parseEditorJSON(text, label) {
  if (!text.trim()) throw new Error(`${label}内容为空`)
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new Error(`${label}不是合法 JSON：${err.message}`)
  }
}

function renderReport(box, lines) {
  box.innerHTML = lines.map((l) => `<div class="line ${l.kind}">${escapeHtml(l.text)}</div>`).join('')
}

$('#btn-validate').addEventListener('click', async () => {
  const box = $('#validate-report')
  box.innerHTML = '<div class="line warn">校验中…</div>'
  try {
    const partial = $('#editor-partial').checked
    const r = await fetchJSON('/api/validate', post({ prompt: $('#editor-before').value, partial }))
    if (!r.ok) { renderReport(box, [{ kind: 'err', text: r.error }]); return }
    const report = r.report
    const lines = []
    if (report.passed) lines.push({ kind: 'ok', text: `✅ ${partial ? '部分模式' : '完整模式'}校验通过（核对 ${report.checkedFields} 个字段）` })
    else lines.push({ kind: 'err', text: `❌ ${report.errors.length} 个问题（报告不拦截，按清单修正）` })
    for (const e of report.errors) lines.push({ kind: 'err', text: e })
    for (const w of report.warnings) lines.push({ kind: 'warn', text: `${w}（部分模式跳过）` })
    renderReport(box, lines)
    $('#gen-prompt').value = $('#editor-before').value
  } catch (err) {
    renderReport(box, [{ kind: 'err', text: String(err.message || err) }])
  }
})

$('#btn-diff').addEventListener('click', async () => {
  const box = $('#diff-report')
  box.innerHTML = '<div class="line warn">比对中…</div>'
  try {
    const r = await fetchJSON('/api/diff', post({ before: $('#editor-before').value, after: $('#editor-after').value }))
    if (!r.ok) { renderReport(box, [{ kind: 'err', text: r.error }]); return }
    const d = r.diff
    const lines = [
      { kind: 'ok', text: `改动 ${d.changed.length} 个字段 / 冻结 ${d.frozenCount} 个（冻结率 ${d.frozenRate}%）${d.added.length ? `；新增 ${d.added.length}` : ''}${d.removed.length ? `；删除 ${d.removed.length}` : ''}` },
    ]
    if (d.changed.length) {
      const rows = d.changed.map((c) => `<tr><td>${escapeHtml(c.path)}</td><td>${escapeHtml(c.before)}</td><td>${escapeHtml(c.after)}</td></tr>`).join('')
      lines.push({ kind: 'warn', html: `<table><tr><th>改动字段</th><th>改前</th><th>改后</th></tr>${rows}</table>` })
    }
    lines.push({ kind: 'ok', text: '程序只比对逐字一致性：改动是否全部落在修改指令覆盖的节点上，请按「最小化修改」纪律自查（agent 会用 ips_diff 工具做同样核对）。' })
    renderReport(box, lines)
    $('#gen-prompt').value = $('#editor-after').value
    editorAfterTouched = true
  } catch (err) {
    renderReport(box, [{ kind: 'err', text: String(err.message || err) }])
  }
})

$('#btn-save-preset').addEventListener('click', async () => {
  const note = $('#editor-foot-note')
  try {
    const source = $('#editor-after').value.trim() || $('#editor-before').value
    const data = parseEditorJSON(source, '提示词')
    const name = prompt('预设名（保存为用户预设，内置预设不可覆盖）')
    if (!name || !name.trim()) return
    const r = await fetchJSON('/api/presets', post({ name: name.trim(), data }))
    if (!r.ok) { note.textContent = r.error || '保存失败'; return }
    note.textContent = `已保存用户预设「${r.name}」`
    loadPresets()
  } catch (err) {
    note.textContent = String(err.message || err)
  }
})

$('#editor-before').addEventListener('input', () => { $('#editor-foot-note').textContent = '' })
$('#btn-ask').addEventListener('click', () => {
  const json = $('#editor-after').value.trim() || $('#editor-before').value.trim()
  if (!json) { $('#editor-foot-note').textContent = '编辑器里还没有提示词 JSON'; return }
  parent.postMessage({ type: 'image-prompt-studio:ask', prompt: `请基于这份结构化提示词继续（image-prompt-studio skill）。\n\n${json}` }, location.origin)
})

// ---------------------------------------------------------------- 出图
$('#btn-generate').addEventListener('click', async () => {
  const btn = $('#btn-generate')
  const note = $('#gen-note')
  try {
    const promptText = $('#gen-prompt').value.trim() || ($('#editor-after').value.trim() || $('#editor-before').value.trim())
    if (!promptText) { note.textContent = '提示词 JSON 为空：先在「提示词编辑」里准备'; return }
    const refs = $('#gen-refs').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    const body = {
      prompt: promptText,
      model: $('#gen-model').value,
      aspectRatio: $('#gen-aspect').value,
      quality: $('#gen-quality').value,
      sizeTier: $('#gen-tier').value,
      extraRequirements: $('#gen-extra').value.trim() || undefined,
      referenceImages: refs,
    }
    btn.disabled = true
    note.textContent = '已提交，任务运行中（单张约 2-9 分钟）…'
    const r = await fetchJSON('/api/generate', post(body))
    if (!r.ok) { note.textContent = r.error || '提交失败'; return }
    pollJob(r.job)
  } catch (err) {
    note.textContent = String(err.message || err)
    btn.disabled = false
  }
})

function pollJob(jobId, box = $('#gen-job'), onDone = null) {
  const timer = setInterval(async () => {
    try {
      const r = await fetchJSON(`/api/job?id=${encodeURIComponent(jobId)}`)
      const job = r.job || {}
      if (job.status === 'running') { box.innerHTML = '<div class="line warn">生成中…（apiz 单张 2-9 分钟，超时不重提交）</div>'; return }
      clearInterval(timer)
      if (onDone) { onDone() } else { $('#btn-generate').disabled = false; $('#gen-note').textContent = '' }
      if (job.status === 'done') {
        const rec = job.record
        const price = typeof rec.price === 'number' ? `，消耗 ${rec.price} 积分` : ''
        const refs = rec.referenceCount ? `，参考图 ${rec.referenceCount} 张已传回` : ''
        box.innerHTML = `<div class="line ok">✅ 出图完成（${Math.round(rec.durationMs / 1000)}s${price}${refs}）</div>` +
          (rec.warnings?.length ? `<div class="line warn">${escapeHtml(rec.warnings.join('；'))}</div>` : '')
        renderPreview(job.files || [])
        if (!onDone) { loadStatus(); loadHistory() }
      } else {
        box.innerHTML = `<div class="line err">❌ ${escapeHtml(job.error || '生成失败')}</div>`
      }
    } catch {
      /* 轮询抖动，下一轮继续 */
    }
  }, 3000)
}

function renderPreview(files) {
  const box = $('#gen-preview')
  box.innerHTML = ''
  for (const file of files) {
    const fig = document.createElement('figure')
    fig.style.margin = '0'
    fig.innerHTML = `<img src="/image-prompt-studio/media?path=${encodeURIComponent(file)}" alt="成图"><figcaption>${escapeHtml(file)}</figcaption>`
    box.appendChild(fig)
  }
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
        ? `<img src="/image-prompt-studio/media?path=${encodeURIComponent(first)}" alt="成图">`
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
loadPresets()
pollStyle()
// 刷新后恢复第 1 步状态（路径已填则按钮可用）
wbRefPath = $('#wb-ref-path').value.trim()
$('#btn-wb-analyze').disabled = !wbRefPath
