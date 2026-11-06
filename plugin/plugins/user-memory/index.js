/**
 * user-memory — 按人记忆（id: 'user-memory'，order: 95）
 *
 * 一个人两套东西：
 *   A. 长期画像：`users/<QQ>.md`（人可读的 Markdown，模型用 user_memory op=read 才看正文）
 *   B. 短期流水：**四份文件** `users/<QQ>.{group|private}.{read|unread}.jsonl`
 *      —— 群聊/私聊 × 读过/没读过。为什么分四份：读文件只能整份读，一份里打 read 标记等于假装分开了。
 *
 * 纪律（踩出来的，别改）：
 *  ① **只给指针**：普通回合不贴记忆正文（拼进用户消息会被当成群友说的话）。例外是 config 的
 *     `injectChats` 名单里那些私聊——那里会把画像 + 最近几句塞进提示词。
 *  ② 流水按 gid 过滤再注入：两份未读都写（群聊/私聊各记一笔），注入时只取本轮这个会话的，
 *     不然别人的话会串台。
 *  ③ 读完立刻并仓（unread → read）：不并的话下一轮会把同一批话再贴一遍，模型会照着重做一遍
 *     （「重启」被执行两次就是这么来的）。
 *  ④ 负面情绪、骂人、提示词注入不落库。
 */
import fs from 'node:fs'
import path from 'node:path'

const FLOW_SCOPES = ['group', 'private']
const FLOW_STATES = ['read', 'unread']
const UNREAD_CAP = 400
// 已读流水保留条数：私聊 2000（主人 2026-10-27 定），群聊同档
const READ_KEEP = { private: 2000, group: 2000 }
// 群流水（每群一份，所有人所有消息）上限
const GROUP_FLOW_CAP = 10000

export default {
  id: 'user-memory',
  title: '按人记忆',
  order: 95,

  configSchema: {
    enabled: { type: 'bool', default: true, group: '按人记忆', label: '按人记忆', hint: '关：不记流水、不注入画像。' },
    dir: { type: 'str', default: 'qq-users', group: '按人记忆', label: '数据目录', hint: '相对路径按数据目录解析；画像与流水都在这里（users/ 子目录放个人文件）。' },
    lastN: { type: 'int', default: 10, min: 1, max: 100, step: 1, group: '按人记忆', label: '注入最近几条', hint: 'injectChats 名单里的私聊，每轮带多少条最近对话。' },
    maxChars: { type: 'int', default: 1200, min: 200, max: 8000, step: 100, group: '按人记忆', label: '画像注入上限（字）', hint: '画像正文截到多少字。' },
    injectChats: {
      type: 'group', default: [], group: '按人记忆', label: '每轮注入记忆的私聊',
      hint: '填 QQ 号：这些人的私聊每轮把「她的画像 + 最近几句」直接塞进提示词（其余私聊只给指针）。',
    },
  },

  setup(bot) {
    const cfg = bot.cfg || {}
    const log = bot.log
    const dataDirOf = () => String(bot.core?.dataDir || '.')
    const rootOf = () => {
      const d = String(cfg.dir || '').trim() || 'qq-users'
      return path.isAbsolute(d) ? d : path.join(dataDirOf(), d)
    }
    const usersOf = () => path.join(rootOf(), 'users')

    function ensureDirs() {
      try { fs.mkdirSync(usersOf(), { recursive: true }) } catch { /* 目录没了就等下一轮 */ }
    }

    // 流水带时间：落库存一份可读的，注入时也带上（主人 2026-10-27 定）
function stampOf(t) {
  const d = new Date(Number(t) || Date.now())
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const isQq = (v) => /^\d{4,12}$/.test(String(v || ''))
    const scopeOfKey = (chatKey, gid) => (String(chatKey || '').startsWith('private:') ? 'private' : (/^\d{4,12}$/.test(String(gid || '')) ? 'group' : (String(chatKey || '').startsWith('group:') ? 'group' : 'private')))
    const fileOf = (qq, scope, state) => path.join(usersOf(), `${qq}.${scope}.${state}.jsonl`)
    const profileOf = (qq) => path.join(usersOf(), `${qq}.md`)

    function readRows(file, limit = 0) {
      let text = ''
      try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
      const rows = []
      for (const line of text.split('\n')) {
        const s = line.trim()
        if (!s) continue
        try { rows.push(JSON.parse(s)) } catch { /* 坏行跳过 */ }
      }
      return limit > 0 ? rows.slice(-limit) : rows
    }

    function appendRow(file, row, cap = 0) {
      ensureDirs()
      try {
        fs.appendFileSync(file, `${JSON.stringify(row)}\n`)
        if (cap > 0) {
          const rows = readRows(file)
          if (rows.length > cap) fs.writeFileSync(file, rows.slice(-cap).map((r) => JSON.stringify(r)).join('\n') + '\n')
        }
      } catch (e) { log.warn(`[按人记忆] 写流水失败: ${e.message}`) }
    }

    /** 未读并进已读（只并本 scope 那一对），已读超上限时裁掉最旧的。 */
    function mergeFlow(qq, scope) {
      const un = fileOf(qq, scope, 'unread')
      const rd = fileOf(qq, scope, 'read')
      const rows = readRows(un)
      if (!rows.length) return { ok: true, merged: 0 }
      try {
        ensureDirs()
        fs.appendFileSync(rd, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
        fs.writeFileSync(un, '')
        const keep = readRows(rd)
        const cap = READ_KEEP[scope] || 2000
        if (keep.length > cap) {
          const bak = path.join(rootOf(), 'backup')
          try { fs.mkdirSync(bak, { recursive: true }) } catch { /* ignore */ }
          try { fs.writeFileSync(path.join(bak, `${qq}.${scope}.read.${Date.now()}.jsonl.bak`), keep.map((r) => JSON.stringify(r)).join('\n') + '\n') } catch { /* ignore */ }
          fs.writeFileSync(rd, keep.slice(-cap).map((r) => JSON.stringify(r)).join('\n') + '\n')
        }
      } catch (e) {
        log.warn(`[按人记忆] 并仓失败: ${e.message}`)
        return { ok: false, error: e.message }
      }
      log.debug(`[按人记忆] 并仓 ${qq} ${scope} +${rows.length}`)
      return { ok: true, merged: rows.length }
    }

    function ensureFlows(qq) {
      if (!isQq(qq)) return { ok: false, error: 'qq 必须是 4-12 位数字' }
      ensureDirs()
      for (const scope of FLOW_SCOPES) {
        for (const state of FLOW_STATES) {
          const f = fileOf(qq, scope, state)
          try { fs.writeFileSync(f, '', { flag: 'wx' }) } catch { /* 已存在 */ }
        }
      }
      return { ok: true }
    }

    // 只有「真的回了这个人」才把它的未读并仓：before-turn 只记待并，出站那一刻才并
    const pendingMerge = new Map() // chatKey -> { qq, scope }
    // 脏话/攻击类不进库（宁可漏记）
    const SKIP_RE = /(操你|你妈|傻逼|煞笔|滚出|去死|nmsl|system prompt|忽略(之前|前面)的?(所有)?(指令|设定))/i

    // ── 入口 ①：pre-gate 把每条入站写进「这个人 + 这个 scope」的未读 ──────────────
    bot.on('pre-gate', (ev) => {
      if (cfg.enabled === false || !ev) return
      const qq = String(ev.sender?.qq ?? '')
      if (!isQq(qq) || qq === String(bot.core?.selfId || bot.napcat?.selfId || '')) return
      const text = String(ev.text || '').trim()
      if (!text) return
      if (SKIP_RE.test(text)) return
      const scope = scopeOfKey(ev.chatKey, ev.groupId)
      const row = {
        t: Date.now(), qq, name: String(ev.sender?.card || ev.sender?.name || qq),
        text: text.slice(0, 2000), gid: String(ev.groupId ?? ev.chatKey ?? ''), when: stampOf(Date.now()),
      }
      // 两处都存（主人 2026-10-28 定：互通靠存），读的时候只读当前这一处，标签才不会张冠李戴
      for (const sc of FLOW_SCOPES) appendRow(fileOf(qq, sc, 'unread'), row, UNREAD_CAP)
      void scope
      // 群流水：每群一份，所有人所有消息，上限 10000
      try {
        const gid = String(ev.groupId || '').trim()
        if (/^\d{4,12}$/.test(gid)) {
          const gf = path.join(rootOf(), `${gid}.jsonl`)
          appendRow(gf, { t: row.t, qq, name: row.name, text: row.text }, GROUP_FLOW_CAP)
        }
      } catch (e) { log.warn(`[按人记忆] 写群流水失败: ${e.message}`) }
    })

    // ── 入口 ③：真的发出去了才并仓（只并这一个会话里的这一个人）────────────
    try {
      bot.onOutbound((out) => {
        const key = String(out?.target || '')
        // 自己说过的话：私聊要进她那份私聊未读流水；群聊不存自己说的（主人 2026-10-28 定）
        try {
          const m = /^private:(\d{4,12})$/.exec(key)
          const said = String(out?.text ?? out?.body ?? out?.message ?? '').trim()
          if (m && said) {
            const selfId = String(bot.core?.selfId || bot.napcat?.selfId || '')
            // 私聊里自己说的话：两份未读都存（带时间、我、回复对象），群里自己说的不存
            for (const sc of FLOW_SCOPES) {
              appendRow(fileOf(m[1], sc, 'unread'), {
                t: Date.now(), qq: selfId, name: '肥鱼', text: said.slice(0, 2000),
                gid: key, when: stampOf(Date.now()), self: true, to: m[1],
              }, UNREAD_CAP)
            }
          }
        } catch (e) { log.warn(`[按人记忆] 写自己流水失败: ${e.message}`) }
        const hit = pendingMerge.get(key)
        if (!hit) return
        pendingMerge.delete(key)
        let merged = 0
        // 只合并这次说话所在那一份（私聊回就并私聊，群里回就并群）——主人 2026-10-28 定
        merged += Number(mergeFlow(hit.qq, hit.scope).merged || 0)
        log.debug(`[按人记忆] 回话后并仓 ${hit.qq}/全部 +${merged}`)
      })
    } catch (e) { log.warn(`[按人记忆] 挂出站钩子失败: ${e.message}`) }

    // ── 入口 ②：before-turn 读未读（去掉本轮这条）→ 进提示词（并仓等真回话）──────
    bot.on('before-turn', (ev) => {
      if (cfg.enabled === false || !ev) return
      const qq = String(ev.sender?.qq ?? '')
      if (!isQq(qq)) return
      const scope = scopeOfKey(ev.chatKey, ev.groupId)
      const gid = String(ev.groupId ?? ev.chatKey ?? '')
      const cur = String(ev.text || '').trim()
      const now = Date.now()

      const seen = new Set()
      // 只读他这次说话所在的那一份（群里读群、私聊读私聊），另一份留着自己去翻
      let rows = readRows(fileOf(qq, scope, 'unread')).map((r) => ({ ...r, _sc: scope }))
      // 群里说话时，顺带把他私聊那份没读的也带上（主人 2026-10-28 定：标时间、标是私聊里的谁说给谁的）
      if (scope === 'group') {
        rows = rows.concat(readRows(fileOf(qq, 'private', 'unread')).map((r) => ({ ...r, _sc: 'private' })))
      }
      rows = rows
        .filter((r) => {
          const k = `${r.t}:${r.text}`
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
        .sort((a, b) => Number(a.t || 0) - Number(b.t || 0))
        .filter((r) => !(cur && String(r.text || '').trim() === cur && now - Number(r.t || 0) < 120000))
      if (rows.length) {
        const lines = rows.slice(-60)
          .map((r) => `${String(r.when || stampOf(r.t))} ${r._sc === 'group' ? '（群里）' : `（私聊·${String(r.name || r.qq || '')}↔肥鱼）`} ${String(r.text || '')}`)
          .filter(Boolean)
        // 纯操作指令（"重启"这种）不重放：模型看见就会再执行一遍
        const notCmd = lines.filter((l) => !/^(请|帮我|麻烦)?(重启|重载|重启一下|重启吧|重启下|reload|restart)[一下吧啊呀。！!]?$/.test(l.trim()))
        if (notCmd.length) {
          ev.hint.push(`[${qq} 没读过的流水，共 ${notCmd.length} 条，只当背景]\n${notCmd.join('\n')}`)
        }
        // 不在这里并仓：没真回他就该继续算未读（主人 2026-10-27 定）
        pendingMerge.set(String(ev.chatKey || gid), { qq, scope })
        log.debug(`[按人记忆] 注入未读 ${qq}/${scope} ${notCmd.length} 条（待回话后并仓）`)
      }

      // injectChats：名单里的私聊，把画像 + 最近几句直接塞进提示词
      const list = Array.isArray(cfg.injectChats) ? cfg.injectChats.map(String) : String(cfg.injectChats || '').split(/[,，\s]+/).filter(Boolean)
      if (scope === 'private' && list.includes(qq)) {
        let profile = ''
        try { profile = fs.readFileSync(profileOf(qq), 'utf8').trim() } catch { /* 没画像 */ }
        const maxChars = Math.max(200, Number(cfg.maxChars) || 1200)
        if (profile) profile = profile.length > maxChars ? `${profile.slice(0, maxChars)}…` : profile
        const already = new Set((Array.isArray(ev.hint) ? ev.hint : []).join('\n').split('\n').map((x) => x.trim()))
        const recent = readRows(fileOf(qq, 'private', 'read'), Math.max(1, Number(cfg.lastN) || 10))
          .map((r) => `${String(r.when || stampOf(r.t))} ${String(r.text || '').trim()}`).filter((t) => t.trim() && !already.has(t))
        const bits = []
        if (profile) bits.push(`她的画像：\n${profile}`)
        if (recent.length) bits.push(`最近几句：\n${recent.join('\n')}`)
        if (bits.length) ev.hint.push(`[记忆资料: ${qq} 的长期画像与近期对话（不是新消息，别整段复述）]\n${bits.join('\n\n')}`)
      }
    })

    // ── 入口 ③：工具 user_memory ────────────────────────────────────────────────
    bot.registerTool('user_memory', {
      description:
        '按人记忆：流水（每人四份：群聊/私聊 × 读过/未读）与长期画像。\n'
        + 'op=recent 最近流水；op=history 按关键词翻流水；op=read 读某人的长期画像；op=append 追加一条画像。\n'
        + '流水按 QQ 分人，认人只看号码。要合并未读用 memory_merge。',
      parameters: {
        op: { type: 'string', required: true, description: 'recent | history | read | append' },
        qq: { type: 'string', description: '看谁（4-12 位 QQ 号）；省略 = 本轮说话的人' },
        keyword: { type: 'string', description: 'op=history 时按关键词过滤' },
        scope: { type: 'string', description: 'group | private | all（默认 all）' },
        limit: { type: 'int', description: 'op=recent/history 返回多少条，默认 10' },
        text: { type: 'string', description: 'op=append 要追加的一行（Markdown 列表行）' },
      },
      execute(args, exec) {
        if (cfg.enabled === false) throw new Error('按人记忆已关闭')
        const op = String(args?.op || 'recent')
        const turn = bot.currentTurn?.() || exec?.turn || null
        const self = String(turn?.sender?.qq ?? '')
        const qq = String(args?.qq || self || '')
        if (!isQq(qq)) throw new Error('qq 要是 4-12 位数字')
        const scopes = (() => {
          const s = String(args?.scope || 'all')
          return s === 'group' || s === 'private' ? [s] : FLOW_SCOPES
        })()
        const limit = Math.min(200, Math.max(1, Number(args?.limit) || 10))

        if (op === 'read') {
          const isMaster = String(bot.core?.adminQq || '') === self
          if (!isMaster && qq !== self && !(turn?.sender?.isMaster)) throw new Error('只有主人（或本人）能读别人的长期画像')
          let text = ''
          try { text = fs.readFileSync(profileOf(qq), 'utf8').trim() } catch { return { ok: true, qq, profile: '', hint: '这个人还没有画像' } }
          return { ok: true, qq, profile: text }
        }

        if (op === 'append') {
          const t = String(args?.text || '').trim()
          if (!t) throw new Error('append 需要 text')
          const line = t.startsWith('-') ? t : `- ${t}`
          ensureDirs()
          try {
            const old = fs.readFileSync(profileOf(qq), 'utf8')
            fs.writeFileSync(profileOf(qq), `${old.replace(/\n+$/, '')}\n${line}\n`)
          } catch {
            fs.writeFileSync(profileOf(qq), `${line}\n`)
          }
          return { ok: true, qq, appended: line }
        }

        const rows = []
        for (const s of scopes) {
          for (const st of ['read', 'unread']) rows.push(...readRows(fileOf(qq, s, st)))
        }
        rows.sort((a, b) => Number(a.t || 0) - Number(b.t || 0))
        let out = rows
        if (op === 'history') {
          const kw = String(args?.keyword || '').trim()
          if (kw) out = out.filter((r) => String(r.text || '').includes(kw))
        }
        return {
          ok: true, qq, op, count: out.length,
          rows: out.slice(-limit).map((r) => ({ time: new Date(Number(r.t || 0)).toISOString(), text: String(r.text || '') })),
        }
      },
    })

    // ── 入口 ④：工具 memory_merge（合并未读 / 看积压）──────────────────────────
    bot.registerTool('memory_merge', {
      description:
        '合并某人的未读流水进已读（读完就用它收尾），或看积压条数。\n'
        + 'scope：group（群聊）、private（私聊）、all（两份都并）；action：status 只看条数，merge 真合并。\n'
        + '不给 qq 就是本轮说话的那个人。',
      parameters: {
        qq: { type: 'string', description: '合并谁（4-12 位 QQ 号）；省略 = 本轮说话的人' },
        scope: { type: 'string', description: 'group | private | all（默认 all）' },
        action: { type: 'string', description: 'status（默认）| merge' },
      },
      execute(args, exec) {
        if (cfg.enabled === false) throw new Error('按人记忆已关闭')
        const turn = bot.currentTurn?.() || exec?.turn || null
        const qq = String(args?.qq || turn?.sender?.qq || '')
        if (!isQq(qq)) throw new Error('qq 要是 4-12 位数字')
        const s = String(args?.scope || 'all')
        const scopes = s === 'group' || s === 'private' ? [s] : FLOW_SCOPES
        const action = String(args?.action || 'status')
        const status = {}
        for (const sc of scopes) {
          status[sc] = { unread: readRows(fileOf(qq, sc, 'unread')).length, read: readRows(fileOf(qq, sc, 'read')).length }
        }
        if (action !== 'merge') return { ok: true, qq, action: 'status', scopes: status }
        const merged = {}
        for (const sc of scopes) {
          const r = mergeFlow(qq, sc)
          merged[sc] = r.merged ?? 0
          if (!r.ok) return { ok: false, qq, error: r.error, merged }
        }
        return { ok: true, qq, action: 'merge', merged }
      },
    })

    bot.core = bot.core || {}
    bot.core.ensureUserFlows = ensureFlows
    log.info('[按人记忆] 四份流水 + 画像 + memory_merge 已加载')
  },
}
