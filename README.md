# 蓝色大肥鱼 · QQ 机器人（配置与提示词）

一只挂在 QQ 上的女仆鲸鱼娘：DeepSeek Harness 的 OneBot 适配插件 + 提示词工程 + 若干本地工具。
这个仓库是**可公开的那一半**：插件源码、人设、提示词规则、运维手册、以及一个以图搜人的小工具。
**聊天流水、用户画像、表情包库、会话数据库都不在这里**，见下方「刻意排除」。

```
plugin/                 OneBot 适配插件（kernel 内核 + plugins 扩展）
  kernel/               napcat 适配、上下文组装、提示词拼装、节流、配置
  plugins/              子插件：群记忆、图生成、空间、视频侧车、鱼鱼找鸡…
  config.example.json   脱敏后的配置样例（token 一律 <REDACTED>）
persona/                人设原文（Markdown，热更新）
workspace/AGENTS.md     运维手册：路径、纪律、发东西的姿势
tools/fish-find-chicken 以图找人的独立小工具（零依赖，Node 18+）
```

## 设计上的几个取舍

- **人设与规则分家**：人设只写「是谁、怎么说话」，能随手改、下一轮就生效；行为纪律和路径写在 `workspace/AGENTS.md`。
- **提示词钉子**：语气、说话方式这类硬约束不进人设文件，而是每轮由 `kernel/format.js` 拼进请求（风格钉、语气钉、口吻钉、收尾钉），模板占位符 `{{head}} {{body}} {{nails}}`。
- **群上下文三段**：`[上次回复之前]` / `[上次回复之后]` / `[当前最新消息]`，锚点存在会话状态里；私聊固定取最近 15 条。
- **上下文压缩**：长对话走「分块摘要 → 逐级蒸馏」，摘要写进上下文替换原文，靠工具调用而不是靠截断。
- **节流与克制**：群里有宵禁、有最小间隔、有主动接话冷却；被叫才接、答完即止，不连环追问。
- **权限边界写死在代码里**：只有配置里的管理员 QQ 能触发文件/终端类操作，其他人一律软话挡回去；机器人自己起的定时回合因为没有「当前发送者」会被单独判断。

## 安全与隐私

- 仓库里**没有任何 token、密码、Cookie**；`config.example.json` 中的敏感字段统一为 `<REDACTED>`。
- 反查图片一律经 `UPLOAD_HOSTS` 白名单，配置改不了上传域名（防止被配置带去奇怪的站点）。
- 以图搜人会把图上传给识图引擎，这是这类工具的前提，用之前心里要有数。

## 刻意排除（不入库）

| 目录 | 内容 |
| --- | --- |
| `logs/` | 所有聊天流水（jsonl） |
| `qq-memory/` | 群记忆、用户画像、归档 |
| `qq-users/` | 按人拆分的读写游标 |
| `qq-stickers/` | 群里攒的表情包 |
| `state/`、`*.bak-*`、`*.log` | 运行状态、备份、日志 |
| 各插件真实 `config.json` | 含 token 与管理员号码，只留脱敏样例 |

## 运行

插件不是独立进程，跑在 DeepSeek Harness 的插件宿主里，由 NapCat（OneBot 11）喂消息：

1. NapCat 暴露 HTTP + WebSocket（默认 `3000` / `3001`）；
2. `config.json` 填 `adminQq`、`napcat.wsUrl`、`napcat.wsToken`、`napcat.httpUrl`、`napcat.httpToken`；
3. 插件目录放进宿主 `node_modules`，重启宿主生效。

`tools/fish-find-chicken` 可单独用：

```bash
node bin/fish.mjs ./某张图.jpg --engines saucenao,yandex
```

## 许可

代码 MIT；人设与提示词文本归作者所有，转载注明出处。
