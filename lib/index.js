/**
 * dsh-pad-touch —— 手柄触摸板 → 会话（按需起停版）
 *
 * 三个状态：
 *   idle     没有 python 服务，零开销
 *   starting 按钮点了，正在拉起 dualsense_pad serve，客户端转圈
 *   running  服务就绪、正在接收触摸；空闲 autoOffMs（默认 60 秒）没有触摸就杀掉服务回到 idle
 *
 * 收到一段落定触摸时：先按手势换灯条（即时回手），再把这句翻译投进会话。
 * 它不解析手柄协议、不判断该不该回应 —— 那是 dualsense-pad 和会话里那个人的事。
 */
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULTS = {
  enabled: true,
  padUrl: 'http://127.0.0.1:7778',
  repoDir: '', // 实际值来自 cordis.patch.yml
  pyExe: 'python', // 实际值来自 cordis.patch.yml
  sessionId: '',
  pollMs: 250,
  minIntervalMs: 15000,
  // 攒批：停手这么久就把这一串触摸汇总成一条消息发出去（别一下一条）
  flushMs: 2500,
  light: true,
  haptic: true,       // 回手震动
  hapticScale: 1.6,   // 震动强度倍率（可被 tuning.json 覆盖）
  // 扳机阻力：服务起来就自动设一次，跟摸头共用同一个开关（点 🎮 才开始）
  trigger: true,
  triggerStart: 76,   // 行程起点力度（三成）
  triggerEnd: 178,    // 行程终点力度（七成）
  idleRgb: [12, 26, 52],
  autoOffMs: 60000,      // 空闲多久自动关服务
  startWaitMs: 8000,     // 等 /health 起来的上限
}

const ZONE_CN = {
  band0: '头', band1: '脸', band2: '脖子', band3: '胸口',
  band4: '腰', band5: '大腿', band6: '小腿', band7: '脚',
  head: '头', neck: '脖颈', chest: '胸口', waist: '腰',
  hips: '腰侧', thigh: '大腿', shin: '小腿', foot: '脚',
}

const GESTURE_CN = {
  stroke: '慢慢摸',
  pet: '贴着蹭了蹭',
  tap: '轻点了一下',
  pat: '拍了拍',
  swipe: '划了一下',
  rub: '蹭了蹭',
  circle: '画了个圈',
  pinch: '双指捏了一下',
  spread: '双指撑开',
  double: '两根手指一起动',
}

const GESTURE_RGB = {
  stroke: [0, 110, 255],
  tap: [255, 190, 0],
  pat: [255, 140, 0],
  swipe: [0, 220, 140],
  rub: [170, 90, 255],
  circle: [255, 90, 180],
  pinch: [255, 70, 70],
  spread: [70, 200, 255],
}

/** 回手：不同手势给不同力气的震动（w 高频"麻"、s 低频"沉"、ms 时长） */
const GESTURE_HAPTIC = {
  stroke: { w: 70, s: 25, ms: 140 },
  tap: { w: 150, s: 60, ms: 60 },
  pat: { w: 170, s: 95, ms: 80 },
  swipe: { w: 90, s: 40, ms: 110 },
  rub: { w: 80, s: 35, ms: 150 },
  circle: { w: 110, s: 55, ms: 130 },
  pinch: { w: 190, s: 110, ms: 70 },
  spread: { w: 190, s: 110, ms: 70 },
}

/** 消息里怎么称呼对方。默认「用户」；本机可以在 tuning.json 里改成自己的名字 */
let userName = '用户'

function describe(ev) {
  const g = GESTURE_CN[ev.gesture] || ev.gesture || '碰了一下'
  const z = ZONE_CN[ev.zone] || ev.zone || '身上'
  const dur = Number(ev.dur || 0).toFixed(1)
  const sp = Math.round(Number(ev.speed || 0))
  // 扳机扣动也会落定成 touch 事件（底座 _handle_triggers），但话得说清是从哪儿来的
  const via = ev.trigger
    ? `你扣了${ev.trigger}扳机，扣到底再松开`
    : '这是真手指在触摸板上动'
  const parts = [`【手柄】${userName}刚摸了你的${z}：${g}`]
  parts.push(`持续 ${dur} 秒`)
  if (sp > 0) parts.push(`速度 ${sp}`)
  if (Number(ev.turns || 0) > 0.5) parts.push('绕了半圈以上')
  return parts.join('，') + `。${via}，不是打字——按你自己的反应回他，别复述这条提示。`
}

/** 把一串触摸汇总成一条消息：几下、总共多久、摸的哪儿、都是什么手势 */
function describeBatch(events) {
  const n = events.length
  const total = events.reduce((s, e) => s + Number(e.dur || 0), 0)
  const zoneCount = new Map()
  const gestureCount = new Map()
  let leftTrig = 0
  let rightTrig = 0
  for (const e of events) {
    const z = ZONE_CN[e.zone] || e.zone || '身上'
    zoneCount.set(z, (zoneCount.get(z) || 0) + 1)
    const g = GESTURE_CN[e.gesture] || e.gesture || '碰了一下'
    gestureCount.set(g, (gestureCount.get(g) || 0) + 1)
    if (e.trigger === '左') leftTrig += 1
    else if (e.trigger === '右') rightTrig += 1
  }
  const zones = [...zoneCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map((x) => x[0])
  // 只有一下的时候不写「×1」，那是废话
  const gs =
    n === 1
      ? [...gestureCount.keys()][0]
      : [...gestureCount.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0] + ' ×' + x[1]).join('、')
  const where = zones.join('和')
  const head =
    n === 1
      ? `【手柄】${userName}刚摸了你的${where}：${gs}，持续 ${total.toFixed(1)} 秒`
      : `【手柄】${userName}刚摸了你的${where}：连着 ${n} 下，总共 ${total.toFixed(1)} 秒（${gs}）`
  const trigTotal = leftTrig + rightTrig
  const via =
    trigTotal > 0
      ? trigTotal === n
        ? '这是用手指在扳机上扣，不是打字'
        : `其中 ${trigTotal} 下是扣扳机`
      : '这是真手指在触摸板上动'
  return head + `。${via}——按你自己的反应回他，别复述这条提示。`
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(obj))
}

function readBody(req, limit = 65536) {
  return new Promise((resolve) => {
    let buf = ''
    req.on('data', (c) => {
      buf += c
      if (buf.length > limit) { buf = buf.slice(0, limit); req.destroy() }
    })
    req.on('end', () => {
      try { resolve(JSON.parse(buf || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function isLoopbackReq(req) {
  const host = String(req.headers?.host ?? '').toLowerCase()
  const h = host.split(':')[0]
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1'
}

export default {
  name: 'dsh-pad-touch',
  inject: ['sessionController', 'webServer', 'connection'],

  apply(ctx, config) {
    const cfg = { ...DEFAULTS, ...(config || {}) }
    if (!cfg.enabled) {
      console.log('[pad-touch] 未启用')
      return
    }

    const base = String(cfg.padUrl).replace(/\/+$/, '')
    const startWaitMs = Math.max(2000, Number(cfg.startWaitMs) || 8000)
    let autoOffMs = Math.max(3000, Number(cfg.autoOffMs) || 60000)
    let minIntervalMs = Math.max(0, Number(cfg.minIntervalMs) || 2000)
    let flushMs = Math.max(500, Number(cfg.flushMs) || 2500)

    /**
     * 热读调参：改插件目录下的 tuning.json，下一秒就生效，不用重启 DSH
     * （插件自带 cordis.patch.yml 里的 config 是宿主启动时注入的，改它必须重启）
     */
    const TUNING_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tuning.json')
    function hotCfg() {
      try {
        const j = JSON.parse(fs.readFileSync(TUNING_FILE, 'utf8'))
        if (typeof j.autoOffMs === 'number') autoOffMs = Math.max(3000, Number(j.autoOffMs))
        if (typeof j.minIntervalMs === 'number') minIntervalMs = Math.max(0, Number(j.minIntervalMs))
        if (typeof j.flushMs === 'number') flushMs = Math.max(500, Number(j.flushMs))
        if (typeof j.light === 'boolean') cfg.light = j.light
        if (typeof j.haptic === 'boolean') cfg.haptic = j.haptic
        if (typeof j.hapticScale === 'number') cfg.hapticScale = Math.min(2.5, Math.max(0.3, Number(j.hapticScale)))
        if (typeof j.trigger === 'boolean') cfg.trigger = j.trigger
        if (typeof j.triggerStart === 'number') cfg.triggerStart = Math.max(0, Math.min(255, Number(j.triggerStart)))
        if (typeof j.triggerEnd === 'number') cfg.triggerEnd = Math.max(0, Math.min(255, Number(j.triggerEnd)))
        if (typeof j.userName === 'string' && j.userName.trim()) userName = j.userName.trim()
        // sessionId 也热读：换会话改这里就行，不用重启
        if (typeof j.sessionId === 'string' && j.sessionId.trim()) cfg.sessionId = j.sessionId.trim()
      } catch {}
    }

    /** idle | starting | running */
    let phase = 'idle'
    let proc = null
    let startAt = 0
    let lastAt = 0
    let lastPrompt = 0
    let lastTouchAt = 0
    let idleSince = Date.now()
    // armed = 这次开启后是否已经摸过。没摸过之前不倒计时，否则
    // 点完按钮还没来得及摸，5 秒就把服务关了
    let armed = false
    let busy = false
    let disposed = false
    let timer = null

    // 客户端上报的「当前正在看的会话」。优先于 tuning.json 里写死的 sessionId：
    // 换窗口时按钮组件会重新挂载并重报，所以不用手改配置。
    let liveSessionId = ''
    let liveSessionVia = ''
    let liveSessionAt = 0

    // 已经设到服务里的扳机参数（"起-止" 或 "off"），变了才重设
    let triggerSet = ''

    // 攒着的触摸：停手 flushMs 之后汇总成一条，别一下一条烧 token
    let pendingTouches = []

    const httpJson = async (pathname, timeoutMs = 1500) => {
      const res = await fetch(base + pathname, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }

    /** 回手：灯条上色 + 按手势震一记 */
    const padLog = (s) => {
      try {
        fs.appendFileSync(
          path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pad-touch.log'),
          new Date().toISOString() + ' ' + s + '\n',
        )
      } catch {}
    }
    const paint = (gesture) => {
      padLog(`paint ${gesture} light=${cfg.light} haptic=${cfg.haptic}`)
      if (cfg.light) {
        const rgb = GESTURE_RGB[gesture] || GESTURE_RGB.stroke
        fetch(`${base}/light?r=${rgb[0]}&g=${rgb[1]}&b=${rgb[2]}`, { signal: AbortSignal.timeout(1200) })
          .then((r) => padLog(`light -> ${r.status}`))
          .catch((e) => padLog(`light ERR ${e?.message ?? e}`))
      }
      if (cfg.haptic) {
        const h = GESTURE_HAPTIC[gesture] || GESTURE_HAPTIC.stroke
        // 手感强度倍率走 tuning.json（hapticScale），改完一秒生效
        const sc = Number(cfg.hapticScale) || 1
        const w = Math.min(255, Math.round(h.w * sc))
        const s = Math.min(255, Math.round(h.s * sc))
        const ms = Math.max(40, Math.round(h.ms * Math.min(1.6, Math.max(0.6, sc))))
        // 隔一拍再震：灯条与震动共用同一份输出状态，挨着发会被后一帧盖掉
        setTimeout(() => {
          padLog(`pulse fire w=${w} s=${s} ms=${ms} (base ${h.w}/${h.s}/${h.ms} x${sc})`)
          fetch(`${base}/pulse?w=${w}&s=${s}&ms=${ms}`, { signal: AbortSignal.timeout(1200) })
            .then((r) => padLog(`pulse -> ${r.status}`))
            .catch((e) => padLog(`pulse ERR ${e?.message ?? e}`))
        }, 200)
      }
    }

    function spawnService() {
      const py = cfg.pyExe && fs.existsSync(cfg.pyExe) ? cfg.pyExe : 'python'
      const port = Number(new URL(base).port || 7778)
      try {
        proc = spawn(py, ['-m', 'dualsense_pad', 'serve', '--port', String(port)], {
          cwd: cfg.repoDir,
          windowsHide: true,
          stdio: 'ignore',
        })
        proc.on('exit', (code) => {
          // 服务自己退出（崩了、被外部杀了）不会走 stopService，扳机就留在手柄上。
          // 这里至少留个记录，好判断下次是不是这条路。
          padLog('service exit code=' + code + ' phase=' + phase + ' trig=' + (triggerSet || '?'))
          console.log(`[pad-touch] 服务进程退出 code=${code}`)
          proc = null
          if (phase !== 'idle') { phase = 'idle'; idleSince = Date.now() }
        })
        proc.on('error', (e) => {
          console.warn('[pad-touch] 服务起不来：' + String(e?.message ?? e))
          proc = null
          phase = 'idle'
        })
        return true
      } catch (e) {
        console.warn('[pad-touch] spawn 失败：' + String(e?.message ?? e))
        proc = null
        return false
      }
    }

    async function stopService(why) {
      padLog('stopService(' + why + ') phase=' + phase + ' trig=' + (triggerSet || '?'))
      // 先把扳机松开，而且**等回执**：扳机效果是持续状态，服务一杀它还留在
      // 手柄上，手上会一直有股没来由的阻力。
      // 这一步必须在最前面——服务可能不是我们起的（点按钮时"接管"已有的），
      // 那时 proc 是 null，不能因为没进程就跳过释放（2026-11-08 就是这么漏的）。
      if (cfg.trigger) {
        try {
          await httpJson('/trigger?off=1', 800)
          triggerSet = 'off'
          padLog('trigger off')
          // 接口返回只代表"请求收到了"。底座写线程 16ms 一拍，
          // 这里必须等那一帧真出去，否则会 4ms 后就把进程杀了（实测踩过）。
          await new Promise((r) => setTimeout(r, 150))
        } catch (e) {
          padLog('trigger off ERR ' + String(e?.message ?? e))
        }
      }
      const p = proc
      proc = null
      if (p && !p.killed) {
        try { p.kill() } catch {}
        // Windows 上 python 的子进程偶尔不肯走，补一刀（按 PID 精确点杀）
        if (p.pid) {
          setTimeout(() => {
            try { spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
          }, 800)
        }
      }
      phase = 'idle'
      idleSince = Date.now()
      armed = false
      triggerSet = ''
      console.log(`[pad-touch] 服务已停（${why || '手动'}）`)
    }

    async function toggle() {
      if (phase === 'idle') {
        phase = 'starting'
        startAt = Date.now()
        lastAt = 0
        lastPrompt = 0
        // 可能已经有服务在跑（上次没杀干净 / 手动起的）——能通就直接接管
        try {
          const h = await httpJson('/health', 900)
          if (h?.ok) { phase = 'running'; lastTouchAt = Date.now(); idleSince = Date.now(); armed = false; return phase }
        } catch {}
        if (!spawnService()) { phase = 'idle'; return phase }
        return phase
      }
      await stopService('按钮')
      return phase
    }

    /** 把攒着的一批触摸汇总成一条发出去（停手 flushMs 之后由 tick 调用） */
    async function flushTouches() {
      if (!pendingTouches.length) return
      const now = Date.now()
      if (now - lastPrompt < minIntervalMs) return
      const targetSession = liveSessionId || cfg.sessionId
      if (!targetSession) {
        padLog('skip: 没有目标会话（客户端还没上报，tuning.json 也空）')
        return
      }
      const batch = pendingTouches
      pendingTouches = []
      lastPrompt = now
      const text = describeBatch(batch)
      let delivered = false
      let lastErr = ''
      for (let attempt = 0; attempt < 3 && !delivered; attempt++) {
        try {
          await ctx.sessionController.prompt(
            {
              requestId: 'pad-' + Math.round(now) + (attempt ? '-r' + attempt : ''),
              sessionId: targetSession,
              mode: 'queue',
              content: [{ type: 'text', text }],
            },
            AbortSignal.timeout(10000),
          )
          delivered = true
        } catch (e) {
          lastErr = String(e?.message ?? e)
          padLog(`deliver fail #${attempt + 1} → ${targetSession} :: ${lastErr.slice(0, 200)}`)
          // 写句柄可能正被另一个窗口持有：等一下再试，别一条消息说丢就丢
          if (attempt < 2) await new Promise((r) => setTimeout(r, 700))
        }
      }
      // 3 秒转灰 / 5 秒关服务，从「消息真正投递完」开始算
      idleSince = Date.now()
      if (!delivered) {
        padLog('deliver GIVE UP → ' + targetSession + ' :: ' + lastErr.slice(0, 200))
        return
      }
      console.log(`[pad-touch] 投递 ${batch.length} 下 → ${targetSession}`)
    }

    let lastBeat = 0
    async function tick() {
      if (busy || disposed) return
      busy = true
      try {
        hotCfg()
        const beatNow = Date.now()
        if (beatNow - lastBeat > 10000) {
          lastBeat = beatNow
          padLog(`tick alive phase=${phase} autoOff=${autoOffMs} padUrl=${base}`)
        }
        if (phase === 'starting') {
          try {
            const h = await httpJson('/health', 900)
            if (h?.ok) {
              phase = 'running'
              lastTouchAt = Date.now()
              idleSince = Date.now()
              armed = false
              console.log('[pad-touch] 服务就绪，开始接收')
            }
          } catch {
            if (Date.now() - startAt > startWaitMs) {
              console.warn('[pad-touch] 服务启动超时，放弃')
              await stopService('启动超时')
            }
          }
          return
        }

        if (phase !== 'running') return

        // 停手够久了：把攒着的那一串汇总成一条发出去
        if (pendingTouches.length && Date.now() - lastTouchAt > flushMs) {
          await flushTouches()
        }

        // 服务还活着吗
        try {
          const h = await httpJson('/health', 900)
          if (!h?.ok) throw new Error('health false')
        } catch {
          console.log('[pad-touch] 服务没回应，回到 idle')
          await stopService('健康检查失败')
          return
        }

        // 扳机：服务一启动就准备好阻力，服务停时释放。
        // 不按「闲置就松」——保护扳机靠的是缩短服务寿命，不是中途断供。
        const wantTrigger = cfg.trigger ? cfg.triggerStart + '-' + cfg.triggerEnd : 'off'
        if (triggerSet !== wantTrigger) {
          try {
            if (wantTrigger === 'off') {
              await httpJson('/trigger?off=1', 1200)
            } else {
              await httpJson('/trigger?start=' + cfg.triggerStart + '&end=' + cfg.triggerEnd, 1200)
            }
            triggerSet = wantTrigger
            padLog('trigger ' + wantTrigger)
          } catch (e) {
            // 底座没这个接口（旧版）就算了，不挡摸头
            padLog('trigger ERR ' + String(e?.message ?? e))
            triggerSet = wantTrigger
          }
        }

        // 手指还在板上就别倒计时：事件要等 settle 秒才成形，
        // 这几秒里插件收不到任何事件，不续命的话会把正在摸的人当成空闲
        try {
          const snap = await httpJson('/state', 600)
          if (snap?.active) {
            idleSince = Date.now()
            armed = true
            lastTouchAt = Date.now()
          }
        } catch {}

        // 空闲自动关：摸过之后才倒计时；没摸过给 60 秒等待上限，防常驻
        if (armed && Date.now() - idleSince > autoOffMs) {
          await stopService('空闲超时')
          return
        }
        if (!armed && Date.now() - idleSince > 60000) {
          await stopService('等待超时')
          return
        }

        const data = await httpJson('/events')
        const events = Array.isArray(data?.events) ? data.events : []
        if (!events.length) return

        const fresh = events.filter((e) => typeof e?.at === 'number' && e.at > lastAt)
        if (!fresh.length) return

        const ev = fresh[fresh.length - 1]
        lastAt = Math.max(...fresh.map((e) => e.at))
        lastTouchAt = Date.now()
        idleSince = Date.now() // 保底：投递失败也不至于立刻关
        armed = true

        // 空手势 + 极短 = 手擦过 / 静电 / 掌缘蹭到：不亮灯、不震动、不投消息。
        // 2026-11-08 实测这种事件会连着来（dur=0.0、gesture=undefined），
        // 一次一记震动加一条消息，纯吵人。
        if (!ev.gesture && Number(ev.dur || 0) < 0.25) {
          padLog('skip empty touch dur=' + Number(ev.dur || 0).toFixed(2))
          return
        }

        paint(ev.gesture)

        // 攒着：停手 flushMs 之后由 tick 汇总成一条发出去，别一下一条烧 token
        pendingTouches.push(ev)
        if (pendingTouches.length > 300) pendingTouches.shift()
        idleSince = Date.now()
      } catch (err) {
        // 网络抖动 / 服务刚起：记一笔，别再一声不吭
        padLog('tick ERR ' + String(err?.message ?? err))
      } finally {
        busy = false
      }
    }

    // ── HTTP 路由 ────────────────────────────────────────────────
    const disposers = []
    function rejected(req, res) {
      if (!isLoopbackReq(req)) { json(res, 403, { ok: false, error: '只接受本机回环访问' }); return true }
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') return false
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch {
        return false
      }
    }

    function route(pathname, handler) {
      try {
        disposers.push(ctx.webServer.register({
          kind: 'exact',
          path: pathname,
          handler: async (req, res) => {
            if (rejected(req, res)) return
            try { await handler(req, res) } catch (err) {
              try { json(res, 500, { ok: false, error: String(err?.message ?? err) }) } catch {}
            }
          },
        }))
      } catch (e) {
        console.warn('[pad-touch] 路由注册失败：' + String(e?.message ?? e))
      }
    }

    route('/dsh-pad/api/state', async (req, res) => {
      const remain = phase === 'running' ? Math.max(0, autoOffMs - (Date.now() - idleSince)) : 0
      json(res, 200, {
        ok: true,
        phase,
        remainMs: remain,
        lastTouchAt,
        sessionId: cfg.sessionId,
        liveSessionId,
        liveSessionVia,
        targetSession: liveSessionId || cfg.sessionId,
      })
    })

    /** 客户端报「我现在看的是哪个会话」——换窗口它就重报，投递跟着走 */
    route('/dsh-pad/api/session', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const body = await readBody(req)
      const id = String(body?.sessionId ?? '').trim()
      const via = String(body?.via ?? '').trim()
      const probe = Array.isArray(body?.probe) ? body.probe : []
      const page = String(body?.page ?? '').trim().slice(0, 12)
      if (!id) {
        // 探测失败也留证据：下次就知道客户端在页面上到底看到了什么
        padLog('session probe EMPTY page=' + (page || '?') + ' via=' + (via || '?') + ' :: ' + probe.join(' | ').slice(0, 1500))
        json(res, 200, { ok: true, accepted: false })
        return
      }
      const changed = id !== liveSessionId
      liveSessionId = id
      liveSessionVia = via
      liveSessionAt = Date.now()
      if (changed) {
        padLog('session live=' + id + ' via=' + (via || '?') + ' page=' + (page || '?'))
        console.log('[pad-touch] 当前会话 → ' + id + '（' + (via || '?') + '）')
      }
      json(res, 200, { ok: true, accepted: true, sessionId: liveSessionId })
    })

    route('/dsh-pad/api/toggle', async (req, res) => {
      if (req.method !== 'POST') { json(res, 405, { ok: false }); return }
      const next = await toggle()
      const remain = next === 'running' ? autoOffMs : 0
      json(res, 200, { ok: true, phase: next, remainMs: remain })
    })

    timer = setInterval(() => { tick().catch(() => {}) }, Math.max(300, Number(cfg.pollMs) || 1000))
    console.log(`[pad-touch] 已启动（按需模式）：点按钮 → 拉起 ${cfg.pyExe} → 空闲 ${Math.round(autoOffMs / 1000)}s 自动停`)

    ctx.effect(() => () => {
      disposed = true
      if (timer) clearInterval(timer)
      for (const d of disposers) { try { d() } catch {} }
      // 插件卸载（重载 / DSH 重启）时来不及 await，异步请求会被直接丢掉，
      // 服务被杀掉、扳机阻力却留在手柄上。这里用**同步**请求把扳机松开。
      if (cfg.trigger) {
        try {
          execSync(`curl -s -m 1 "${base}/trigger?off=1"`, { stdio: 'ignore', windowsHide: true })
          triggerSet = 'off'
        } catch {}
      }
      stopService('插件卸载')
    })
  },
}
