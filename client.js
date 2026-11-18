// 提示词工作台 · 浏览器半边
// 侧栏加「提示词工作台」入口；主区域是 /image-prompt-studio/ 的工作台页面（iframe）：
// 预设库 / 提示词编辑器（校验+diff）/ 出图与历史看板。
// 明暗跟随 dsh 主题，切换时把配色发给页面。
//
// 注意：这个文件直接调 window.__ModuleLoader__.load，不要再被 build banner 包一层，
// 否则同一个 id 会注册两次（宿主会报 duplicate factory registration）。
window.__ModuleLoader__.load({
  id: 'dsh-image-prompt-studio',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PANEL = 'image-prompt-studio'
    const LABEL = '提示词工作台'
    const SRC = '/image-prompt-studio/'

    // 画框 + 调色点：和 icon.svg 同一枚徽标（结构化提示词出画面）
    function StudioIcon(props) {
      const s = (props && props.size) || 18
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round'
      },
        h('rect', { x: 3, y: 3, width: 18, height: 18, rx: 2.5 }),
        h('path', { d: 'M3 15.5l4.2-4.2a1.6 1.6 0 0 1 2.3 0l4.6 4.6' }),
        h('circle', { cx: 14.8, cy: 8.2, r: 1.7 }),
        h('path', { d: 'M13.2 17.5l2.6-2.6a1.6 1.6 0 0 1 2.3 0l2.9 2.9' }),
        h('path', { d: 'M7.2 20.9l3.4-3.4' }))
    }

    function apply(ctx) {
      const frames = new Set()
      let scheme = null

      const post = (frame, payload) => {
        try { if (frame && frame.contentWindow) frame.contentWindow.postMessage(payload, location.origin) } catch { /* 跨域/已卸载 */ }
      }
      const pushScheme = () => {
        if (scheme) for (const frame of frames) post(frame, { type: 'image-prompt-studio:scheme', scheme })
      }

      // 主题：有 theme 服务就跟随，没有（老宿主/无主题）就用页面自己的默认
      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['theme'], (c) => {
            const push = (snap) => {
              try { scheme = snap.active.colorScheme } catch { scheme = null }
              pushScheme()
            }
            try { push(c.theme.getTheme()) } catch { /* ignore */ }
            c.on('theme/change', push)
          })
        }
      } catch { /* ignore */ }

      function StudioPanel() {
        const ref = React.useRef ? React.useRef(null) : { current: null }

        React.useEffect(() => {
          const self = ref.current
          if (self) frames.add(self)
          addEventListener('message', onMessage)
          pushScheme()
          return () => { removeEventListener('message', onMessage); frames.delete(self) }
          function onMessage(e) {
            const frame = ref.current
            if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin) return
            const m = e.data
            if (!m || m.type !== 'image-prompt-studio:ask' || typeof m.prompt !== 'string') return
            // 「在对话里继续」：把当前 JSON（或 diff 结论）带进新对话
            try {
              ctx.uiWorkspace.startSession(undefined, { prompt: m.prompt, whenDraftExists: 'replace' })
            } catch (err) {
              console.error('[image-prompt-studio] 开新对话失败', err)
              post(frame, { type: 'image-prompt-studio:ask-failed', message: String((err && err.message) || err) })
            }
          }
        }, [])

        return h('iframe', {
          ref,
          src: SRC,
          title: LABEL,
          allow: 'clipboard-write',
          onLoad: (e) => { pushScheme(); post(e.currentTarget, { type: 'image-prompt-studio:scheme', scheme }) },
          style: { width: '100%', height: '100%', border: 0, display: 'block', background: 'transparent' }
        })
      }

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: PANEL, order: 8, label: () => LABEL }, StudioIcon))
      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL }, StudioPanel))
    }

    return { inject: ['slots', 'uiWorkspace'], apply }
  }
})
