/**
 * 两个"把东西发到 QQ"的工具。
 *
 * 移植自 `dsh-wechat/packages/bundle/src/host.ts`。
 *
 * ## 为什么是两个而不是一个
 *
 * `send_to_qq` 只能发给**调用它的那个 agent 所属会话所绑定的**对话。
 * 这意味着**真正干活的会话通常报不了自己的结果**：用户提了要求就走开了，
 * 而答案随回合一起死在那个会话里。
 *
 * `notify_qq` 因此改为从存储里解析**当前绑定的**对话，而不是从调用者解析——
 * 于是任何会话都能送到用户此刻手上的那台手机。它**不接受目标参数**，
 * 所以 agent 没有东西可以瞄错。
 *
 * @module dsh-qq/send-tools
 */

/** 按扩展名判定走哪条媒体通道。 */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'])

/**
 * 按路径扩展名选媒体通道。
 *
 * 与微信插件的取舍一致：图片走图片通道（手机上是照片而不是附件），
 * 其余一律走文件通道。视频在这里额外分出来，因为 QQ 的原生视频消息能直接播放。
 *
 * @param path - 文件绝对路径。
 * @returns `'image' | 'video' | 'file'`
 */
export function mediaKindFor(path) {
  const dot = path.lastIndexOf('.')
  const ext = dot < 0 ? '' : path.slice(dot).toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  return 'file'
}

/**
 * `send_to_qq`：把本机文件发到**提问的那个 QQ 对话**。
 *
 * @param options.deliver - `(args, exec) => Promise<string>`，返回一句人话结果。
 * @param options.log - 记录一行日志。
 */
export function sendToQqToolDefinition({ deliver, log }) {
  return {
    name: 'send_to_qq',
    // 媒体映射只留一句：它影响 agent 选发什么（图会变成照片，而不是附件）。
    // 具体的扩展名清单与「不需要先复制」的例子都在 README，不在这里重复。
    description:
      'Send a file to the conversation that asked. Images arrive as photos, videos as clips. ' +
      'Use when the user asked for a file, image, screenshot, chart, or video. ' +
      'The path must be absolute, anywhere on this machine; no copy. ' +
      'Optional caption precedes the file.',
    parameters: {
      type: 'object',
      // 参数说明只留类型；path 必须绝对、caption 在文件之前，主描述里已经各说一次。
      properties: {
        path: { type: 'string' },
        caption: { type: 'string' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { detail: { type: 'string' } },
        required: ['detail'],
      },
      render: (args) => [{ type: 'text', text: `sent ${String(args.path ?? '')} to QQ` }],
    },
    execute: async (args, exec) => {
      const detail = await deliver({ path: String(args.path ?? ''), caption: args.caption }, exec)
      log(`send_to_qq: path=${String(args.path ?? '')} -> ${detail}`)
      return { detail }
    },
  }
}

/**
 * `notify_qq`：从**任意**会话主动推送到用户当前所在的 QQ 对话。
 *
 * @param options.deliver - `(args, exec) => Promise<string>`。
 * @param options.log - 记录一行日志。
 */
export function notifyQqToolDefinition({ deliver, log }) {
  return {
    name: 'notify_qq',
    // 「Unlike send_to_qq」与媒体映射都删掉：前者是跨工具对比（会被压缩成指向另一个工具），
    // 后者由插件按扩展名自己决定，agent 不据此改变决策。要发什么影响选择，见 send_to_qq。
    description:
      "Push a message and optional file to the user's QQ. Works from any session, even unbound. " +
      'Always reaches the current conversation; no way to choose another. ' +
      'Use it to report a finished task or send a requested file (absolute path). ' +
      'Keep text short for a phone.',
    parameters: {
      type: 'object',
      // 参数说明只留类型；文件必须绝对路径这一点在主描述里已经说过一次。
      properties: {
        text: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { detail: { type: 'string' } },
        required: ['detail'],
      },
      render: (args) => [
        { type: 'text', text: `notify QQ${args.path === undefined ? '' : ` with ${String(args.path)}`}` },
      ],
    },
    execute: async (args, exec) => {
      const detail = await deliver({ text: String(args.text ?? ''), path: args.path }, exec)
      log(`notify_qq: text=${String(args.text ?? '').slice(0, 40)} path=${String(args.path ?? '')} -> ${detail}`)
      return { detail }
    },
  }
}
