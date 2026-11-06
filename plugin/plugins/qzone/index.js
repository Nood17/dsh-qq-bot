/**
 * qzone — 发 QQ 空间说说（id: 'qzone', order: 70）
 *
 * 插件红线：不直连 QQ 接口、不拿 cookie —— 全部走 NapCat 的扩展接口
 *   · `send_qzone_msg`  发说说（`napcat-adapter.js` 的 `qzonePublish`）
 *   · `delete_qzone_msg` 删说说（`qzoneDelete`）
 *
 * 纪律：
 *  ① 只有主人能发（别人喊「帮我发个说说」一律拒绝）；
 *  ② 正文里不写路径、Token、报错；口吻按人设（这条靠提示词，不在代码里判）；
 *  ③ 发出去只报 tid，不复述正文。
 */
export default {
  id: 'qzone',
  title: 'QQ 空间',
  order: 70,

  configSchema: {
    enabled: { type: 'bool', default: true, group: 'QQ 空间', label: '发说说', hint: '关：不注册发表说说的工具。' },
    defaultUgc: {
      type: 'int', default: 1, group: 'QQ 空间', label: '默认可见范围',
      hint: '1 所有人 / 4 好友 / 16 部分好友 / 64 仅自己 / 128 部分好友不可见。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const masterOf = () => String(bot.core?.adminQq || bot.config?.adminQq || '')
    const allow = () => {
      const turn = bot.currentTurn?.()
      // 定时任务/机器人自己发起的一轮没有回合上下文 —— 这时调用者就是本机，放行
      if (!turn) return true
      const q = String(turn?.sender?.qq || turn?.qq || '')
      if (!q) return true
      const master = masterOf()
      return Boolean(master && (q === master || turn?.sender?.isMaster === true))
    }

    bot.registerTool('qzone_publish', {
      description: '发一条 QQ 空间说说（走 NapCat 的 send_qzone_msg）。content 是正文；images 可选，填宿主绝对路径（最多 9 张）；ugc_right 可选（1 所有人 / 4 好友 / 64 仅自己），默认 1。只给主人用。发完只报 tid，别复述正文。',
      parameters: {
        content: { type: 'string', description: '说说正文', required: true },
        images: { type: 'string', description: '图片路径，多张用逗号分隔（可选）' },
        ugc_right: { type: 'number', description: '可见范围：1 所有人 / 4 好友 / 64 仅自己' },
      },
      async execute(args) {
        if (cfg().enabled === false) return { ok: false, error: '发说说功能已关闭' }
        if (!allow()) return { ok: false, error: '只有主人能发说说' }
        const content = String(args?.content || '').trim()
        if (!content) return { ok: false, error: '正文不能为空' }
        const images = String(args?.images || '').split(/[,，\s]+/).filter(Boolean).slice(0, 9)
        try {
          const tid = await bot.napcat.qzonePublish({
            content,
            images,
            ugcRight: Number(args?.ugc_right) || Number(cfg().defaultUgc) || 1,
          })
          bot.log.info(`[空间] 已发说说 tid=${tid}`)
          return { ok: true, tid }
        } catch (e) {
          bot.log.warn(`[空间] 发说说失败: ${e.message}`)
          return { ok: false, error: e.message }
        }
      },
    })

    bot.registerTool('qzone_delete', {
      description: '删一条 QQ 空间说说，按 tid。只有主人能用。',
      parameters: { tid: { type: 'string', description: '说说 tid', required: true } },
      async execute(args) {
        if (!allow()) return { ok: false, error: '只有主人能删说说' }
        try {
          await bot.napcat.qzoneDelete(String(args?.tid || ''))
          return { ok: true }
        } catch (e) { return { ok: false, error: e.message } }
      },
    })
  },
}
