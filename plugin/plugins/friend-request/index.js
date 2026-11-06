/**
 * friend-request — 好友申请先请示主人（id: 'friend-request', order: 15）
 *
 * 规矩（主人 2026-10-27 定）：**别人加我好友，不许自己点通过**。
 * 有人申请 → 私聊主人报备（谁、备注、时间）→ 主人回「通过 <QQ>」才真的通过，「拒绝 <QQ>」就拒。
 *
 * 实现要点：
 *  · OneBot 的 request 事件没有会话，不进归一化；内核 `bot.onRequest(fn)` 直接把它递进来。
 *  · 通过必须带 `flag`（每条申请唯一），所以按 QQ 存一份 pending；主人回话时按 QQ 找 flag。
 *  · 待处理的申请落盘到 `<dataDir>/friend-request.json`，重启不丢（主人可能隔半天才回）。
 *  · 只有主人能下通过/拒绝的指令；别人说「通过」一律不理。
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE = 'friend-request.json'
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000

export default {
  id: 'friend-request',
  title: '好友申请请示',
  order: 15,

  configSchema: {
    enabled: {
      type: 'bool', default: true, group: '好友申请',
      label: '加好友先问主人',
      hint: '开：有人加好友只私聊主人报备，主人回「通过 QQ号」才通过；关：交给 NapCat 自己的设置管。',
    },
    notifyText: {
      type: 'str', default: '', group: '好友申请', label: '报备用的话（留空用默认）',
      hint: '支持 {name} {qq} {comment} 三个占位符。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const masterQq = () => String(bot.core?.adminQq || bot.config?.adminQq || '')
    const fileOf = () => path.join(bot.core?.dataDir || '.', FILE)

    function load() {
      try { const o = JSON.parse(fs.readFileSync(fileOf(), 'utf8')); return o && typeof o === 'object' ? o : {} } catch { return {} }
    }
    function save(o) {
      try {
        const f = fileOf()
        fs.mkdirSync(path.dirname(f), { recursive: true })
        fs.writeFileSync(`${f}.tmp`, JSON.stringify(o, null, 2))
        fs.renameSync(`${f}.tmp`, f)
      } catch (e) { bot.log.warn(`[好友申请] 写盘失败: ${e.message}`) }
    }
    function put(qq, rec) {
      const all = load()
      all[String(qq)] = rec
      const now = Date.now()
      for (const [k, v] of Object.entries(all)) {
        if (!v || now - Number(v.at || 0) > PENDING_TTL_MS) delete all[k]
      }
      save(all)
    }
    function drop(qq) {
      const all = load()
      delete all[String(qq)]
      save(all)
    }

    // ── ① 收到好友申请：只报备，绝不自动通过 ──────────────────────
    bot.onRequest(async (raw) => {
      if (cfg().enabled === false) return
      if (raw?.request_type !== 'friend') return
      const qq = String(raw.user_id || '')
      if (!/^\d{4,12}$/.test(qq)) return
      const flag = String(raw.flag || '')
      const comment = String(raw.comment || '').trim()
      put(qq, { flag, comment, at: Date.now(), approve: null })

      const master = masterQq()
      if (!master) { bot.log.warn('[好友申请] 没有 adminQq，无法报备'); return }
      const tpl = String(cfg().notifyText || '').trim()
      const text = tpl
        ? tpl.replaceAll('{name}', qq).replaceAll('{qq}', qq).replaceAll('{comment}', comment || '（没写备注）')
        : `有人加人家好友：${qq}${comment ? `，备注「${comment}」` : '（没写备注）'}。\n要放进来就回「通过 ${qq}」，不想留就回「拒绝 ${qq}」`
      try {
        await bot.deliver(`private:${master}`, text)
      } catch (e) {
        bot.log.warn(`[好友申请] 报备主人失败: ${e.message}`)
      }
      bot.log.info(`[好友申请] ${qq} 申请加好友（flag=${flag}），已报备主人，等指令`)
    })

    // ── ② 主人在私聊里下指令：通过 / 拒绝 ────────────────────────
    bot.on('before-turn', async (ev) => {
      if (cfg().enabled === false) return
      const master = masterQq()
      if (!master || String(ev.sender?.qq || '') !== master) return
      if (!String(ev.chatKey || '').startsWith('private:')) return
      const text = String(ev.text || '').trim()
      const m = text.match(/^(通过|同意|拒绝|不同意)\s*(\d{4,12})?/)
      if (!m) return
      const approve = m[1] === '通过' || m[1] === '同意'
      const all = load()
      // 没带 QQ 号时：只有一条待处理就默认那条
      const qq = m[2] || (Object.keys(all).length === 1 ? Object.keys(all)[0] : '')
      if (!qq || !all[qq]) {
        if (qq || Object.keys(all).length) {
          ev.hint.push(`[好友申请] 主人要「${m[1]}」但没指定谁；待处理的申请：${Object.keys(all).join('、') || '无'}`)
        }
        return
      }
      const rec = all[qq]
      try {
        await bot.napcat?.setFriendAddRequest?.(rec.flag, approve)
        drop(qq)
        ev.hint.push(`[好友申请] 已${approve ? '通过' : '拒绝'} ${qq} 的加好友申请，正常回主人一句就行`)
        bot.log.info(`[好友申请] ${approve ? '已通过' : '已拒绝'} ${qq}`)
      } catch (e) {
        ev.hint.push(`[好友申请] ${qq} 的申请处理失败：${e.message}；如实告诉主人`)
        bot.log.warn(`[好友申请] 处理 ${qq} 失败: ${e.message}`)
      }
    })
  },
}
