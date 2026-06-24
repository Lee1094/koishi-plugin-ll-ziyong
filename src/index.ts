/**
 * koishi-plugin-ll-ziyong
 * AI 生图插件 — 接入 OpenAI 通用模型（Gemini 等），积分制
 */
import { Context, Schema, h, Logger, Session } from 'koishi'

declare module 'koishi' {
  interface Tables {
    ll_points: LLPoints
  }
}

interface LLPoints {
  userId: string
  points: number
  totalSpent: number
}

export interface Config {
  apiUrl: string
  apiKey: string
  model: string
  keywords: string[]
  cost: number
  prompt: string
  imgPrompt: string
  commandName: string
  cooldownSeconds: number
}

export const Config: Schema<Config> = Schema.object({
  apiUrl: Schema.string()
    .description('OpenAI 兼容 API 地址（如 Gemini OpenAI 兼容端点）')
    .default('https://generativelanguage.googleapis.com/v1beta/openai'),
  apiKey: Schema.string().role('secret')
    .description('API Key').required(),
  model: Schema.string()
    .description('模型名称')
    .default('gemini-2.5-flash-image'),
  keywords: Schema.array(Schema.string())
    .role('table')
    .description('触发关键词（消息包含这些词时自动生图，支持回复图片 / 发图 / @头像）')
    .default(['手办化', '动漫化', '生成', '生图']),
  cost: Schema.number()
    .description('每次生图消耗积分数')
    .min(1).max(10000).step(1).default(10),
  prompt: Schema.string().role('textarea')
    .description('文生图风格提示词（附加在用户输入前面）')
    .default('将以下内容转化为精美动漫手办风格图片，高画质，细节丰富，柔和光影：'),
  imgPrompt: Schema.string().role('textarea')
    .description('图生图风格提示词（有参考图片时使用）')
    .default('将这张图片转化为精美动漫手办风格图片，高画质，细节丰富，柔和光影，保留原图主体特征'),
  commandName: Schema.string()
    .description('生图命令名').default('shengtu'),
  cooldownSeconds: Schema.number()
    .description('冷却时间（秒）')
    .min(0).max(300).step(1).default(10),
})

export const name = 'll-ziyong'
export const inject = { required: ['database'] }

export function apply(ctx: Context, config: Config) {
  const logger = new Logger('[ll-ziyong]')

  ctx.model.extend('ll_points', {
    userId: 'string',
    points: 'unsigned',
    totalSpent: 'unsigned',
  })

  const cooldowns = new Map<string, number>()

  /* ── 积分 ── */
  async function getPoints(uid: string) {
    const rows = await ctx.database.get('ll_points', { userId: uid })
    return rows.length ? rows[0].points : 0
  }

  async function addPoints(uid: string, amount: number, by: string) {
    const rows = await ctx.database.get('ll_points', { userId: uid })
    if (rows.length) {
      const cur = rows[0].points + amount
      await ctx.database.set('ll_points', { userId: uid }, { points: cur })
      logger.info(`${by} → ${uid} +${amount}，余额 ${cur}`)
      return cur
    }
    await ctx.database.create('ll_points', { userId: uid, points: amount, totalSpent: 0 })
    return amount
  }

  async function spendPoints(uid: string, amount: number) {
    const rows = await ctx.database.get('ll_points', { userId: uid })
    if (!rows.length || rows[0].points < amount) return false
    await ctx.database.set('ll_points', { userId: uid }, {
      points: rows[0].points - amount,
      totalSpent: (rows[0].totalSpent || 0) + amount,
    })
    return true
  }

  function uidOf(session: any): string {
    return String(session.user?.id ?? session.author?.id ?? 'unknown')
  }

  /* ── 下载图片 ── */
  async function downloadImage(url: string): Promise<Buffer | null> {
    try {
      const data = await ctx.http.get(url, { responseType: 'arraybuffer', timeout: 30000 })
      return Buffer.from(data)
    } catch (e) {
      logger.debug('下载图片失败:', url, e)
      return null
    }
  }

  /* ── 从 Session 提取参考图片（回复 / 附件 / @头像） ── */
  async function extractRefImage(session: Session): Promise<{ buffer: Buffer; source: string } | null> {
    // 1) 回复消息中的图片
    if (session.quote?.elements) {
      const imgs = h.select(session.quote.elements, 'img')
      const src = imgs[0]?.attrs?.src as string | undefined
      if (src) {
        const buf = await downloadImage(src)
        if (buf) return { buffer: buf, source: 'reply' }
      }
    }

    // 2) 当前消息中的图片
    if (session.elements) {
      const imgs = h.select(session.elements, 'img')
      const src = imgs[0]?.attrs?.src as string | undefined
      if (src) {
        const buf = await downloadImage(src)
        if (buf) return { buffer: buf, source: 'attachment' }
      }
    }

    // 3) @某人的头像
    if (session.elements) {
      const ats = h.select(session.elements, 'at')
      const atId = ats[0]?.attrs?.id as string | undefined
      if (atId) {
        try {
          const user = await session.bot.getUser(atId, session.guildId)
          const avatarUrl = user?.avatar
          if (avatarUrl) {
            const buf = await downloadImage(avatarUrl)
            if (buf) return { buffer: buf, source: `@${user.name || atId}` }
          }
        } catch (e) {
          logger.debug('获取用户头像失败:', atId, e)
        }
      }
    }

    return null
  }

  /* ── 获取纯文本（去 @mention） ── */
  function cleanText(session: Session): string {
    let text = session.content || ''
    if (typeof text !== 'string') return ''
    // 跳过命令前缀
    if (/^[\/!！#]/.test(text.trim())) return ''
    // 去 @mention 文本
    if (session.elements) {
      for (const at of h.select(session.elements, 'at')) {
        const name = (at.attrs?.name as string) || (at.attrs?.id as string) || ''
        text = text.replace(`@${name}`, '').trim()
      }
    }
    return text.trim()
  }

  /* ── 检查是否命中关键词 ── */
  function matchKeyword(text: string): string | null {
    if (!text) return null
    for (const kw of config.keywords) {
      if (text.includes(kw)) return kw
    }
    return null
  }

  /* ── 生图（支持文本 / 图片参考） ── */
  async function generateImage(prompt: string, refBuf?: Buffer, refMime?: string): Promise<Buffer | null> {
    try {
      const mime = refMime || 'image/png'
      const b64 = refBuf ? refBuf.toString('base64') : null

      const userContent: any = refBuf
        ? [
            { type: 'text', text: `${config.imgPrompt}\n${prompt}` },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          ]
        : `${config.prompt}\n${prompt}`

      const res = await ctx.http.post<{ choices?: Array<{ message?: { content?: string } }> }>(
        `${config.apiUrl}/chat/completions`,
        {
          model: config.model,
          messages: [{ role: 'user', content: userContent }],
        },
        {
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 120000,
        },
      )

      const content = res?.choices?.[0]?.message?.content
      if (!content) { logger.warn('API 无内容'); return null }

      // 尝试多种图片提取格式
      const b64Match = content.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/)
      if (b64Match) return Buffer.from(b64Match[1], 'base64')

      const md = content.match(/!\[.*?\]\((https?:\/\/[^\s)]+)\)/)
      const url = md?.[1] || content.match(/(https?:\/\/[^\s"']+\.(?:png|jpg|jpeg|gif|webp))/i)?.[1]
      if (url) {
        const img = await ctx.http.get(url, { responseType: 'arraybuffer', timeout: 60000 })
        return Buffer.from(img)
      }

      logger.warn('未找到图片:', content.slice(0, 200))
      return null
    } catch (e) {
      logger.error('生图异常:', e)
      return null
    }
  }

  /* ── 生图执行流程（命令 & 关键词共用） ── */
  async function doGenerate(session: Session, prompt: string, refImg?: { buffer: Buffer; source: string }) {
    const uid = uidOf(session)
    const s = session as any
    const name = s.user?.name || s.author?.name || uid

    const now = Date.now()
    const last = cooldowns.get(uid) || 0
    const left = config.cooldownSeconds - (now - last) / 1000
    if (left > 0) return `⏳ 冷却中，${left.toFixed(0)} 秒后再试`

    if (!(await spendPoints(uid, config.cost))) {
      return `❌ 积分不足！需 ${config.cost}，你当前 ${await getPoints(uid)} 积分`
    }
    cooldowns.set(uid, now)

    const tip = refImg
      ? `🎨 ${name} 正在「${refImg.source}」→ 手办化...（-${config.cost} 积分）`
      : `🎨 ${name} 正在生图「${prompt.slice(0, 40)}」...（-${config.cost} 积分）`
    await session.send(tip)

    const buf = await generateImage(prompt, refImg?.buffer)
    if (!buf) {
      await addPoints(uid, config.cost, 'system')
      return '❌ 生图失败，积分已退还'
    }

    return h.image(buf, 'image/png')
  }

  /* ── 查积分 ── */
  ctx.command(`${config.commandName}.points`, '查看积分')
    .userFields(['id'])
    .action(async ({ session }) => {
      const uid = uidOf(session)
      const pts = await getPoints(uid)
      const rows = await ctx.database.get('ll_points', { userId: uid })
      const spent = rows.length ? rows[0].totalSpent || 0 : 0
      return `💰 积分：${pts} | 已消费：${spent}`
    })

  /* ── 管理员加积分 ── */
  ctx.command(`${config.commandName}.add <target:text> <amount:number>`, '给用户加积分（仅管理）')
    .userFields(['id', 'authority'])
    .action(async ({ session }, target, amount) => {
      if (session.user?.authority < 3) return '❌ 仅管理员可用'
      if (!amount || amount <= 0 || amount > 100000) return '积分范围 1~100000'

      let uid = target
      if (uid.startsWith('<@') && uid.endsWith('>')) uid = uid.slice(2, -1)
      else if (uid.startsWith('@')) uid = uid.slice(1)

      const adminId = uidOf(session)
      const cur = await addPoints(uid, amount, adminId)
      return `✅ 已为 ${target} 添加 ${amount} 积分 → 余额 ${cur}`
    })

  /* ── 主命令：生图（支持回复图片 / 发图 + 命令） ── */
  ctx.command(`${config.commandName} [prompt:text]`, 'AI 生图（消耗积分），可回复图片或发图 + 命令')
    .userFields(['id', 'name'])
    .action(async ({ session }, prompt) => {
      const refImg = await extractRefImage(session)
      const text = prompt?.trim() || cleanText(session) || (refImg ? '手办化' : '')

      if (!refImg && !text) {
        return `用法：/${config.commandName} <描述>，如 /${config.commandName} 一只可爱的猫
也可回复图片 / 发图后用 /${config.commandName} 生图`
      }

      return doGenerate(session, text, refImg || undefined)
    })

  /* ── 关键词触发（支持回复图片 / 发图 / @头像） ── */
  if (config.keywords?.length) {
    ctx.middleware(async (session, next) => {
      const text = cleanText(session)
      if (!matchKeyword(text)) return next()

      const uid = uidOf(session)

      // 冷却检查
      const now = Date.now()
      if ((now - (cooldowns.get(uid) || 0)) / 1000 < config.cooldownSeconds) return next()

      // 提取参考图片（回复 / 附件 / @头像）
      const refImg = await extractRefImage(session)

      // 构造 prompt：去除关键词
      let prompt = text
      for (const kw of config.keywords) prompt = prompt.replace(kw, '').trim()
      if (!prompt) prompt = refImg ? '手办化' : text

      if (!(await spendPoints(uid, config.cost))) {
        await session.send(`❌ 积分不足！需 ${config.cost}，你当前 ${await getPoints(uid)} 积分`)
        return next()
      }
      cooldowns.set(uid, now)

      const s = session as any
      const name = s.user?.name || s.author?.name || uid
      const tip = refImg
        ? `🎨 ${name} 正在「${refImg.source}」→ 手办化...（-${config.cost} 积分）`
        : `🎨 ${name} 正在生图「${prompt.slice(0, 40)}」...（-${config.cost} 积分）`
      await session.send(tip)

      const buf = await generateImage(prompt, refImg?.buffer)
      if (!buf) {
        await addPoints(uid, config.cost, 'system')
        await session.send('❌ 生图失败，积分已退还')
        return next()
      }

      await session.send(h.image(buf, 'image/png'))
      return next()
    })
  }

  logger.info('已启动')
}
