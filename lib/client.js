/**
 * dsh-pad-touch 客户端 —— 输入框左边一个手柄按钮
 *
 * 三种样子（都是圆圈）：
 *   idle     灰色圆圈，没在录，点一下开始
 *   starting 圆圈转动（类似鼠标加载），正在拉起手柄服务
 *   running  蓝色圆圈，正在接收触摸
 *
 * 宿主侧负责起停 python 服务、投递消息；这里只管显示和发开关请求。
 */
window.__ModuleLoader__.load({
  id: 'dsh-pad-touch',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var CSS_ID = 'dsh-pad-touch-css'

    function ensureCss() {
      if (typeof document === 'undefined') return
      // 每次都替换：DSH 重连时 DOM 不重建，旧样式会一直占着这个 id，
      // 只 check 存在与否会让新版 CSS 永远进不来
      var old = document.getElementById(CSS_ID)
      if (old) old.remove()
      var style = document.createElement('style')
      style.id = CSS_ID
      style.textContent = [
        '@keyframes dshPadSpin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }',
        '.dsh-pad-wrap{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px}',
        '.dsh-pad-svg{position:absolute;left:50%;top:50%;margin:-16px 0 0 -16px;pointer-events:none}',
        '.dsh-pad-arc{transform-origin:16px 16px;animation:dshPadSpin .85s linear infinite}',
      ].join('')
      document.head.appendChild(style)
    }

    var BASE_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 28,
      height: 28,
      borderRadius: 8,
      border: 'none',
      cursor: 'pointer',
      fontSize: 15,
      lineHeight: 1,
      padding: 0,
      background: 'transparent',
      transition: 'opacity 150ms ease, background 150ms ease',
    }

    /** 圆形指示器：用 SVG 画，不依赖 CSS 的 border-radius，任何环境都是正圆。 */
    function ringSvg(phase, remainMs) {
      // 停止触摸 3 秒后（距自动关只剩不到 2 秒）由蓝转灰，提示「快断了」
      var cooling = phase === 'running' && Number(remainMs || 0) <= 2000
      var stroke =
        phase === 'running'
          ? cooling
            ? 'rgba(150,150,160,.55)'
            : '#2f7bff'
          : 'rgba(140,140,150,.28)'
      var kids = [
        React.createElement('circle', {
          key: 'ring',
          cx: 16,
          cy: 16,
          r: 14,
          fill: 'none',
          stroke: stroke,
          strokeWidth: phase === 'running' && !cooling ? 2.4 : 2,
        }),
      ]
      if (phase === 'running' && !cooling) {
        kids.push(
          React.createElement('circle', {
            key: 'glow',
            cx: 16,
            cy: 16,
            r: 15.4,
            fill: 'none',
            stroke: 'rgba(47,123,255,.16)',
            strokeWidth: 3.2,
          }),
        )
      }
      if (phase === 'starting') {
        kids.push(
          React.createElement('circle', {
            key: 'arc',
            cx: 16,
            cy: 16,
            r: 14,
            fill: 'none',
            stroke: '#3b82f6',
            strokeWidth: 2.4,
            strokeLinecap: 'round',
            strokeDasharray: '22 66',
            className: 'dsh-pad-arc',
          }),
        )
      }
      return React.createElement(
        'svg',
        { width: 32, height: 32, viewBox: '0 0 32 32', className: 'dsh-pad-svg' },
        kids,
      )
    }

    function btnStyle(phase) {
      if (phase === 'idle') return { ...BASE_STYLE, opacity: 0.6 }
      if (phase === 'starting') return { ...BASE_STYLE, opacity: 0.8, cursor: 'progress' }
      return { ...BASE_STYLE, opacity: 1, background: 'rgba(47, 123, 255, 0.12)' }
    }

    function tipFor(st) {
      if (st.phase === 'starting') return '正在启动手柄服务…'
      if (st.phase === 'running') {
        var left = Math.max(0, Math.round((st.remainMs || 0) / 1000))
        return '正在接收手柄触摸 · 再点一下停 · 空闲 ' + left + ' 秒后自动关'
      }
      return '点一下，启动手柄服务并开始接收触摸'
    }

    /** 在页面里自己找「当前正在看的会话 id」——DSH 不通过插槽 props 给，只能自己看 */
    function probeSession() {
      var out = { sessionId: '', via: '', probe: [] }
      function want(x) { if (x && out.probe.length < 50) out.probe.push(String(x)) }

      // 0) 先翻本页面自己的 React fiber —— 多标签页时 localStorage 是共享的、会被别的页面串掉，
      //    fiber 是本页面渲染出来的，最可信
      try {
        var host = document.querySelector('.dsh-pad-wrap') || document.querySelector('.dsh-pad-svg')
        var fib = null
        if (host) {
          var fk = Object.keys(host).filter(function (x) { return x.indexOf('__reactFiber$') === 0 })[0]
          if (fk) fib = host[fk]
        }
        var d0 = 0
        while (fib && d0++ < 50) {
          var p0 = fib.memoizedProps
          if (p0 && typeof p0 === 'object') {
            var c0 = p0.sessionId || p0.session || (p0.conversation && p0.conversation.id)
            if (typeof c0 === 'string' && c0) { out.sessionId = c0; out.via = 'fiber'; return out }
            for (var pk0 in p0) {
              if (pk0.length < 40 && /^session/i.test(pk0) && typeof p0[pk0] === 'string' && p0[pk0].indexOf('session-') === 0) {
                out.sessionId = p0[pk0]; out.via = 'fiber.' + pk0; return out
              }
            }
          }
          fib = fib.return
        }
      } catch (e) { want('fiber ERR ' + (e && e.message)) }

      // 1) URL：DSH 目前不带会话 id，留着以防以后改成路由式
      try {
        var href = String(location.href)
        var m = href.match(/session[-/]([0-9a-f-]{8,})/i)
        if (m) { out.sessionId = 'session-' + m[1]; out.via = 'url' }
        want('url=' + href.slice(0, 90))
      } catch (e) {}

      // 2) 两个 storage：刷新后能回到原会话，多半存在这儿
      var stores = []
      try { stores.push(['local', window.localStorage]) } catch (e) {}
      try { stores.push(['session', window.sessionStorage]) } catch (e) {}
      var SID = /session-[0-9a-f][0-9a-f-]{7,}/i
      var UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
      for (var s = 0; s < stores.length; s++) {
        var tag = stores[s][0], st = stores[s][1]
        try {
          for (var k = 0; k < st.length; k++) {
            var key = st.key(k), val = String(st.getItem(key) || '')
            var mm = val.match(SID) || val.match(UUID)
            if (mm) {
              // key 名里带 last/current/active 的更可信，优先级更高
              var strong = /last|current|active|selected|recent/i.test(key)
              if (!out.sessionId || strong) {
                var cid = mm[0]
                if (cid.toLowerCase().indexOf('session-') !== 0) cid = 'session-' + cid
                out.sessionId = cid
                out.via = tag + ':' + key + (strong ? '*' : '')
              }
            }
            want(tag + '.' + key + '=' + val.slice(0, 50))
          }
        } catch (e) { want(tag + ' ERR ' + (e && e.message)) }
      }

      // 3) DOM 上的 data-* 属性
      try {
        var el = document.querySelector('[data-session-id],[data-conversation-id],[data-session]')
        if (el) {
          var sid = el.getAttribute('data-session-id') || el.getAttribute('data-conversation-id') || el.getAttribute('data-session')
          if (sid && !out.sessionId) { out.sessionId = sid; out.via = 'dom' }
          want('dom=' + String(sid).slice(0, 50))
        }
      } catch (e) {}

      // 4) 兜底：从自己的 DOM 节点翻 React fiber，往上一层层看 props（最黑但最准）
      try {
        if (!out.sessionId) {
          var host = document.querySelector('.dsh-pad-wrap') || document.querySelector('.dsh-pad-svg')
          var fib = null
          if (host) {
            var fk = Object.keys(host).filter(function (x) { return x.indexOf('__reactFiber$') === 0 })[0]
            if (fk) fib = host[fk]
          }
          var depth = 0
          while (fib && depth++ < 50) {
            var p = fib.memoizedProps
            if (p && typeof p === 'object') {
              var cand = p.sessionId || p.session || (p.conversation && p.conversation.id)
              if (typeof cand === 'string' && cand) { out.sessionId = cand; out.via = 'fiber'; break }
              for (var pk in p) {
                if (pk.length < 40 && /^session/i.test(pk) && typeof p[pk] === 'string' && p[pk].indexOf('session-') === 0) {
                  out.sessionId = p[pk]; out.via = 'fiber.' + pk; break
                }
              }
              if (out.sessionId) break
            }
            fib = fib.return
          }
          if (out.sessionId) want('fiber=' + out.sessionId)
        }
      } catch (e) { want('fiber ERR ' + (e && e.message)) }

      return out
    }

    /** 每个标签页一个短 id（存 sessionStorage，不跨页面共享），方便从日志分清是谁报的 */
    function pageId() {
      try {
        var k = 'dsh-pad-page-id'
        var v = sessionStorage.getItem(k)
        if (!v) { v = Math.random().toString(36).slice(2, 8); sessionStorage.setItem(k, v) }
        return v
      } catch (e) { return '?' }
    }

    /** 把探测结果报给宿主；id 没变就不发 */
    var reported = ''
    function reportSession(force) {
      // 只有看得见的那个页面才算「当前」：同时开了几个窗口时，
      // 后台页面不许抢着上报，否则会话 id 会一秒一跳、摸到别的窗口去
      try { if (document.visibilityState !== 'visible') return } catch (e) {}
      var r = probeSession()
      if (!r.sessionId) {
        // 失败也报一次诊断，好让我从日志里看出页面上到底有什么
        if (force) {
          fetch('/dsh-pad/api/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: '', via: r.via, probe: r.probe, page: pageId() }),
          }).catch(function () {})
        }
        return
      }
      if (!force && r.sessionId === reported) return
      reported = r.sessionId
      fetch('/dsh-pad/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: r.sessionId, via: r.via, probe: r.probe, page: pageId() }),
      }).catch(function () {})
    }

    function makePadButton() {
      return function PadButton() {
        var state = React.useState({ phase: 'idle', remainMs: 0, ok: false })
        var st = state[0]
        var setSt = state[1]

        React.useEffect(function () {
          ensureCss()
          // 会话跟随：挂载时探一次；之后每 4 秒复查，切了窗口就会重报（不重启、不改配置）
          reportSession(true)
          var sidTimer = setInterval(function () { reportSession(false) }, 4000)
          // 切回这个标签页 / 窗口重新获得焦点时立刻重报——别等下一次轮询
          function onVis() { reportSession(true) }
          try { document.addEventListener('visibilitychange', onVis) } catch (e) {}
          try { window.addEventListener('focus', onVis) } catch (e) {}
          var alive = true
          function pull() {
            fetch('/dsh-pad/api/state', { cache: 'no-store' })
              .then(function (r) { return r.json() })
              .then(function (j) { if (alive && j && j.ok) setSt(j) })
              .catch(function () {})
          }
          pull()
          var timer = setInterval(pull, 1500)
          return function () {
            alive = false
            clearInterval(timer)
            clearInterval(sidTimer)
            try { document.removeEventListener('visibilitychange', onVis) } catch (e) {}
            try { window.removeEventListener('focus', onVis) } catch (e) {}
          }
        }, [])

        function onClick() {
          if (st.phase === 'starting') return
          // 点下去那一刻先把本窗口的会话报给宿主——比等 4 秒轮询及时，
          // 免得刚切窗口就摸，消息还投在上一处
          reportSession(true)
          // 乐观：立刻切到"启动中"，别等下一次轮询
          var prev = st.phase
          setSt(function (s) { return { ...s, phase: prev === 'idle' ? 'starting' : 'idle' } })
          fetch('/dsh-pad/api/toggle', { method: 'POST' })
            .then(function (r) { return r.json() })
            .then(function (j) {
              if (j && j.phase) setSt(function (s) { return { ...s, phase: j.phase, remainMs: j.remainMs || 0 } })
            })
            .catch(function () {
              setSt(function (s) { return { ...s, phase: prev } })
            })
        }

        return React.createElement(
          'span',
          { className: 'dsh-pad-wrap' },
          st.phase === 'idle' ? null : ringSvg(st.phase, st.remainMs),
          React.createElement(
            'button',
            {
              type: 'button',
              onClick: onClick,
              title: tipFor(st),
              'aria-label': '手柄触摸',
              style: btnStyle(st.phase),
            },
            '🎮',
          ),
        )
      }
    }

    var PadButton = makePadButton()

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return
      slots.inject('conversation.input.left', function () {
        return slots.register(
          { name: 'conversation.input.left', id: 'pad-touch', order: 6, label: '手柄触摸' },
          function () { return React.createElement(PadButton) },
        )
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
