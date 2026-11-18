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

function pollJob(jobId) {
  const box = $('#gen-job')
  const timer = setInterval(async () => {
    try {
      const r = await fetchJSON(`/api/job?id=${encodeURIComponent(jobId)}`)
      const job = r.job || {}
      if (job.status === 'running') { box.innerHTML = '<div class="line warn">生成中…（apiz 单张 2-9 分钟，超时不重提交）</div>'; return }
      clearInterval(timer)
      $('#btn-generate').disabled = false
      $('#gen-note').textContent = ''
      if (job.status === 'done') {
        const rec = job.record
        const price = typeof rec.price === 'number' ? `，消耗 ${rec.price} 积分` : ''
        const refs = rec.referenceCount ? `，参考图 ${rec.referenceCount} 张已传回` : ''
        box.innerHTML = `<div class="line ok">✅ 出图完成（${Math.round(rec.durationMs / 1000)}s${price}${refs}）</div>` +
          (rec.warnings?.length ? `<div class="line warn">${escapeHtml(rec.warnings.join('；'))}</div>` : '')
        renderPreview(job.files || [])
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
