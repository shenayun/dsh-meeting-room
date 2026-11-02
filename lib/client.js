/**
 * dsh-meeting-room —— 浏览器那半边
 *
 * 两块界面：
 *   ① 设置页「会议室」一栏（独立的一栏，不跟阿鲸混在一起）：名单、总闸、加人、改名、移除
 *   ② 对话区输入框下面一条 + 右侧抽屉：开/关、每位顾问的开关、他们刚才说了什么（全文）
 */
window.__ModuleLoader__.load({
  id: 'dsh-meeting-room',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/api/meeting-room'

    // 内置的几家（只做 OpenAI 兼容）。地址写到 /v1 为止；写不写后端都认。
    const PROVIDERS = [
      { id: 'workbuddy', name: '本机网关（WorkBuddyManager）', base: 'http://127.0.0.1:7864/v1' },
      { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1' },
      { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1' },
      { id: 'moonshot', name: 'Kimi / Moonshot', base: 'https://api.moonshot.cn/v1' },
      { id: 'zhipu', name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4' },
      { id: 'custom', name: '自定义（自己填地址）', base: '' },
    ]

    const jget = async () => {
      const r = await fetch(API, { credentials: 'same-origin' })
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    }
    const jpost = async (body) => {
      const r = await fetch(API, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status))
      return j
    }

    const CSS = `
[data-mr-page]{display:flex;flex-direction:column;gap:14px;padding:2px 2px 8px;max-width:620px;}
[data-mr-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-mr-row]{display:flex;align-items:center;gap:10px;}
[data-mr-grow]{flex:1;min-width:0;}
[data-mr-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-mr-note][data-warn]{color:#d97706;}
[data-mr-in]{box-sizing:border-box;padding:5px 8px;border-radius:6px;font-size:12px;
  border:1px solid var(--dsw-alias-border-default,rgba(128,128,128,.28));background:transparent;color:inherit;}
[data-mr-btn]{padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px;
  border:1px solid var(--dsw-alias-border-default,rgba(128,128,128,.28));background:transparent;color:inherit;}
[data-mr-btn]:disabled{opacity:.45;cursor:default;}
[data-mr-warn]{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:8px;
  background:rgba(217,119,6,.10);border:1px solid rgba(217,119,6,.35);font-size:12px;line-height:18px;}
[data-mr-k]{font-size:12px;}
[data-mr-v]{font-size:11px;font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-mr-dot]{width:7px;height:7px;border-radius:50%;flex:none;box-sizing:border-box;
  background:transparent;border:1.5px solid #9aa0a6;}
[data-mr-dot][data-on]{background:#16a34a;border-color:#16a34a;}
[data-mr-bar]{position:relative;display:flex;align-items:center;gap:8px;margin:2px 0 4px;}
/* 2026-11-02 删：[data-mr-last]。原来这儿吊着一行「谁：说了什么…」的摘要，
   把宿主的「13 轮 78 步 / 8.2M tok / 缓存命中」一路挤到边上去了。
   P老师原话：「对话框下面就不要出现说话内容了，你看把上下文和其他的都挤到哪里去了」。
   摘要要看就进抽屉看，对话框下面只留一个按钮。 */
/* 抽屉：默认钉在右边（上下留边，别盖住按钮和输入框），拖标题栏就变浮动，点 ⌖ 回边上去。
   2026-11-02 三改：440 太宽 → 300；贴死上下会盖住边栏 → 上下留边；「能做浮动的么」→ 可拖。 */
[data-mr-panel]{position:fixed;z-index:800;width:min(300px,86vw);
  max-height:calc(100vh - 160px);height:calc(100vh - 160px);
  overflow:hidden;padding:12px 12px 12px;display:flex;flex-direction:column;gap:8px;
  border-radius:10px;
  background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-default,rgba(128,128,128,.28));
  box-shadow:0 14px 40px rgba(0,0,0,.22);}
/* 只有这一块滚：控制区钉住，发言区自己滚 */
[data-mr-body]{flex:1;min-height:0;overflow:auto;padding-right:2px;}
[data-mr-chips]{display:flex;flex-wrap:wrap;gap:6px;}
[data-mr-chip]{padding:3px 10px;border-radius:999px;font-size:12px;cursor:pointer;
  border:1.5px solid var(--dsw-alias-border-default,rgba(128,128,128,.35));background:transparent;color:inherit;}
[data-mr-chip]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));}
[data-mr-chip][data-on]{border-color:var(--c,#16a34a);color:var(--c,#16a34a);background:transparent;}
/* 2026-11-02：每位顾问一个固定颜色（存在 config 里，不按顺序算），胶囊、名字、发言框都用它。 */
[data-mr-head]{display:flex;align-items:center;gap:8px;cursor:move;user-select:none;
  padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-default,rgba(128,128,128,.18));}
[data-mr-x]{margin-left:auto;padding:2px 9px;border-radius:6px;cursor:pointer;font-size:14px;
  border:1px solid var(--dsw-alias-border-default,rgba(128,128,128,.28));background:transparent;color:inherit;}
[data-mr-say]{white-space:pre-wrap;font-size:12px;line-height:1.6;padding:9px 11px;border-radius:7px;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08));}`

    function useState2(init) { return React.useState(init) }

    // ———— 设置页 ————
    function Panel() {
      const [st, setSt] = useState2(null)
      const [err, setErr] = useState2('')
      const [note, setNote] = useState2('')
      const [busy, setBusy] = useState2('')
      const [keyDraft, setKeyDraft] = useState2('')
      const [providerId, setProviderId] = useState2('workbuddy')
      const [baseDraft, setBaseDraft] = useState2(PROVIDERS[0].base)
      const [modelDraft, setModelDraft] = useState2('')
      const [models, setModels] = useState2([])
      const [probing, setProbing] = useState2(false)
      const [renaming, setRenaming] = useState2('')
      const [rnDraft, setRnDraft] = useState2('')

      const load = React.useCallback(async () => {
        try { setSt(await jget()); setErr('') } catch (e) { setErr(String(e.message || e)) }
      }, [])
      React.useEffect(() => { load() }, [load])

      const act = async (body, msg) => {
        setBusy(body.action + ':' + (body.name || ''))
        try {
          await jpost(body)
          if (msg) setNote(msg)
          await load()
          return true
        } catch (e) {
          setNote('没成：' + String(e.message || e))
          return false
        } finally { setBusy('') }
      }

      if (err) return h('div', { 'data-mr-page': '' },
        h('div', { 'data-mr-note': '', 'data-warn': '' }, '读不到：' + err),
        h('div', { 'data-mr-note': '' }, '接口没挂上？看 ~/.dsh/meeting-room/meeting-room.log。'))
      if (!st) return h('div', { 'data-mr-note': '' }, '读着…')

      const hall = st.hall || {}
      const guests = st.guests || []

      return h('div', { 'data-mr-page': '' },
        h('div', { 'data-mr-note': '' }, '会议室是请几位外部大模型坐到一张桌子上。你说一句、回完，他们按顺序接着说；你不叫，他们一个字都不会说。'),
        h('div', { 'data-mr-note': '' }, '用法三步：先在下面把人请进来；然后打开「开始开会」；之后照常跟我说话就行——每次我答完你的话，他们会挨个接一句。这一场不想让谁开口，点他那行让他闭嘴。'),
        h('div', { 'data-mr-note': '' },
          '人可以加很多（不同的事请不同的人），但一桌最多坐 ' + String(st.seatCap ?? 6) + ' 位——加上我正好七个，再多就听不清了。'),

        // 总闸
        h('div', { 'data-mr-row': '' },
          h('div', { 'data-mr-grow': '' },
            h('div', { 'data-mr-k': '' }, '开始开会'),
            h('div', { 'data-mr-note': '' }, '打开以后，每次我答完你的话，他们会按顺序各说一句。')),
          h('button', {
            'data-mr-btn': '',
            disabled: busy.startsWith('hall-toggle'),
            onClick: () => act({ action: 'hall-toggle', enabled: !hall.stored }, hall.stored ? '总闸关了' : '总闸开了'),
          }, hall.stored ? '关上' : '打开')),

        h('div', { 'data-mr-note': '', 'data-warn': '' },
          '花的是他们各家的钱：每说一轮，每位顾问都要调一次接口，按你自己在那些平台的账户扣。这里看不到他们还剩多少额度。'),

        // 名单
        h('div', { 'data-mr-h': '' }, '顾问名单'),
        guests.length ? guests.map((g) => h('div', { 'data-mr-row': '', key: g.name, style: { padding: '3px 0' } },
          h('span', { 'data-mr-dot': '', 'data-on': g.on ? '' : undefined }),
          h('div', { 'data-mr-grow': '' },
            renaming === g.name
              ? h('input', {
                  'data-mr-in': '', value: rnDraft, placeholder: g.name,
                  onChange: (e) => setRnDraft(e.target.value),
                  style: { width: '140px' },
                })
              : h('div', { 'data-mr-k': '' }, g.name),
            h('div', { 'data-mr-v': '' }, g.model + ' · ' + g.keyMask)),
          renaming === g.name
            ? h('span', { style: { display: 'flex', gap: '6px' } },
                h('button', { 'data-mr-btn': '', onClick: async () => {
                  await act({ action: 'guest-rename', name: g.name, to: rnDraft }, '改叫：' + rnDraft)
                  setRenaming('')
                } }, '存'),
                h('button', { 'data-mr-btn': '', onClick: () => { setRenaming(''); setRnDraft('') } }, '算了'))
            : h('button', { 'data-mr-btn': '', onClick: () => { setRenaming(g.name); setRnDraft(g.name) } }, '改名'),
          renaming === g.name ? null : h('button', {
            'data-mr-btn': '', style: { color: '#d97706' },
            onClick: () => act({ action: 'guest-del', name: g.name }, '请走了：' + g.name),
          }, '移除'),
          renaming === g.name ? null : h('button', {
            'data-mr-btn': '',
            onClick: () => act({ action: 'guest-toggle', name: g.name, on: !g.on }),
          }, g.on ? '闭嘴' : '开口')))
          : h('div', { 'data-mr-note': '' }, '还没有人。下面贴一条 key 就能请进来。'),

        // 加人：2026-11-02 改成 DSH 那种姿势——选提供商 / 填地址 / 填 key / 拿模型列表。
        // 原来「只填 key 模型自动认」是依赖本机网关把 key 绑到单个模型，换个人用就废了。
        h('div', { 'data-mr-h': '', style: { marginTop: '8px' } }, '请一位顾问'),
        // 从 DSH 已配的模型里挑：能拿到地址和模型名，key 还得自己填（profile 里只有环境变量名）。
        (st.dshModels || []).length ? h('div', { 'data-mr-row': '' },
          h('select', {
            'data-mr-in': '', style: { flex: '1', minWidth: '160px' }, value: '',
            onChange: (e) => {
              const v = e.target.value
              if (!v) return
              const [pi, mi] = v.split('|').map(Number)
              const prov = (st.dshModels || [])[pi]
              if (!prov || !prov.models[mi]) return
              setBaseDraft(prov.baseURL)
              setModelDraft(prov.models[mi].id)
              setModels([])
              setNote('从 DSH 挑了：' + prov.displayName + ' / ' + prov.models[mi].id + '（还差一条 key）')
            },
          },
            h('option', { value: '' }, '从 DSH 已配的模型里挑（可选）'),
            ...(st.dshModels || []).flatMap((p, pi) => p.models.map((m, mi) =>
              h('option', { key: pi + '-' + mi, value: pi + '|' + mi },
                p.displayName + ' · ' + (m.name || m.id)))))) : null,
        h('div', { 'data-mr-row': '' },
          h('select', {
            'data-mr-in': '', style: { flex: '1', minWidth: '140px' },
            value: providerId,
            onChange: (e) => {
              const id = e.target.value
              setProviderId(id)
              const p = PROVIDERS.find((x) => x.id === id)
              if (p && p.base) setBaseDraft(p.base)
              setModels([])
            },
          }, PROVIDERS.map((p) => h('option', { key: p.id, value: p.id }, p.name)))),
        h('div', { 'data-mr-row': '' },
          h('input', {
            'data-mr-in': '', placeholder: 'API 地址（到 /v1 为止）',
            value: baseDraft, onChange: (e) => setBaseDraft(e.target.value),
            style: { flex: '1', minWidth: '160px' },
          })),
        h('div', { 'data-mr-row': '' },
          h('input', {
            'data-mr-in': '', placeholder: 'API 密钥', type: 'password',
            value: keyDraft, onChange: (e) => setKeyDraft(e.target.value),
            style: { flex: '1', minWidth: '140px' },
          }),
          h('button', {
            'data-mr-btn': '',
            disabled: !keyDraft.trim() || !baseDraft.trim() || probing,
            onClick: async () => {
              setProbing(true)
              setNote('')
              try {
                const j = await jpost({ action: 'probe-models', base: baseDraft, key: keyDraft })
                setModels(j.models || [])
                if ((j.models || []).length === 1) setModelDraft(j.models[0])
                setNote((j.models || []).length ? '拿到 ' + j.models.length + ' 个模型' : '没列出来，手填模型名也行')
              } catch (e) {
                setModels([])
                setNote(String(e.message || e))
              } finally { setProbing(false) }
            },
          }, probing ? '探…' : '获取模型')),
        h('div', { 'data-mr-row': '' },
          models.length
            ? h('select', {
                'data-mr-in': '', style: { flex: '1', minWidth: '160px' },
                value: modelDraft, onChange: (e) => setModelDraft(e.target.value),
              }, h('option', { value: '' }, '选一个模型'), models.map((m) => h('option', { key: m, value: m }, m)))
            : h('input', {
                'data-mr-in': '', placeholder: '模型名（拿不到列表就手填）',
                value: modelDraft, onChange: (e) => setModelDraft(e.target.value),
                style: { flex: '1', minWidth: '160px' },
              }),
          h('button', {
            'data-mr-btn': '', disabled: !keyDraft.trim() || !baseDraft.trim() || busy.startsWith('guest-add'),
            onClick: async () => {
              const body = { action: 'guest-add', key: keyDraft, base: baseDraft, model: modelDraft }
              const ok = await act(body, '请进来了')
              if (ok) {
                setKeyDraft(''); setModelDraft(''); setModels([])
              }
            },
          }, busy.startsWith('guest-add') ? '加…' : '添加')),
        h('div', { 'data-mr-note': '' },
          '只支持 OpenAI 兼容协议（Anthropic 的消息格式不一样，暂不支持）。地址写到 /v1 为止，写不写都认。'),
        h('div', { 'data-mr-note': '' },
          '模型这一栏：能列出列表就选，列不出来就直接手填（很多中转站不给列表）。'),

        h('div', { 'data-mr-note': '' }, '名单、聊天记录都存在这台电脑上，不上传。API key 是明文存的——这台机器借给别人的时候记得清掉。'),
        h('div', { 'data-mr-note': '' },
          'v' + String(st.version || '?') + ' · 轮次钩子：' + (st.hook === 'ok' ? '在' : String(st.hook))),
        note ? h('div', { 'data-mr-note': '', 'data-warn': '' }, note) : null)
    }

    // ———— 对话区那一条 + 抽屉 ————
    function Bar() {
      const [st, setSt] = useState2(null)
      const [open, setOpen] = useState2(false)
      const [asking, setAsking] = useState2(false)
      const [note, setNote] = useState2('')
      // pos = null 表示「钉在右边」；拖动标题栏会变成浮动，点 ⌖ 回到钉边。
      const [pos, setPos] = useState2(null)
      const drag = React.useRef(null)
      // 自动滚动：贴着底就跟到底；用户往上翻了就停下（别抢他正在看的位置）。
      const panelRef = React.useRef(null)
      const bodyRef = React.useRef(null)
      const [stick, setStick] = useState2(true)
      // 翻更早：点一次往前拉 10 轮，插在现有内容上面。
      const [extra, setExtra] = useState2([])
      // 初始就认为「可能还有更早的」——没点过之前不该告诉人家「没有了」。
      const [hasMore, setHasMore] = useState2(true)
      const [loadingMore, setLoadingMore] = useState2(false)
      // 2026-11-02 改：本次 / 上次 / 更早 分开摆，新话题一来旧内容默认收起来。
      // 起因：跑团那十几轮全摊在面板里，新话题夹在最下面，P老师原话「我都不知道去哪找你们说了啥」。
      const [showPrev, setShowPrev] = useState2(false)
      const [showOlder, setShowOlder] = useState2(false)
      const lastKey = (st && st.hall && st.hall.last) ? String(st.hall.last.ts || st.hall.last.q || '') : ''
      React.useEffect(() => {
        // 换话题了：上次那块收起来，翻出来的更早也清掉，回到最干净的样子。
        setShowPrev(false); setShowOlder(false); setExtra([])
      }, [lastKey])

      // 拖动：标题栏按下开始，全局监听移动，松手结束。
      React.useEffect(() => {
        const move = (e) => {
          if (!drag.current) return
          const box = drag.current
          const w = box.w, h = box.h
          let x = e.clientX - box.dx
          let y = e.clientY - box.dy
          x = Math.max(8, Math.min(window.innerWidth - w - 8, x))
          y = Math.max(8, Math.min(window.innerHeight - h - 8, y))
          setPos({ x, y })
        }
        const up = () => { drag.current = null }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
        return () => {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
      }, [])

      const startDrag = (e) => {
        const el = e.currentTarget.closest('[data-mr-panel]')
        if (!el) return
        const r = el.getBoundingClientRect()
        drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top, w: r.width, h: r.height }
        e.preventDefault()
      }

      const load = React.useCallback(async () => {
        try { setSt(await jget()) } catch {}
      }, [])
      React.useEffect(() => {
        load()
        const t = setInterval(load, 4000)
        return () => clearInterval(t)
      }, [load])

      // 新内容来了：只在「贴着底」的时候滚到底。
      React.useEffect(() => {
        const el = bodyRef.current
        if (!el || !stick) return
        el.scrollTop = el.scrollHeight
      }, [st, stick, open])

      const act = async (body) => {
        try { await jpost(body); setNote(''); await load() }
        catch (e) { setNote(String(e.message || e)) }
      }

      const hall = st && st.hall
      if (!hall || !hall.count) return null   // 没有顾问，整条不出现

      const guests = st.guests || []
      const onCount = guests.filter((g) => g.on).length
      // 按名字取该顾问的固定颜色。查不到就退回灰——颜色只是记号，缺了不能瞎给。
      const colorOf = (n) => {
        const g = guests.find((x) => String(x.name) === String(n))
        return (g && g.color) || '#9aa0a6'
      }
      const label = !hall.stored ? '关' : (onCount ? onCount + ' 位顾问' : '全闭嘴')

      // 钉边：右边贴住、上下留边（别盖住按钮和输入框）。
      // 浮动：位置由拖动决定，宽高固定。
      const panelStyle = pos
        ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
        : { right: '16px', top: '76px', bottom: '132px', left: 'auto' }

      // 面板要显示的那几轮：有 recent 用 recent，只有 last 就包成一轮。
      const baseRounds = (hall.recent && hall.recent.length)
        ? hall.recent
        : (hall.last && hall.last.a && hall.last.a.length ? [{ q: hall.last.q, a: hall.last.a }] : [])
      const rounds = extra.length ? [...extra, ...baseRounds] : baseRounds

      // 拉更早的一批：以当前最上面那条的时间和内容当游标。
      const loadMore = async () => {
        if (loadingMore) return
        setLoadingMore(true)
        try {
          const oldest = rounds.length ? rounds[0] : null
          const j = await jpost({ action: "history", limit: 10, before: oldest ? oldest.ts : "" })
          const got = (j.rounds || []).filter((r) => !rounds.some((x) => x.ts === r.ts && x.q === r.q))
          setExtra((prev) => [...got, ...prev])
          setHasMore(Boolean(j.hasMore))
        } catch (e) { setNote(String(e.message || e)) }
        finally { setLoadingMore(false) }
      }

      return h('div', { 'data-mr-bar': '' },
        h('button', { 'data-mr-btn': '', onClick: () => setOpen((o) => !o) },
          (open ? '▾ ' : '▸ ') + '会议室 · ' + label),

        open ? h('div', { 'data-mr-panel': '', style: panelStyle },
          // ———— 头：钉住，不跟着滚 ————
          h('div', { 'data-mr-head': '', onMouseDown: startDrag, title: '拖我换位置' },
            h('div', { 'data-mr-k': '', style: { fontSize: '13px', fontWeight: 600 } }, '会议室'),
            pos ? h('button', { 'data-mr-x': '', onMouseDown: (ev) => ev.stopPropagation(), onClick: () => setPos(null), title: '贴回右边' }, '⌖') : null,
            h('button', { 'data-mr-x': '', onMouseDown: (ev) => ev.stopPropagation(), onClick: () => setOpen(false), title: '收起' }, '×')),

          h('div', { 'data-mr-row': '' },
            h('div', { 'data-mr-grow': '' },
              h('div', { 'data-mr-k': '' }, '开始开会'),
              h('div', { 'data-mr-note': '' }, '打开后，每次我答完你的话，开着的顾问按顺序各说一句。')),
            h('button', {
              'data-mr-btn': '',
              onClick: () => { if (!hall.stored) { setAsking(true); return } act({ action: 'hall-toggle', enabled: false }) },
            }, hall.stored ? '关上' : '打开')),

          asking ? h('div', { 'data-mr-warn': '' },
            h('div', {}, '开会花的是他们的钱。'),
            h('div', { 'data-mr-note': '' }, '每说一轮，每位顾问都要调一次接口，按你自己在那些平台的账户扣。这里看不到他们还剩多少。'),
            h('div', { 'data-mr-row': '' },
              h('button', { 'data-mr-btn': '', onClick: async () => {
                await act({ action: 'hall-toggle', enabled: true }); setAsking(false)
              } }, '知道了，开'),
              h('button', { 'data-mr-btn': '', onClick: () => setAsking(false) }, '算了'))) : null,

          // 顾问压成胶囊：点一下切换开口，绿框 = 开着。鼠标停上去看模型名。
          h('div', { 'data-mr-chips': '' },
            ...guests.map((g) => h('button', {
              key: g.name, 'data-mr-chip': '', 'data-on': g.on ? '' : undefined,
              style: g.color ? { '--c': g.color } : undefined,
              title: g.model + (g.on ? '（正在说话，点一下让他闭嘴）' : '（没开口，点一下让他说）'),
              onClick: () => act({ action: 'guest-toggle', name: g.name, on: !g.on }),
            }, g.name))),

          h('div', { 'data-mr-row': '' },
            h('button', { 'data-mr-btn': '', onClick: () => act({ action: 'hall-mute-all', muted: !hall.muted }) },
              hall.muted ? '全部恢复' : '全部闭嘴'),
            h('div', { 'data-mr-note': '' }, hall.muted ? '现在就你跟我。想放谁进来，点他那个框。' : '')),

          // ———— 发言区：只有这一块滚 ————
          h('div', {
            'data-mr-body': '',
            ref: bodyRef,
            onScroll: (ev) => {
              const el = ev.currentTarget
              setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
            },
          },
            // 发言区：本次摊开、上次与更早收起。
            // 2026-11-02 加：正在问的那一轮也要**边跑边显示**——一轮要跑一两分钟，
            // 中间面板空着，P老师的原话是「我依旧看不到你实时发的消息，也看不到回答」。
            (hall.live || rounds.length) ? (() => {
              const live = hall.live
              const brief = (r) => String(r.q || '').replace(/\s+/g, ' ').slice(0, 24)
              const say = (r) => h('div', { style: { marginTop: '6px' } },
                h('div', { 'data-mr-say': '' }, String(r.q || '')),
                ...(r.a || []).map((a, i) => {
                  const c = colorOf(a.name)
                  return h('div', { key: 'a' + i, style: { marginTop: '10px' } },
                    h('div', { 'data-mr-k': '', style: { marginBottom: '4px', color: c, fontWeight: 600 } },
                      a.name + ' · ' + String(a.answer || '').length + ' 字'),
                    h('div', { 'data-mr-say': '', style: { borderLeft: '3px solid ' + c } }, String(a.answer || '')))
                }))
              // 有 live 时，recent 最后一条就是「上次」；没有 live 时最后一条是「本次」。
              const cur = live ? null : rounds[rounds.length - 1]
              const prevRound = live ? (rounds.length ? rounds[rounds.length - 1] : null) : (rounds.length > 1 ? rounds[rounds.length - 2] : null)
              const olderRounds = live ? rounds.slice(0, Math.max(0, rounds.length - 1)) : rounds.slice(0, Math.max(0, rounds.length - 2))
              return h('div', {},
                // ———— 进行中：说一位显示一位 ————
                live ? h('div', {},
                  h('div', { 'data-mr-note': '', style: { margin: '0 0 2px' } },
                    '正在问 · 已说 ' + ((live.done || []).length) + '/' + ((live.order || []).length) + ' 位'),
                  h('div', { 'data-mr-say': '' }, String(live.q || '')),
                  ...(live.done || []).map((a, i) => {
                    const c = colorOf(a.name)
                    return h('div', { key: 'l' + i, style: { marginTop: '10px' } },
                      h('div', { 'data-mr-k': '', style: { marginBottom: '4px', color: c, fontWeight: 600 } },
                        a.name + (a.ok ? ' · ' : ' · 没答上 · ') + String(a.answer || '').length + ' 字'),
                      h('div', { 'data-mr-say': '', style: { borderLeft: '3px solid ' + c } }, String(a.answer || '')))
                  })) : null,
                // ———— 本次：永远摊开，不折叠 ————
                cur ? h('div', { style: { marginTop: live ? '16px' : '0' } },
                  h('div', { 'data-mr-note': '', style: { margin: '0 0 2px' } }, '本次（' + String(cur.q || '').length + ' 字）'),
                  say(cur)) : null,
                // ———— 上次：默认收起，点标题才展开 ————
                prevRound ? h('div', { style: { marginTop: '16px' } },
                  h('button', { 'data-mr-btn': '', onClick: () => setShowPrev((v) => !v) },
                    (showPrev ? '▾ ' : '▸ ') + '上次：' + brief(prevRound) + (String(prevRound.q || '').length > 24 ? '…' : '')),
                  showPrev ? say(prevRound) : null) : null,
                // ———— 更早：也收起，点开才看 ————
                (olderRounds.length || hasMore) ? h('div', { style: { marginTop: '10px' } },
                  h('button', { 'data-mr-btn': '', onClick: () => setShowOlder((v) => !v) },
                    (showOlder ? '▾ ' : '▸ ') + '更早的 ' + olderRounds.length + ' 轮'),
                  showOlder ? h('div', {},
                    ...olderRounds.map((r, i) => h('div', { key: 'o' + i, style: { marginTop: '14px' } }, say(r))),
                    h('button', { 'data-mr-btn': '', disabled: loadingMore, onClick: loadMore },
                      loadingMore ? '翻…' : (hasMore ? '加载更早' : '再往前没有了'))) : null) : null)
            })()
              : h('div', { 'data-mr-note': '' }, '还没说过话。开开会、聊一句，他们就接上了。')),

          note ? h('div', { 'data-mr-note': '', 'data-warn': '' }, note) : null) : null)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-meeting-room')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-meeting-room: 样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return

        // 设置页：自己一栏，不跟阿鲸混
        try {
          slots.inject('settings.section', () => slots.register(
            { name: 'settings.section', id: 'dsh-meeting-room', order: 43, label: '会议室' },
            () => h(Panel),
          ))
        } catch (e) {
          try { console.warn('[dsh-meeting-room] 设置页没挂上：' + String(e && e.message ? e.message : e)) } catch {}
        }

        // 对话区那一条
        try {
          slots.inject('conversation.composer.dock', () => slots.register(
            { name: 'conversation.composer.dock', id: 'dsh-meeting-room-bar', order: 30 },
            () => h(Bar),
          ))
        } catch (e) {
          try { console.warn('[dsh-meeting-room] 面板没挂上：' + String(e && e.message ? e.message : e)) } catch {}
        }
      },
    }
  },
})
