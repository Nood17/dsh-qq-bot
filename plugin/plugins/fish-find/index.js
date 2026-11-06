/**
 * fish-find — 图反查（id: 'fish-find', order: 75）
 *
 * 用法：**引用一张图** + `/鱼鱼找鸡`。先回一句「收到，开始找」，再把结果发回来。
 * 零 token：插件自己调外部小工具（`<dataDir>/tools/fish-find-chicken`），不叫模型。
 *
 * 三条纪律：
 *   ① **找不到图就直说**，不要瞎猜、也不要默默不回（用户会以为没反应）。
 *   ② **工具挂了只降级不吞消息**：出错就回一句失败原因，并把 `ev.stopped` 置上——
 *      命令类消息本来就不该进模型，别让它变成一轮闲聊。
 *   ③ **反查要上传图片**（引擎侧必须看到图），上传域名在工具里写死白名单；这里只透传。
 *
 * 图片从哪来：被引消息（`ev.replyToId` → get_msg）优先，其次本条消息自带的图。
 */

import fs from 'node:fs'
import path from 'node:path'

const TOOL_ROOT = path.resolve(
  String(process.env.DSH_HOME || path.join(process.env.HOME || '/home/nood', '.dsh')),
  'dsh-onebot-qq', 'tools', 'fish-find-chicken',
)
const TOOL_ENTRY = path.join(TOOL_ROOT, 'src', 'fish-find-chicken.js')

/** 懒加载工具模块：工具没装就只是这条命令用不了，不能影响插件整体加载。 */
let toolPromise = null
function loadTool() {
  if (!toolPromise) toolPromise = import(TOOL_ENTRY)
  return toolPromise
}

function readToolConfig() {
  const file = path.join(TOOL_ROOT, 'config.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/** 从 OneBot segment 数组里找第一张图（url / base64 / 本机路径三种形态）。 */
function firstImageOf(segments) {
  const seg = (Array.isArray(segments) ? segments : []).find((s) => s?.type === 'image')
  if (!seg) return null
  const data = seg.data || {}
  const raw = String(data.url || data.file || '')
  if (/^base64:\/\//i.test(raw)) return { base64: raw.slice(9) }
  if (/^https?:\/\//i.test(raw)) return { url: raw }
  if (raw && fs.existsSync(raw)) return { file: raw }
  return null
}

async function bytesOfImage(img) {
  if (img.base64) return { bytes: Buffer.from(img.base64, 'base64'), mimeType: 'image/jpeg' }
  if (img.file) {
    const bytes = fs.readFileSync(img.file)
    const mimeType = /\.png$/i.test(img.file) ? 'image/png' : 'image/jpeg'
    return { bytes, mimeType }
  }
  const res = await fetch(img.url, { signal: AbortSignal.timeout?.(20000) })
  if (!res.ok) throw new Error(`取图失败 HTTP ${res.status}`)
  const mimeType = String(res.headers.get('content-type') || '').split(';')[0] || 'image/jpeg'
  if (!/^image\//i.test(mimeType)) throw new Error(`那个地址不是图片（${mimeType}）`)
  return { bytes: Buffer.from(await res.arrayBuffer()), mimeType }
}

export default {
  id: 'fish-find',
  title: '图反查（鱼鱼找鸡）',
  order: 75,

  configSchema: {
    enabled: {
      type: 'bool', default: true, group: '工具',
      label: '图反查命令',
      hint: '开：引用一张图发 /鱼鱼找鸡，它去识图引擎反查是谁、主页在哪（零 token）。关：命令不可用。',
    },
    engines: {
      type: 'text', default: '',
      group: '工具',
      label: '引擎（逗号分隔，留空用工具自己的配置）',
      hint: '可选：saucenao / lens / tracemoe / iqdb / baidu。lens 最准但要外网。',
    },
    masterOnly: {
      type: 'bool', default: false, group: '工具',
      label: '只给主人用',
      hint: '开：别人发这条命令会被挡回去。反查会把图上传给引擎，介意就开。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}

    /** 命令回执统一出口（deliver 出站，然后这条消息到此为止，不进模型）。 */
    async function reply(ev, text, reason) {
      try {
        await bot.deliver(ev.chatKey, text)
      } catch (e) {
        bot.log?.warn?.(`[图反查] 回执失败: ${e.message}`)
      }
      ev.stopped = true
      ev.stopReason = reason
    }

    bot.registerCommand('鱼鱼找鸡', {
      permission: 'any',
      description: '引用一张图反查是谁（coser / 画师 / 出处），零 token',
      async handler(ev) {
        if (cfg().enabled === false) return
        if (cfg().masterOnly === true && ev.sender?.isMaster !== true) {
          await reply(ev, '这条只给主人用～', 'fish-find:denied')
          return
        }

        // ① 找图：被引消息优先，其次本条消息
        let img = null
        try {
          if (ev.replyToId) {
            const quoted = await bot.napcat.msgById?.(ev.replyToId)
            img = quoted ? firstImageOf(quoted.message) : null
          }
          if (!img && Array.isArray(ev.segments)) img = firstImageOf(ev.segments)
        } catch (e) {
          bot.log?.warn?.(`[图反查] 取被引消息失败: ${e.message}`)
        }
        if (!img) {
          await reply(ev, '引用一张图再发 /鱼鱼找鸡，本鱼就拿它去找', 'fish-find:no-image')
          return
        }

        const toolCfg = readToolConfig()
        const engines = String(cfg().engines || '')
          .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
        await reply(ev, '收到，开始找……找到就回你', 'fish-find:ack')

        try {
          const { reverseSearch, extractAccounts, formatReply } = await loadTool()
          const { bytes, mimeType } = await bytesOfImage(img)
          const pickedEngines = engines.length
            ? engines
            : (Array.isArray(toolCfg.engines) && toolCfg.engines.length ? toolCfg.engines : ['saucenao'])
          const done = await reverseSearch(bytes, mimeType, {
            engines: pickedEngines,
            timeoutMs: Number(toolCfg.timeoutMs) || 45000,
            proxy: String(toolCfg.proxy || ''),
            browserExe: String(toolCfg.browserExe || ''),
            // yandex/必应/百度 那三个引擎不接收图片字节，它们要一个「公网能抓到的图片网址」；
            // QQ 聊天里的图链接带 rkey，外网可直接取到（实测 2026-11-02），所以原样递给它。
            publicUrl: img.url || '',
          })
          const accounts = extractAccounts(done?.candidates ?? [], {
            max: Number(toolCfg.maxAccounts) || 3,
            strictNames: toolCfg.strictConsensus !== false,
          })
          const text = formatReply({
            accounts,
            candidates: done?.candidates ?? [],
            enginesUsed: done?.enginesUsed ?? [],
            failures: done?.failures ?? [],
            consensusName: done?.consensusName ?? '',
          })
          await bot.deliver(ev.chatKey, text || '翻了一圈，没认出来是谁')
        } catch (e) {
          bot.log?.warn?.(`[图反查] 反查失败: ${e.message}`)
          await bot.deliver(ev.chatKey, `没查成：${String(e.message || e).slice(0, 120)}`)
        }
      },
    })
  },
}
