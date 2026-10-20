/**
 * QQ 渠道运行时。
 *
 * 负责：连上 QQ 官方 WebSocket → 入站消息映射到 DSH 会话 → 助手流聚合为回复 → 发回 QQ。
 *
 * ## 与微信插件对应的结构
 *
 * | 微信插件 | 这里 |
 * |---|---|
 * | `ChannelMonitor`（自研长轮询） | `QQBot.start()`（官方 SDK 的 WebSocket + RESUME） |
 * | `login()` 异步生成器 | `startQrConnect()`（见 `login.js`） |
 * | 自研 sendText / 两段式媒体上传 | `bot.sendText` / `bot.sendMedia`（含 ≥5MiB 自动分片） |
 * | 自研 `-14` 冷却与退避 | SDK 的 `withRetry` + `ReplyLimiter` |
 * | `#sendOrQueue` + `pendingNotifications` | 被动优先 + 主动兜底（见 `#send`） |
 *
 * ## 范围
 *
 * **只做 1:1 私聊**（`scope: 'c2c'`）。不做群聊，所以没有 group 维度、没有 @ 判定、没有群白名单。
 *
 * @module dsh-qq/runtime
 */
import { randomUUID } from 'node:crypto'
import { statSync, writeFileSync, existsSync } from 'node:fs'
import { basename, isAbsolute, join } from 'node:path'
import { QQBot } from '@tencent-connect/qqbot-nodejs'
import { ReplyLimiter, TEXT_CHUNK_LIMIT, chunkText } from '@tencent-connect/qqbot-nodejs/protocol'
import {
  parseApprovalReply,
  parseQuestionReply,
  presentApproval,
  presentQuestions,
} from './interactions.js'
import { bootLog, describeError, recordOnce } from './log.js'
import { QqBindSession } from './login.js'
import { describeMedia, describeMissing, downloadAttachment, mediaDir } from './media.js'
import { composeDelivery, composePrompt, splitRouteText } from './prompt.js'
import {
  dropPending,
  expirePendingNotifications,
  pendingFor,
  queuePendingNotification,
} from './pending.js'
import { longReplyFileName, planReply } from './reply-limit.js'
import { resolveWorkspaceDir } from './paths.js'
import { SessionRouter, compareSessionsNewestFirst } from './router.js'
import { mediaKindFor, notifyQqToolDefinition, sendToQqToolDefinition } from './send-tools.js'
import {
  TOOL_NAME,
  sessionToolDefinition,
  switchConfirmation,
  switchFailure,
  workspaceLabel,
} from './session-tool.js'
import {
  hasStoredSession,
  isSameWorkspace,
  listAllStoredSessions,
  listStoredSessions,
} from './session-index.js'
import { readStreamFrame } from './stream-frame.js'
import { conversationKey, StateStore } from './state.js'
// 设置项的定义**只有一份**（`lib/settings.js`）。原来的三份手抄名单
// （这里的 9 个 `DEFAULT_*` 常量、`#persistSettings()` 的落盘清单、加载逐字段 if）
// 已经全部改成由它派生：加一项设置只需在 schema 里加一行。
import { SETTINGS_DEFAULTS, SETTINGS_KEYS, SETTINGS_SCHEMA, normalizeSettings } from './settings.js'

/** 会话标题前缀。 */
const TITLE_PREFIX = 'QQ'

/**
 * 本频道工作区在桌面端显示的文件夹名。
 *
 * 与微信插件 `WORKSPACE_TITLE = '微信会话'` 对应——那边是「微信会话」，这边是「QQ 会话」。
 */
const WORKSPACE_TITLE = 'QQ 会话'

/*
 * 九项设置的默认值与校验器**不在这里**——它们只有一份，在 `lib/settings.js`。
 *
 * 这里原来摊着九个 `DEFAULT_*` 常量（外加 `boundedMs` / `boundedChars` 两个边界函数），
 * 与 `state.js` 的加载白名单、`#persistSettings()` 的落盘清单是三份各写各的名单。
 * 加一项设置时漏掉其中任何一份都会静默丢字段（见 `settings.js` 文件头）。
 * 现在默认值从 `SETTINGS_DEFAULTS` 取，边界在 schema 的校验器里，只有一处。
 */

/** typing 指示的刷新间隔与单次时长（秒）。 */
const TYPING_REFRESH_MS = 5_000
const TYPING_DURATION_SEC = 8

/**
 * typing 刷新的**总时长上限**（微信的 `TYPING_MAX_MS`）。
 *
 * 超过之后停止刷新：一个卡住的回合不该让"正在输入"永远亮着。
 * 那既泄漏一个定时器，也在**说一句谎话**——它让"还在想"和"已经死了"看起来一样。
 */
const TYPING_MAX_MS = 30 * 60 * 1000

/** 错误环形缓冲上限。 */
const MAX_ERRORS = 50

/**
 * 安全地读一个可选服务。
 *
 * 可选服务用 `ctx.get` 而不是 `inject`：声明了拿不到的服务会让插件 pending/failed，
 * 而本插件在缺 `webServer` / `workspaceRegistry` / `permissionPresets` 时只该**降级**，不该不加载。
 */
function safeGet(ctx, name) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * 从事件载荷的 `agent` 上取会话 id。
 *
 * `approval/request` 与 `user-questions/request` 都带 `agent`，而会话 id 在
 * `agent.session.id`——与 `agent/assistant-stream` 的载荷同构，所以两处用同一套读法。
 *
 * @param agent - 事件载荷里的 agent。
 */
function sessionIdOf(agent) {
  const id = agent?.session?.id
  return typeof id === 'string' ? id : undefined
}

/**
 * 从宿主的模型选择对象里挑出本插件要用的字段。
 *
 * 宿主有两种同形但**不等价**的来源：会话投影里的
 * `{ provider, model, reasoningEffort? }`，以及会话请求头里的配置对象
 * （同一组字段，外加模型参数、适配器默认值等一堆东西）。
 * 逐字段挑出来，是为了不让请求头里的其余内容进入回复文本或日志。
 *
 * @param source - 宿主的模型选择，或请求头配置。
 * @returns `{ provider, model, reasoningEffort? }`，读不到模型 id 时 `undefined`。
 */
function selectionOf(source) {
  const model = typeof source?.model === 'string' ? source.model : ''
  if (model === '') return undefined
  return {
    provider: typeof source.provider === 'string' ? source.provider : '',
    model,
    ...(typeof source.reasoningEffort === 'string' ? { reasoningEffort: source.reasoningEffort } : {}),
  }
}

/**
 * 把一个设置值渲染成日志里的一小段。
 *
 * `JSON.stringify` 而不是 `String`：空串、首尾空格、引号、`false` 与 `undefined`
 * 在日志里必须**看得出区别**——设置页"改了没生效"的排查全靠这个。
 *
 * @param value - 任意设置值。
 * @returns 一段文本。
 */
function formatSettingValue(value) {
  const text = JSON.stringify(value)
  return text === undefined ? 'undefined' : text
}

/**
 * 给一条会话索引记录带上它自己的工作目录。
 *
 * 路由靠这个字段分组出**会话夹**（`/list all`）；没有目录的记录就不带这个键，
 * 那在路由那边的含义是"本频道自己的"——记录里没有目录时，
 * 本对话是唯一能说它属于哪里的东西。
 *
 * @param session - `session-index` 交出来的行。
 * @param path - 它记录的工作目录，可能是空串。
 */
function withWorkspace(session, path) {
  const workspace = typeof path === 'string' ? path : ''
  return workspace === '' ? session : { ...session, workspace }
}

/**
 * 会话 id 相关工具。
 *
 * **唯一实现在 `router.js`**（那里是会话 id 的真正归属：`/list` 打印它、`/switch` 接受它）。
 * 这里只做转出，避免两处各写一份而慢慢漂移。
 */
export { mintSessionId, shortId } from './router.js'

export class QqRuntime {
  #ctx
  #home
  /**
   * 会话工作区目录。
   *
   * **不是只读的**：用户可在设置里改（`workspacePath`），改完立即生效于之后新建的对话。
   *
   * ⚠️ 它有两条硬约束（见 `paths.js` 文件头），改路径时都要守住：
   * 已存在的会话钉着它自己的 `cwd`（宿主比对不一致会直接抛 `ApiSessionCwdConflict`），
   * 所以**改路径只影响之后新建的对话**，旧对话留在旧文件夹——这是对的，
   * 但必须在设置页里说清楚，否则用户会以为旧对话丢了。
   */
  #workspace
  #credentials
  #store

  /** @type {QQBot | undefined} */
  #bot
  /** 当前账号 appId。 */
  #appId
  /** sessionId → 待发回复。 */
  #replies = new Map()
  /** conversationId → 最近一条入站消息（用于被动回复）。 */
  #lastInbound = new Map()
  /** 被动回复限流：SDK 默认每条消息最多 4 次、1 小时窗口（平台规则是 60 分钟内 5 次，插件没有改默认值）。 */
  #limiter = new ReplyLimiter()
  /** typing 刷新定时器。 */
  #typing = new Map()
  /** 诊断去重桶。 */
  #seen = new Set()
  #errors = []
  /** 已处理的入站消息 id（去重）。 */
  #handledMessages = new Set()
  /**
   * 全部设置项（**一个对象，九个字段**）。
   *
   * 它由 `SETTINGS_DEFAULTS` 建出来，所以**"运行时持有的设置字段集"与
   * `SETTINGS_SCHEMA` 的键集在构造上就相同**——不存在第二份手抄名单可以漂移。
   * 原来的九个私有字段（`#settleMs` / `#permissionPreset` / …）就是这么没的：
   * 每个字段名都要在"落盘清单"里再抄一遍，而漏抄的那一项会静默丢失。
   *
   * 字段名只用于读写（`this.#settings.settleMs`），语义仍由各处注释负责。
   * 对外只读的入口是 `settingsSnapshot()` / `settingsForPage()`，
   * 字段名与默认值都从 schema 派生；`settingsSchema()` 把 schema 本身交出去，
   * 供测试断言键集一致（见 `scripts/verify.mjs`）。
   */
  #settings = { ...SETTINGS_DEFAULTS }
  /** 本频道工作区的 id，解析成功后缓存（避免每次都查注册表）。 */
  #workspaceId
  /** 会话路由：持有"哪个 QQ 对话对应哪个 DSH 会话"以及全部聊天内指令。 */
  #router
  /** 扫码绑定会话（设置页轮询它的状态）。 */
  #bindSession
  /**
   * conversationId → 正在等待回答的交互（审批或提问）。
   *
   * 同一对话里后来的提示会**替换**先前的：用户看的是最新那条，
   * 同时挂着两条会让一个含糊的回复无法归属。
   */
  #interactions = new Map()
  /** 已注册工具的注销函数，供设置变更后重新注册。 */
  #toolDisposer
  /**
   * 停靠中的附件批次：`conversationId → { lines, text, timer, accountId, peerId }`。
   *
   * 用户先发图、再打字问「这是什么」；两条各投一次的话，agent 只拿到图片那一轮
   * 就开始答，而问题落在下一轮。停靠把"图 + 紧随其后的说明"合成一次提交。
   */
  #pending = new Map()
  /** 媒体目录路径，按需创建并缓存。 */
  #mediaDirPath

  /**
   * @param ctx - 宿主上下文。
   * @param options.home - DSH 主目录。
   * @param options.stateFile - 状态文件路径。
   * @param options.workspace - 会话工作目录（**必须与已存在会话的 cwd 一致**）。
   * @param options.credentials - {@link import('./credentials.js').CredentialStore}
   * @param options.settleMs - 覆盖回复聚合静默窗口（测试用）。
   * @param options.permissionPreset - 覆盖会话权限预设（`'default'` 表示沿用 profile 策略）。
   */
  constructor(ctx, options) {
    this.#ctx = ctx
    this.#home = options.home
    this.#workspace = options.workspace
    this.#credentials = options.credentials
    this.#store = new StateStore(options.stateFile, {
      onError: (message) => this.#recordError(`state: ${message}`),
      /*
       * 重试**成功**的那一次走日志、不进错误环：它不是失败，不该出现在设置页的"错误"里
       * （那是"狼来了"）。
       *
       * 但它必须留下痕迹：否则没有人能知道这台机器上究竟有没有遇到过 Windows 的占用错误
       * ——而"重试到底有没有被用到"正是微信那边留着没修时最缺的那条证据。
       */
      onRetry: (message) => bootLog(`state: ${message}`),
    })
    this.#appId = options.appId ?? ''
    if (typeof options.settleMs === 'number') this.#settings.settleMs = options.settleMs
    if (typeof options.permissionPreset === 'string') this.#settings.permissionPreset = options.permissionPreset

    // 路由持有会话映射与指令实现；它通过下面这个窄接口回调本运行时。
    // 与微信插件同构：路由不知道 QQ 的存在，运行时不知道指令的存在。
    this.#router = new SessionRouter({
      gateway: this.#gateway(),
      store: {
        load: async () => (await this.#store.read()).bindings,
        save: async (bindings) => {
          await this.#store.update((next) => {
            next.bindings = bindings
          })
        },
        /*
         * 浏览位置与编号清单也交给状态文件。
         *
         * 微信把这两样都存在它的状态文件里，理由对本插件一样成立：
         * 「查看其余」没有目标（位置是唯一知道"在看哪份"的东西），
         * 而"引用一屏清单再回编号"要按那条消息印的编号解析（正文就是 QQ 引用给的东西）。
         * 不落盘的话，一次插件重载就会让两者同时失效。
         */
        loadRouteState: async () => {
          const state = await this.#store.read()
          return { browsing: state.browsing, sessionLists: state.sessionLists }
        },
        saveRouteState: async (routeState) => {
          await this.#store.update((next) => {
            next.browsing = routeState.browsing
            next.sessionLists = routeState.sessionLists
          })
        },
      },
      titlePrefix: TITLE_PREFIX,
      // 工作区：`/list` 只列属于它的会话，`/list all` 把它排在会话夹第一位。
      ownWorkspace: this.#workspace,
      ownWorkspaceLabel: WORKSPACE_TITLE,
      onDiagnostic: (line) => bootLog(line),
    })

    // 扫码绑定与手工录入共用 `rememberCredentials` 这一条落地路径——
    // 两者只有入口不同，落地逻辑必须一致。
    this.#bindSession = new QqBindSession({
      onConfirmed: async (credentials) => {
        await this.rememberCredentials(credentials)
      },
    })
  }

  /**
   * 把宿主会话控制器适配成路由需要的窄接口。
   *
   * 两条路各有清楚的边界：`createSession` 只**创建**，`ensureSession` 只**复用**
   * （有记录就直接返回，见那个方法）。两者都不再靠"create 一下"来保活。
   */
  #gateway() {
    return {
      /**
       * 创建一条新会话，并把它的**会话标题**一并交给宿主。
       *
       * ## 为什么与 `ensureSession` 分开
       *
       * 只有**创建**这一刻该给标题：给一条已有会话改名会把它的标题覆盖掉
       * （用户自己起过、或宿主已经生成过一个，都不该被"这条消息的第一句话"盖掉）。
       * 而"这次是创建还是复用"只有路由知道（`#bind` 是创建，`#switchTo` 是复用），
       * 所以由它挑方法，而不是让这个方法去猜。
       *
       * ## 为什么必须给
       *
       * 不给的话宿主会拿**首条消息的措辞**当标题（`fallbackSessionTitle`，见
       * `#nameSession`），而那条消息是频道拼出来的：用户的话 + 附件描述 + 渠道说明
       * ——标题里会混进渠道说明。路由给的是由**用户自己的话**推导出来的标题。
       *
       * @param sessionId - 刚铸造出来的会话 id。
       * @param title - 会话标题；`undefined` 表示没有可命名的东西
       *   （`/new` 不带参数就是这样），让宿主自己从首条消息取。
       */
      createSession: async (sessionId, title) => {
        await this.#createSession(sessionId)
        if (typeof title === 'string' && title !== '') await this.#nameSession(sessionId, title)
      },

      /**
       * 复用一条**已经存在**的会话（**不创建、不动它的标题**）。
       *
       * ## 为什么不再用 `create` 保活（这是"每条消息留下一个空白会话"的根因）
       *
       * DSH 从 `0.2.0-rc.2` 升到 `0.2.1-rc.2` 之后，`sessionController.create` 的语义变了：
       * 它**只复用还空着**的会话（`!observed.events.some(e => e.type === 'turn/start')`），
       * 已经跑过一轮的会话不再被采纳，而是**另铸一个新 id** 返回
       * （`lib/types/agent.js` 的 `claim`）。而这里从前在**每条消息之前**都 create 一次
       * "确保会话活着"、并把返回值丢掉、继续用原来的 id `prompt`——于是：
       * 用户的聊天看起来正常（`prompt` 自己会 `resume`），**但每条消息都留下一个空白会话**，
       * 还被 attach 到工作区。
       *
       * 保活本来就不需要 create：`prompt` 自己会 resume 有记录的会话。所以**有记录就到此为止**。
       * 只有磁盘上没有记录（刚铸造的 id、或记录被删掉）才走 `create`——那时宿主的 `claim` 报
       * `SESSION_QUERY_SESSION_NOT_FOUND` → `createAgent(sessionId)`，**仍按请求的 id 创建**，
       * 不会改名。
       *
       * ⚠️ **别把它改回"确保会话活着"**：那句注释下的实现每跑一条消息就多一条空白会话。
       *
       * 这里刻意**没有** title 参数：标题只在创建那一刻给（`createSession`），
       * 复用一条已有会话不该改名。
       */
      ensureSession: async (sessionId) => {
        if (await hasStoredSession(this.#home, sessionId)) return
        await this.#createSession(sessionId)
      },

      prompt: async (sessionId, text) => {
        await this.#ctx.sessionController.prompt(
          {
            requestId: `qq-${randomUUID()}`,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          },
          new AbortController().signal,
        )
      },

      /**
       * 整台机器上的全部会话，最新在前——`/list all` 与 `/switch` 的搜索空间。
       *
       * 每一行带上它自己的工作目录：`/list all` 的**会话夹**就是按它分组的，
       * 而路由只能信这条记录（文件夹名是有损编码，会把无关目录并到一起）。
       * 记录里没有目录的行**不带这个字段**，含义是"本频道自己的"——
       * 那是只有一个对话能为之背书的工作区。
       */
      listSessions: async () => {
        const byWorkspace = await listAllStoredSessions(this.#home)
        const flat = []
        for (const [path, list] of byWorkspace) {
          for (const session of list) flat.push(withWorkspace(session, path))
        }
        return flat.sort(compareSessionsNewestFirst)
      },

      /**
       * 只属于本频道工作区的会话。
       *
       * `/list` 用它来把本聊天创建的对话排在前面、其余仅报数量；
       * 没有它的话每条会话都会被当成本频道的，列表会显示整台机器。
       */
      listOwnSessions: async () => {
        const rows = await listStoredSessions(this.#home, this.#workspace)
        return rows.map((session) => withWorkspace(session, session.cwd))
      },

      cancel: async (sessionId) => {
        await this.#ctx.sessionController.cancel({ sessionId })
      },

      /**
       * 一条绑定绑着的会话还能不能收活（`router.js` 的 `sessionState` 契约）。
       *
       * ## 为什么要在复用绑定之前问
       *
       * 两种死法最终落到同一个地方——用户的提示词被"接受"，然后无声无息地消失，
       * 没有任何一层记下一个字——所以这个问题问在**复用之前**，而收不了活的会话被换掉。
       *
       * `archived` 从**工作区注册表**读，那是 DSH 记录这件事的地方：被归档的会话，
       * 它的提示词会被接受，而提示词提出的**步骤**被拒（`dsh-api-session-controller`
       * 的归档门卫），于是回合以 `blocked` 结束、永远不会有答案。
       * 磁盘上没有任何东西标记这条会话，所以注册表是唯一能答对的来源。
       *
       * ## ⚠️ 与微信不同的两处，以及不确定的地方
       *
       * 1. **微信读 `ctx.workspaceRegistry?.archivedSessionIds`**（`bundle/src/host.ts` 的
       *    `sessionState`，HEAD `6997579`）。QQ 这里**同一形状**，但 `archivedSessionIds`
       *    这个成员**我没有在 QQ 的宿主上核对过**——微信是拿它的 0.2.0-rc.2 组合核对的。
       *    所以读法写成"拿不到就当没有归档集合"，于是缺这个能力时退化成**只看磁盘**：
       *    那会让一条被归档的会话答 `usable`，也就是 QQ 保持现状（消息照旧被静默吞掉），
       *    **不会**造成新的错误行为。要真正生效，需要用户在一台装好 QQ 插件的机器上
       *    确认 `workspaceRegistry.archivedSessionIds` 存在。**未实测。**
       * 2. 微信先问 `storedSessionWorkspace`（读得出来的记录）再问 `hasStoredSession`（在不在）。
       *    这里合并成一次 `hasStoredSession`：它就是前者的超集——一条**读得出来**的记录
       *    必然 `stat` 得到，所以先问那一句只是重复读一次同一个文件。
       *
       * `missing` 与列表走的是同一份磁盘索引，意思是这条会话哪里都没有记录。
       * 那**同样**是一条会话在"被创建"与"第一个回合"之间的样子——所以路由不会相信
       * 年龄小于 `MISSING_BINDING_GRACE_MS` 的绑定给出的这个判定，而这里只报**原始事实**，
       * 不做决定。
       *
       * **存在但读不出来**的记录答 `usable` 而不是 `missing`：那是坏掉的存储而不是被删的会话，
       * 凭它换掉对话，就会每当绑定年龄越过宽限期再来一次。
       *
       * 没有工作区注册表时就没有归档集合，于是只有磁盘那一问。**失败照旧往上抛**：
       * 路由把抛错的探针按 `usable` 处理并记一行，一个坏掉的探针不该弄丢一条能用的对话。
       *
       * @param sessionId - 正要被复用的那条会话。
       * @returns `'archived'` / `'missing'` / `'usable'`。
       */
      sessionState: async (sessionId) => {
        const archived = safeGet(this.#ctx, 'workspaceRegistry')?.archivedSessionIds
        if (Array.isArray(archived) && archived.includes(sessionId)) return 'archived'
        return (await hasStoredSession(this.#home, sessionId)) ? 'usable' : 'missing'
      },

      /*
       * 模型三件事也是**注入**给路由的，与 `listOwnSessions` 同一条理由：
       * 路由不持有宿主服务，规则才能脱离 DSH 单测（见 `router.js` 的 `#gateway` 注释）。
       */
      listModels: async () => this.listModels(),
      currentModel: async (sessionId) => this.currentModel(sessionId),
      selectModel: async (sessionId, provider, model, reasoningEffort) =>
        this.selectModel(sessionId, provider, model, reasoningEffort),
    }
  }

  /** 会话工作目录。 */
  get workspace() {
    return this.#workspace
  }

  /** 状态存储。 */
  get store() {
    return this.#store
  }

  /** 当前连接的 appId，未连接时为空串。 */
  get appId() {
    return this.#appId
  }

  /** 当前会话权限预设。 */
  get permissionPreset() {
    return this.#settings.permissionPreset
  }

  /**
   * 本频道会话的权限预设目录。
   *
   * ⚠️ **预设名由部署方配置，不是固定的。** `@deepseek-ai/dsh-permission-presets` 的
   * `names` = `[...配置表键名, ...(Auto integration 存活时再加 'auto')]`。
   * 所以**不能硬编码**可选值——必须问服务。
   *
   * 其中 `auto` 是保留名，旋钮组合固定为 **Full access 沙箱 + `ask` 审批策略**，
   * 也就是"能弹权限提示"的那一个。`custom` 也是保留名，但它只能被推导出来、不能被选中。
   *
   * 本插件 `permissionPreset` 的取值语义：
   * - 任一真实预设名 → 施加它
   * - `'default'`（**哨兵值，不是预设名**）→ 不施加任何预设，沿用 profile 自己的策略
   *
   * @returns `{ applied, sentinel, available, note }`
   */
  permissionPresetsInfo() {
    const service = safeGet(this.#ctx, 'permissionPresets')
    let available = []
    let note
    if (service === undefined) {
      note = '此组合没有权限预设服务'
    } else {
      try {
        available = Array.isArray(service.names) ? [...service.names] : []
      } catch (error) {
        note = `读取 names 失败：${describeError(error)}`
      }
      if (available.length === 0 && note === undefined) note = '服务报出的可选预设为空'
    }
    return { applied: this.#settings.permissionPreset, sentinel: 'default', available, note }
  }

  /**
   * 切换本频道会话的权限预设。
   *
   * 只影响**之后新建或采纳**的会话：DSH 在会话第一个回合开始后就锁定预设
   * （`agent-preset/locked`），已经跑过回合的会话改不了。
   *
   * @param preset - 真实预设名，或哨兵值 `'default'`（不施加任何预设）。
   * @param options.persist - 是否立即写回状态文件（默认 `true`）。
   *   `applySettings` 传 `false`——它自己末尾就写一次盘，不必为同一次变更写两遍。
   */
  setPermissionPreset(preset, { persist = true } = {}) {
    this.#settings.permissionPreset = preset
    bootLog(
      `权限预设已改为 '${preset}'${preset === 'default' ? '（哨兵：不施加任何预设，沿用 profile 策略）' : ''}（对之后新建或采纳的会话生效）`,
    )
    /*
     * ★ 这里的落盘**不能省**——它曾经漏掉，造成"设置不会保存"。
     *
     * 设置页切换预设走的是独立的 `POST /permission-preset`，那条路只调用本方法。
     * 少了这一句，界面显示新预设、状态文件里仍是旧值，**重启就回退**。
     * 而权限预设是设置页最显眼的控件，所以这个 bug 几乎必然被用户先撞上。
     *
     * 持久化放在 **setter** 而不是路由里，是为了让下一个调用者自动获得它：
     * 放在路由里的话，将来任何新入口（工具、命令行、别的页面）都会再漏一次。
     * 这与 `#targetFor`、`#mediaDir` 那些"只留一个判定点"的做法是同一条原则。
     */
    if (persist) this.#fire('保存权限预设', () => this.#persistSettings())
  }

  // ------------------------------------------------------------------ 模型

  /**
   * 本频道会话可用的模型清单（provider 分组已展平）。
   *
   * ## 这些调用对应宿主的哪一个接口
   *
   * 全部来自会话控制器服务 `sessionController`（`lib/types/index.js:208`
   * 以 `sessionController` 为键注册，本插件的 `inject` 已经拿到它）：
   *
   * - **列出**：`sessionController.modelCatalog()`
   *   （`dsh-api-session-controller/lib/types/index.js:373`，实现在
   *   `lib/types/catalog.js:10` 的 `buildModelCatalog`）。返回
   *   `{ default, routableProviders, groups: [{ id, name, models: [{ id, name, description?, reasoning? }] }], failures }`。
   *   它按 provider 分组，而选择模型要 `provider` + `model` **两个**值，
   *   所以这里展平成一行一个模型，并带上 provider。
   *   每个模型还带上它发布的 `reasoning.efforts`（id + 名字）与 `defaultEffort`——
   *   等级是模型自己的属性，`/model` 的清单要靠它印出"这个模型能想多深"，
   *   而那个信息在手机上别处看不到（见 `router.js` 的 `renderModelList`）。
   * - **读**：见 {@link currentModel}。
   * - **写**：见 {@link selectModel}。
   *
   * `failures` 里是**读不出来的提供方**（例如凭据没配好）。这里只把它们记进日志：
   * 一个坏提供方不该让整个清单变成空，否则用户看到的是"一个模型都没有"。
   *
   * @returns `{ provider, providerName, model, name, description?, levels?, defaultLevel? }[]`；
   *   没有接口时为空数组。
   */
  async listModels() {
    const controller = this.#ctx.sessionController
    if (typeof controller?.modelCatalog !== 'function') {
      this.#recordError('此组合的会话控制器没有 modelCatalog 接口，无法列出模型')
      return []
    }
    let catalog
    try {
      catalog = await controller.modelCatalog()
    } catch (error) {
      // **读目录失败不能让 `/model` 什么都不回**：命令抛出去会被入站处理的 catch 接住，
      // 用户看到的是"发了 /model 却没有任何反应"。回落空清单至少换来一句人话。
      this.#recordError(`读取模型目录失败: ${describeError(error)}`)
      return []
    }
    for (const failure of catalog?.failures ?? []) {
      // 每读一次记一次是有意的：这是"模型列表为什么少了一块"的唯一线索。
      bootLog(`模型目录：提供方 ${String(failure?.id)} 读取失败：${String(failure?.message)}`)
    }
    const rows = []
    for (const group of catalog?.groups ?? []) {
      for (const model of group.models ?? []) {
        const reasoning = model?.reasoning
        const levels = Array.isArray(reasoning?.efforts)
          ? reasoning.efforts
              .map((effort) => ({
                id: String(effort?.id ?? ''),
                name: String(effort?.name ?? effort?.id ?? ''),
              }))
              .filter((level) => level.id !== '')
          : []
        rows.push({
          provider: String(group.id),
          providerName: String(group.name ?? group.id),
          model: String(model.id),
          name: String(model.name ?? model.id),
          ...(model.description === undefined ? {} : { description: String(model.description) }),
          ...(levels.length === 0 ? {} : { levels }),
          ...(typeof reasoning?.defaultEffort === 'string' && reasoning.defaultEffort !== ''
            ? { defaultLevel: reasoning.defaultEffort }
            : {}),
        })
      }
    }
    return rows
  }

  /**
   * 某个会话**当前生效**的模型选择。
   *
   * 两个来源，按可靠性排序：
   *
   * 1. 会话投影 `modelSelection`（`sessionController` 在构造时注册，
   *    `dsh-api-session-controller/lib/types/model-selection-projection.js:42-53`）。
   *    它的状态是 `{ lastUsed, pending }`，对外视图是 `{ lastUsed, next }`，
   *    而 `next = pending ?? lastUsed`——桌面端的模型选择器读的正是 `next`
   *    （`dsh-client-ui-model-selection/lib/client.js:316,333`）。
   *    这里的读法与它一致，于是手机与桌面显示的是同一个模型。
   * 2. 会话最近一次请求头 `session.requestHeader()?.config`
   *    （`dsh-session/lib/types/index.js:629`）。投影服务缺失时的兜底。
   *
   * 都没有时返回 `undefined`：含义是"这个会话还没有自己的选择，用的是部署默认"，
   * 由调用方（`/model` 的清单）用目录里的 `default` 补上。
   *
   * @param sessionId - 目标会话。
   */
  currentModel(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    const session = safeGet(this.#ctx, 'sessions')?.get?.(sessionId)
    if (session === undefined) return undefined

    const state = safeGet(this.#ctx, 'sessionProjections')?.stateOf?.(session, 'modelSelection')
    const next = state?.pending ?? state?.lastUsed ?? undefined
    if (next !== undefined && next !== null) return selectionOf(next)

    const header = session.requestHeader?.()?.config
    if (header !== undefined && header !== null) return selectionOf(header)
    return undefined
  }

  /**
   * 切换某个会话使用的模型。
   *
   * 调的是 `sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })`
   * （`dsh-api-session-controller/lib/types/index.js:349`，实现
   * `lib/types/commands.js:126-159`——它把 `reasoningEffort` 一起交给
   * `llm.resolveCallConfig`，所以推理等级与模型是**同一次**选择）。三条与"能不能用"直接有关的事实：
   *
   * 1. **会话跑过第一个回合之后仍然可以改。** 这一点与权限预设**不同**：
   *    预设被 `agent-preset/locked` 挡在"会话已经开始"之后
   *    （`dsh-agent-preset-registry/lib/index.js:755-756`），而 `selectModel`
   *    没有这道闸——它先 `resolveAgent`（必要时恢复会话），再把选择记成
   *    会话自己的 `model/selection` 事件（`lib/types/agent.js:349-352`）。
   * 2. **对正在跑的那一步不生效，对下一步生效。** 宿主在组装提示词时先给选择拍快照，
   *    再在 `agent/request` 上套用 provider/model，注释写明这是为了
   *    "让并发的切换落在后面的一步上，而不是把两个面撕开"
   *    （`dsh-agent/lib/types/model-selection.js:27-34`）。
   *    所以本方法返回后**不能**声称"这一步就已经是新模型了"。
   * 3. **换 provider/model 会往下一次被接纳的请求里追加一条持久通知**
   *    （`[model changed: ...]`，`model-selection.js:12-26`），告诉模型它上面那些回合是别人写的。
   *
   * 副作用（宿主行为，本插件不额外做任何事）：`selectModel` 还会**在后台把部署默认模型
   * 也改成它**（`commands.js:165-167`），所以这里切一次，之后新建的会话也会用它——
   * 前提是这个组合挂了 `configEditor`，没有的话宿主直接跳过保存。
   *
   * @param sessionId - 目标会话。
   * @param provider - 提供方 id。
   * @param model - 提供方自己的模型 id。
   * @param reasoningEffort - 可选的推理等级 id（适配器的取值，例如 `high`）。
   *   **等级随模型一起交下去，不留给宿主去默认**（微信同一条注释）：漏掉它等于把
   *   "想多深"的决定交给一个用户看不见的解析步骤，而同一个模型在不同等级上是两个回答。
   *   与当前相同的 provider/model 再指名一个等级，就是"只改等级"。
   * @returns 宿主归一化后的选择 `{ provider, model, reasoningEffort? }`。
   * @throws 宿主拒绝时抛出（不可用的模型、找不到的会话、写者被占用…）。调用方负责说出来。
   */
  async selectModel(sessionId, provider, model, reasoningEffort) {
    const controller = this.#ctx.sessionController
    if (typeof controller?.selectModel !== 'function') {
      throw new Error('此组合的会话控制器没有 selectModel 接口，无法切换模型')
    }
    const result = await controller.selectModel({
      sessionId,
      provider,
      model,
      // 没指名等级时**不带这个键**：宿主据此应用模型自己的默认等级，
      // 而写一个 undefined 进去会让"没指名"与"指名了空值"变成同一件事。
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })
    return result?.selected ?? { provider, model }
  }

  /**
   * 设置项的定义（schema 本身）＋**运行时此刻实际持有的字段集**，供宿主内省与测试断言。
   *
   * `heldKeys` 是照着 `#settings` 现场取出来的键数组（**不是**另一份写死的名单，
   * 也不是那份默认值模板），所以它就是"运行时真正持有的设置字段"。
   *
   * 为什么要有它：`#settings` 初始化为 `{ ...SETTINGS_DEFAULTS }`，所以"加了设置却忘了
   * 加进 schema"这一类漏改会让**运行时比 schema 多一个字段**。
   *
   * ⚠️ 这类漏改**只有这一条断言抓得住**，下面两条都抓不住：
   * `settingsSnapshot()` 的循环也走 `SETTINGS_KEYS`（多出来的字段根本不出现），
   * 而 `#persistSettings()` 同样只写 schema 的键（**于是那个字段永远写不出去**，
   * 用户重启后设置就没了）。所以这个测试断言不是装饰，它是这条漏改唯一的出口。
   * 测试把 `heldKeys` 与 schema 的键集对起来，这一漏改当场变红
   * （见 `scripts/verify.mjs`；它就是微信那个"加了设置却没加校验器是编译错误"的等价物）。
   *
   * @returns `{ schema, keys, heldKeys, defaults, normalize }`。
   */
  settingsSchema() {
    return {
      schema: SETTINGS_SCHEMA,
      keys: SETTINGS_KEYS,
      heldKeys: Object.keys(this.#settings),
      defaults: SETTINGS_DEFAULTS,
      normalize: normalizeSettings,
    }
  }

  /**
   * 设置页要用的可调项快照（扁平）。
   *
   * 每个字段都与它的默认值并列，页面才能同时显示"当前值"与"默认值"并提供一个重置入口。
   *
   * **由 schema 驱动**：字段名遍历 `SETTINGS_KEYS`，默认值取 `SETTINGS_DEFAULTS`。
   * 所以加一项设置不需要动这个方法——原来这里也是手抄的九项（值 + 默认值共十八行）。
   */
  settingsSnapshot() {
    const snapshot = {}
    for (const key of SETTINGS_KEYS) {
      snapshot[key] = this.#settings[key]
      // 页面读的键名是 `<字段>Default`（`client.js` 与既有测试都按这个名字读），保持不变。
      snapshot[`${key}Default`] = SETTINGS_DEFAULTS[key]
    }
    return snapshot
  }

  /**
   * 设置页要用的形状：当前值与默认值**分成两个对象**。
   *
   * 方法名与返回形状都照抄 `dsh-wechat-plugin` 的同名方法（它在
   * `client.js` 里被解构成 `settings?.settings` 与 `settings?.defaults`），
   * 这样设置页移植过去无需改写数据流。
   *
   * 两个对象同键，键集同样来自 schema。
   */
  settingsForPage() {
    const settings = {}
    const defaults = {}
    for (const key of SETTINGS_KEYS) {
      settings[key] = this.#settings[key]
      defaults[key] = SETTINGS_DEFAULTS[key]
    }
    return { settings, defaults }
  }

  /**
   * 从状态文件读回用户调过的设置。
   *
   * 在 `start()` 里调用一次，也就是在任何消息到达、任何工具被调用之前。
   * 缺字段保持默认值，所以老状态文件与全新安装都是同一套代码路径。
   *
   * **由 schema 驱动**：逐字段过 schema 的校验器，通过才写进 `#settings`。
   * 校验器同时负责"类型对不对"与"值合不合理"（上下限、取整），
   * 而 `state.js` 用的是同一张表——所以两层边界不可能各自漂移。
   */
  async hydrateSettings() {
    try {
      const { settings } = await this.#store.read()
      /*
       * 状态文件可能被手工编辑过，而一个十小时的窗口在运行时的表现就是
       * "设置生效了但什么都不工作"，所以读回时**照旧过一遍上下限**——
       * 与 `applySettings` 用的是同一批校验器，"读回"与"施加"因此不会分家。
       *
       * 类型不对或越界**整条丢弃**：保持默认值（对读回而言就是默认值）。
       */
      Object.assign(this.#settings, normalizeSettings(settings))
      /*
       * 会话文件夹：读回时就把路径落实（校验与回落都在 `#switchWorkspace` 里），
       * 否则重启后仍会用构造时那个目录。
       *
       * ⚠️ `workspacePath` 与其余字段有一处**刻意的不同**：它在运行时的值是 trim 过的
       * （见 `applySettings`），而那一步在 schema 里——schema 只判类型、不动字符，
       * 因为设置页要显示用户填的原文。所以这里补一次 trim。
       */
      this.#settings.workspacePath = this.#settings.workspacePath.trim()
      this.#switchWorkspace(this.#settings.workspacePath)
      bootLog(
        `设置已读回：preset=${this.#settings.permissionPreset} confirm=${String(this.#settings.requireConfirmation)} ` +
          `crossNotify=${String(this.#settings.allowCrossSessionNotify)} settle=${String(this.#settings.settleMs)}`,
      )
    } catch (error) {
      // 读不回设置不该阻止渠道启动：默认值是安全的，用户顶多需要再设一次。
      this.#recordError(`读回设置失败（按默认值继续）: ${describeError(error)}`)
    }
  }

  /**
   * 把当前设置写回状态文件。失败只记录——写不进去不该让这次设置变更看起来"没发生"。
   *
   * 落盘清单**由 schema 派生**（遍历 `SETTINGS_KEYS`），不再手抄第二遍。
   * 这一点是这次修复的核心：原来 `state.js` 的加载白名单与本方法的落盘清单是
   * 两份各写各的九项名单，加设置时漏掉任何一份都会静默丢字段，
   * 而**每次写盘都会重新加载并重新规范化**，于是下一次写盘把丢失持久化。
   */
  async #persistSettings() {
    try {
      const settings = {}
      for (const key of SETTINGS_KEYS) settings[key] = this.#settings[key]
      await this.#store.update((next) => {
        next.settings = settings
      })
    } catch (error) {
      this.#recordError(`保存设置失败: ${describeError(error)}`)
    }
  }

  /**
   * 施加一批设置变更。
   *
   * **由 schema 驱动**：每个字段过它自己的校验器，通过才写。校验器返回 `undefined`
   * 的含义是"这个字段不改"（保持原值），而不是"回落到默认值"——一个畸形请求不该把
   * 用户已经调好的设置重置掉。
   *
   * 两个字段额外做事：
   *
   * - `permissionPreset` 走 `setPermissionPreset()`（`persist: false`：本方法末尾统一
   *   写一次盘，不必为同一次变更写两遍），因为它还要打日志；
   * - `workspacePath` 要 trim 并立即落实路径（坏路径只能"没生效"，绝不能抛到这里）。
   *
   * ⚠️ **`requireConfirmation` 变更后必须重新注册工具**：那个策略只存在于
   * `session_control` 的**描述**里，而注册表是按值取走描述的（见 `session-tool.js`）。
   * 不重新注册的话，设置页看起来"改了但没效果"。
   *
   * @param patch - 要改的字段。
   * @returns 变更后的快照。
   */
  applySettings(patch) {
    const before = this.#settings.requireConfirmation
    /*
     * 变更前的生效值，以及请求里**真正带了**的字段名。
     *
     * 这两样加上变更后的值，是 `state.json` 给不出的信息：状态文件只记"现在存的是什么"，
     * 于是"这次保存根本没发出来"和"发出来了、主机没收下"在文件里长得一模一样。
     * 三个都在手里的地方只有这里，所以日志就在这里写（见下面 `设置已存档`）。
     */
    const prior = {}
    for (const key of SETTINGS_KEYS) prior[key] = this.#settings[key]
    const requested = []
    /** 请求带了、但校验不过因此被丢弃的字段（"发了没收下"的那一类）。 */
    const dropped = []
    for (const key of SETTINGS_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(patch ?? {}, key)) continue
      requested.push(key)
      const normalized = SETTINGS_SCHEMA[key].normalize(patch?.[key])
      if (normalized === undefined) {
        // 越界/类型不对：**保持原值**（schema 的语义，不是回落默认值）。丢弃这件事下面会写进日志。
        dropped.push(key)
        continue
      }
      if (key === 'permissionPreset') {
        this.setPermissionPreset(normalized, { persist: false })
      } else if (key === 'workspacePath') {
        /*
         * 会话文件夹：空串合法（含义是"用默认位置"）。
         * 具体的校验与回落交给 `#switchWorkspace`——它保证坏路径只是"没生效"，
         * 而不是把异常抛到 `apply` 上去让整个应用起不来。
         */
        this.#settings.workspacePath = normalized.trim()
        this.#switchWorkspace(this.#settings.workspacePath)
      } else {
        this.#settings[key] = normalized
      }
    }
    if (this.#settings.requireConfirmation !== before) {
      bootLog(`requireConfirmation 已改为 ${String(this.#settings.requireConfirmation)}，重新注册工具`)
      this.refreshTools()
    }
    /*
     * 一行一次存档，**旧值和新值都写**。
     *
     * 被丢弃的字段会记成 `旧 -> 旧`，而这一行本身就是证据：字段出现在请求里、值却没人动，
     * 只能是"发了没收下"。所以还额外写出请求里的原始值——只有"值没动"这一半信息时，
     * 排查的人仍然得去猜是越界、类型不对，还是页面压根没发。
     *
     * ⚠️ 这里写的是**生效值**（内存里的设置），不是磁盘：落盘是 `#persistSettings`，
     * 它自己会为写失败记一行。两者分开写，是为了让"改生效了但没落盘"也看得出来。
     */
    const changes = requested.map((key) => {
      const pair = `${key} ${formatSettingValue(prior[key])} -> ${formatSettingValue(this.#settings[key])}`
      return dropped.includes(key)
        ? `${pair}（请求 ${formatSettingValue(patch?.[key])}，被丢弃，保持原值）`
        : pair
    })
    bootLog(
      changes.length === 0
        ? '设置已存档：请求里没有可用的设置字段——什么也没改'
        : `设置已存档：${changes.join('; ')}`,
    )
    this.#fire('保存设置', () => this.#persistSettings())
    return this.settingsSnapshot()
  }

  /**
   * 注销并重新注册全部工具。
   *
   * 用于描述按值被取走的那些设置发生变更之后。
   */
  refreshTools() {
    this.disposeTools()
    this.registerTools()
  }

  /** 是否已连上 QQ。 */
  get connected() {
    return this.#bot !== undefined
  }

  /**
   * 是否应当在启动时自动连接。
   *
   * 先看 config 的 `autoStart`，再看状态文件里用户上次的选择。
   */
  async enabled(configAutoStart) {
    if (configAutoStart === true) return true
    const state = await this.#store.read()
    return state.autoStart === true
  }

  /**
   * 连接 QQ。
   *
   * @param appId - 要连接的机器人。省略时取状态里第一个已启用的账号。
   */
  async start(appId) {
    if (this.#bot !== undefined) {
      bootLog('start: 已经在运行，忽略重复调用')
      return
    }
    // 先读回用户调过的设置：这样在任何消息到达之前，权限预设与会话工具描述都已经是用户选的那份。
    await this.hydrateSettings()
    const state = await this.#store.read()
    const targetAppId = appId ?? Object.keys(state.accounts).find((id) => state.accounts[id]?.enabled !== false)
    if (targetAppId === undefined) {
      bootLog('start: 没有已绑定的账号，等待扫码绑定')
      return
    }
    if (!this.#credentials.available) {
      bootLog('start: 此组合没有凭据服务，无法取回 AppSecret')
      return
    }
    const credential = await this.#credentials.load(targetAppId)
    if (credential === undefined) {
      bootLog(`start: 找不到 ${targetAppId} 的凭据（可能被清理了），需要重新扫码绑定`)
      return
    }

    this.#appId = targetAppId
    const bot = new QQBot({
      appId: credential.appId,
      appSecret: credential.appSecret,
      accountId: credential.appId,
      /*
       * ⚠️ **这个 logger 不是可选的装饰。**
       *
       * SDK 会把 handler 里抛出的异常**接住并打到 `logger.error`**，不让它变成
       * unhandled rejection（`USAGE.md:265`）。不传 logger 就落到 SDK 的默认空 logger 上，
       * 于是 handler 出错时日志里**一片空白**——现象只是"连上了、但发消息没反应"。
       *
       * 这不是假想的风险：第三步探针的 message handler 因为在箭头函数里用了 `arguments`
       * 而第一行就 ReferenceError，因为没有接日志，查了一整轮才找到
       * （见 `docs/STEP3-能力调研与实现规格.md` 顶部第 5 条）。
       *
       * **空白应当被当成"缺少观测"，而不是"没有发生"。** 所以三条都接到 `bootLog` 上，
       * 与插件自己的日志共用一份时间线。
       */
      logger: {
        info: (message) => bootLog(`sdk info  ${message}`),
        warn: (message) => bootLog(`sdk warn  ${message}`),
        error: (message) => bootLog(`sdk error ${message}`),
      },
    })

    bot.on('ready', () => bootLog(`READY appId=${credential.appId}`))
    bot.on('resumed', () => bootLog('RESUMED'))
    bot.on('error', (error) => this.#recordError(`qq sdk error: ${describeError(error)}`))
    // 只处理私聊。群里的事件直接忽略——本插件不做群聊。
    bot.on('rawEvent', (eventCtx) => {
      recordOnce(this.#seen, '#rawEventTypes', `rawEvent: ${eventCtx.eventType}`)
    })
    bot.on('message', (middlewareCtx, message) => this.#handleInbound(middlewareCtx, message))

    this.#bot = bot
    bootLog(`start: 正在连接 appId=${credential.appId}`)

    // start 会一直挂着直到 stop/abort，所以不 await。
    void bot.start().catch((error) => {
      this.#recordError(`连接失败: ${describeError(error)}`)
      bootLog(`start: 连接失败 ${describeError(error)}`)
      this.#bot = undefined
    })
  }

  /** 断开连接。 */
  async halt() {
    this.#stopTypingAll()
    // 停靠批次的定时器必须在这里清掉：**不能有定时器活得比插件长**，
    // 否则它会在运行时被拆除之后触发，去碰已经不存在的东西。
    this.#clearParked()
    await this.flushReplies()
    const bot = this.#bot
    this.#bot = undefined
    if (bot !== undefined) {
      try {
        bot.stop()
      } catch (error) {
        bootLog(`halt: stop 抛错 ${describeError(error)}`)
      }
    }
  }

  /**
   * 保存一份凭据并尝试连接。
   *
   * **扫码绑定与手工录入共用这一条路径**——两者的差别只在入口，落地逻辑必须一致，
   * 否则"手填能用、扫码不能用"这类分歧会长期潜伏。
   *
   * @param params.appId - 机器人 AppID。
   * @param params.appSecret - 机器人 AppSecret。
   * @param params.userOpenid - 扫码人 openid（可选）。
   * @returns 保存后的 payload（含 appSecret，仅返回给调用方，不落日志）。
   */
  async rememberCredentials({ appId, appSecret, userOpenid }) {
    const saved = await this.#credentials.save({ appId, appSecret, userOpenid })
    await this.#store.update((next) => {
      next.accounts[appId] = {
        appId,
        userOpenid: saved.userOpenid,
        boundAt: saved.boundAt,
        enabled: true,
      }
      next.autoStart = true
    })
    bootLog(`凭据已保存 appId=${appId} openid=${saved.userOpenid ?? '(未提供)'}`)
    if (this.#bot === undefined) {
      await this.start(appId)
    }
    return saved
  }

  /**
   * 忘记某个账号：删除凭据与其状态。断开连接。
   *
   * @param appId - 机器人 AppID。
   */
  async forget(appId) {
    await this.halt()
    await this.#credentials.remove(appId)
    await this.#store.update((next) => {
      delete next.accounts[appId]
      for (const [conversationId, binding] of Object.entries(next.bindings)) {
        if (binding.accountId === appId) delete next.bindings[conversationId]
      }
    })
    if (this.#appId === appId) this.#appId = ''
    /*
     * 把扫码状态也复位。
     *
     * 不复位的话，设置页会**继续显示「已连接：<刚解绑的 appId>」**——因为
     * `QqBindSession` 的 `succeeded` 是终态、没有过期机制（微信有
     * `LOGIN_RESULT_TTL_MS = 30s` 来清它，QQ 这边没有）。
     *
     * 刚解绑却显示已连接，是那种"看起来正常所以没人报"的错误：
     * 用户会以为解绑没成功，然后再点一次。
     */
    this.#bindSession.cancel()
    bootLog(`已解绑 appId=${appId}`)
  }

  // ------------------------------------------------------------ 设置页支撑

  /** 扫码绑定的当前状态，供设置页轮询。 */
  bindSnapshot() {
    return this.#bindSession.snapshot()
  }

  /** 开始扫码绑定。 */
  async startBind(source) {
    await this.#bindSession.start({ source })
    return this.#bindSession.snapshot()
  }

  /** 取消扫码绑定。 */
  cancelBind() {
    this.#bindSession.cancel()
    return this.#bindSession.snapshot()
  }

  /**
   * 打开或关闭这个渠道。
   *
   * 关闭只停止监听，**保留凭据**——这与 `forget()` 的区别正是设置页上半部分
   * "停用"与下半部分"解绑"的区别。
   *
   * @param enabled - 目标状态。
   */
  async setEnabled(enabled) {
    await this.#store.update((next) => {
      next.autoStart = enabled
    })
    if (enabled) await this.start()
    else await this.halt()
    return await this.status()
  }

  /**
   * 已绑定账号的清单，供设置页展示与解绑。
   */
  async accountsSnapshot() {
    const state = await this.#store.read()
    const rows = []
    for (const [appId, account] of Object.entries(state.accounts)) {
      let configured = false
      try {
        const described = await this.#credentials.describe(appId)
        configured = described?.configured === true
      } catch {
        configured = false
      }
      rows.push({
        appId,
        userOpenid: account.userOpenid,
        boundAt: account.boundAt,
        enabled: account.enabled !== false,
        hasCredentials: configured,
        active: this.#appId === appId && this.#bot !== undefined,
      })
    }
    return rows
  }

  // ---------------------------------------------------------------- 入站

  /**
   * 一条私聊消息 → 一次 DSH 提交。
   *
   * @param middlewareCtx - SDK 中间件上下文（保留给后续中间件使用）。
   * @param message - SDK 归一化后的入站消息。
   */
  async #handleInbound(middlewareCtx, message) {
    try {
      if (message.kind !== 'c2c') {
        // 不做群聊。记录一次见过的类型即可。
        recordOnce(this.#seen, `#ignoredKind:${message.kind}`, `忽略非私聊消息 kind=${message.kind}`)
        return
      }
      // 官方文档明确：极端情况下同一条 msg_id 可能重复推送。必须去重。
      if (typeof message.messageId === 'string') {
        if (this.#handledMessages.has(message.messageId)) {
          bootLog(`入站: 重复消息，已忽略 ${message.messageId.slice(0, 24)}…`)
          return
        }
        this.#handledMessages.add(message.messageId)
        if (this.#handledMessages.size > 2000) {
          // 粗略裁剪即可——去重只需要覆盖重投递窗口。
          this.#handledMessages = new Set([...this.#handledMessages].slice(-1000))
        }
      }

      const accountId = this.#appId
      const peerId = message.senderId
      if (peerId === undefined || peerId === '') {
        this.#recordError('入站消息没有 senderId，无法定位会话')
        return
      }
      const conversationId = conversationKey(accountId, peerId)

      // 记住这条消息，回复时才能走被动通道。
      this.#lastInbound.set(conversationId, {
        peerId,
        msgId: message.messageId,
        at: Date.now(),
      })

      const attachments = message.attachments ?? []

      /*
       * 用户说话了 → 窗口重新打开 → **先补发积压的待发消息**，再处理这条。
       *
       * 顺序是有意的（微信的注释）：用户自己的消息才是"重新打开窗口"的东西，
       * 所以积压的通知属于这条回答**之前**——否则用户等着的通知会出现在
       * 一条毫不相干的回复下面，看起来像是答非所问。
       */
      await this.#flushPending(conversationId)

      /*
       * 带附件的消息先**停靠**，不立刻投递。
       *
       * 理由（微信的注释写得很清楚）：用户先发一张图，再打字问「这是什么」——
       * 如果两条各自投递，agent 只拿到图片那一轮就开始答，而问题在下一轮。
       * 停靠把"图 + 紧随其后的说明"合成一次提交。
       *
       * **下载在停靠时就做**，因为 QQ 的附件是**会过期的 CDN 链接**，
       * 等窗口关闭再去取可能已经失效。
       */
      if (attachments.length > 0) {
        await this.#park(conversationId, message, attachments)
        return
      }

      /*
       * 引用与正文**分开**（见 `prompt.js` 的 `splitRouteText`）：
       * 引用里的正文要单独交给路由（它靠比对正文认出被引的那一屏清单），
       * 而"引用清单再回 `/switch 3`"必须按 `/switch` 解析——合成文本以 `[引用]` 开头时
       * 它看起来不是指令，会整条落进 agent 那一支。
       * `composed`（带引用的原形态）留给交互拦截与交付，那两条路一个字都不变。
       */
      const { text, quoted, composed } = splitRouteText(message)
      /*
       * 只引用、什么都没写也是一条消息（交给 agent 时就是那句引用），不该被丢掉。
       *
       * 反过来，走到这个 return 说明这条消息**没有任何可投递内容**：正文为空、没有引用、
       * 也没有附件（带附件的在上面就停靠了）。也就是说用户确实发了东西，而我们这边空空如也
       * ——协议里没映射到的形态（卡片 / 类型不在我们认识的表里）就是长这样。
       * 从前它是裸 `return`：消息消失，而日志里一个字都没有，连"收到过这条"都查不出来。
       *
       * ⚠️ 为什么是 `bootLog` 而**不是** `#recordError`：这一条不是"别处失败的结果"，而是
       * "平台递过来一个我们解析不出内容的形态"。它必须有声音（否则用户的消息凭空消失、
       * 任何地方都查不到），但不该占错误环的位置——用户的可见面是 `boot.log`（`logPath()`，
       * 设置页读的就是它），而错误环要留给真正失败的操作。`scripts/verify-send-path.mjs`
       * 那 60 项测试正是拿"空内容的入站消息"当**脚手架**（它设计上什么都不碰，
       * 见那里的 `seeInbound`），把它记成错误会让那些守着的断言变红——那等于把脚手架的约定
       * 误当成缺陷。
       */
      if (composed.trim() === '') {
        bootLog(
          `入站消息没有可投递内容，已丢弃：conversation=${conversationId} ` +
            `message=${String(message.messageId ?? '(none)')} ` +
            `msgType=${String(message.msgType ?? '(none)')} ` +
            `elements=${String(Array.isArray(message.msgElements) ? message.msgElements.length : 0)}`,
        )
        return
      }

      /*
       * 交互拦截必须在这里——**投递链的最前面**。
       *
       * 否则用户对一个权限提示回的「1」会被当成新请求发给 agent，
       * 而那条提示永远悬在那里。带附件的消息已在上面分流，不参与拦截。
       */
      if (await this.#settleInteraction(conversationId, composed)) return

      // 认领停靠的批次：它的说明文字排在本条之前（先发的图，后问的话）。
      const parked = this.#claimParked(conversationId)
      const combined = [parked.text, text].filter((part) => part.trim() !== '').join('\n\n')

      await this.#deliverPrompt({
        conversationId,
        accountId,
        peerId,
        text: combined,
        attachmentLines: parked.lines,
        ...(quoted === undefined ? {} : { quoted }),
      })
    } catch (error) {
      this.#recordError(`处理入站消息失败: ${describeError(error)}`)
    }
  }

  /**
   * 投递一次提示词：路由 → 提交。
   *
   * 从 `#handleInbound` 里拆出来，因为**停靠窗口到期**时也要走同一条路
   * （那时没有新的入站消息，只有一批停靠的附件）。一份实现、两个调用者。
   *
   * @param params.quoted - 被引用消息的正文；只交给路由（它靠它认出被引的那一屏清单），
   *   交付给 agent 时按原来的顺序拼回正文之前。
   */
  async #deliverPrompt({ conversationId, accountId, peerId, text, attachmentLines, quoted }) {
    // 交给路由：它要么直接回一句（指令），要么给出该交给哪个会话的提示词。
    // 与微信插件同构——`/new` `/list` `/switch` `/current` `/cancel` `/help` 都在路由里实现，
    // 本运行时只负责传输。
    const routed = await this.#router.route({
      conversationId,
      accountId,
      peerId,
      text,
      ...(quoted === undefined ? {} : { quoted }),
    })

    if (routed.kind === 'reply') {
      /*
       * 浏览位置只在这一屏**真的发出去**之后才前进。
       *
       * 与微信同一条：一个没送到的消息不该让位置往前挪，否则下一次「查看其余」会跳过一整屏——
       * 而用户从没见过那一屏。
       */
      if (await this.#send(conversationId, routed.text)) {
        await this.#router.delivered(conversationId, routed)
      }
      return
    }

    // 交给 agent 就意味着用户已经走开：这一次浏览到此为止（与微信同一条）。
    await this.#router.delivered(conversationId, routed)

    /*
     * ★ 对话被搬到新会话时，**先说这句话**。
     *
     * 路由会换掉一条会话已经归档、或磁盘上已经不存在的绑定；没有这句话，用户看到的
     * 就是"回答来自一条没有任何历史的对话，且完全没有解释"——而那次搬家只出现在日志里。
     * 所以它在提示词**之前**发，而且**即使下面的提交失败也已经发出去了**：
     * 它解释的是用户现在所处的那条对话的**身份**，与这一条消息送没送到无关。
     *
     * ⚠️ 与微信实现的差别（如实写明）：微信在 `bundle/src/host.ts` 里发送 notice 之前
     * 会先查一次账号、查不到就记一行"notice not sent"，因为它的发送入口需要账号对象。
     * 这里 `#send(conversationId, text)` 自己就带账号（按 appId 直取），没有那个前置条件，
     * 所以这里少一层；发送失败由 `#send` 自己记错（它不静默）。
     */
    if (routed.decision.notice !== undefined) {
      bootLog(
        `会话已换绑并回话：conversation=${conversationId} session=${routed.decision.sessionId}`,
      )
      await this.#send(conversationId, routed.decision.notice)
    }

    this.#startTyping(conversationId, peerId)

    /*
     * 渠道上下文说明（`presenceNote`）。
     *
     * 没有它，agent 会对着**手机**说「打开 C:\…」——那正是这条说明要防的失败。
     * 它告诉对方：你在和一个手机用户说话，他看不到这台电脑的屏幕和文件系统，
     * 要给他看东西就**直接发**，并且回复要短。
     *
     * **它和用户的话在同一条消息里**（说明排在最后），会话的第一条也一样。
     * 从前不是：命名那条被拆成两条，用"少一条消息"换一个不被污染的标题。
     * 现在标题在**创建会话时显式交给宿主**（`router.js` 的 `#bind` →
     * `sessionController.rename`，见本文件的 `#nameSession`），所以首条消息
     * 不必再为标题让路——而"两条先后独立的用户消息"正是用户报的那个 bug。
     * 形状与理由都在 `prompt.js` 的 `composeDelivery` 里。
     */
    const note = this.#settings.presenceNote.trim()

    // 引用排在最前，与 `prompt.js` 合成时的顺序一致（那里专门有断言钉着）。
    const promptText = [quoted === undefined ? '' : `[引用] ${quoted}`, routed.decision.prompt]
      .filter((part) => part !== '')
      .join('\n')

    const outbound = composeDelivery({ promptText, attachmentLines, note })

    let accepted = false
    for (const part of outbound) {
      // 被拒的 steer 是一个真实结果（它瞄准的那个回合可能刚好结束），所以退到队列再试，
      // 而不是把消息丢掉。
      if (await this.#submit(routed.decision.sessionId, part, 'steer')) accepted = true
      else if (await this.#submit(routed.decision.sessionId, part, 'queue')) accepted = true
    }

    if (!accepted) {
      this.#stopTyping(conversationId)
      /*
       * ★ 这条失败**必须留一行**（微信那批修复的第四条：提交失败没带会话 id）。
       *
       * 上面 `#submit` 记的是**每一次尝试**（steer 被拒 / queue 也失败），而"整条消息一个字都没交出去"
       * 是另一件事：它从前只把内容还给用户，日志里没有任何一行说明"哪条会话、哪条对话投递失败了"。
       * 用户看到的是一句重发提示，排查的人看到的是一片空白。
       */
      this.#recordError(
        `提交任务失败：插话与排队都未成功（conversation=${conversationId} session=${routed.decision.sessionId}）`,
      )
      // 消息是这里唯一不可重建的东西，绝不能丢。
      await this.#send(conversationId, `没能把消息交给会话，请重发一次。\n\n你的内容：\n${text}`)
    }
  }

  /**
   * 停靠一批附件，等用户补一句指令（或等窗口到期）。
   *
   * `autoReplyAttachments` 关掉时**不设定时器**，于是一直等下去。批次本身仍然记着，
   * 所以之后任何一条文字消息都会把它一起带上——这才是"只在我说了话时才回答"，
   * 而不是"忽略附件"（微信的原话）。
   */
  async #park(conversationId, message, attachments) {
    const existing = this.#pending.get(conversationId)
    if (existing !== undefined) clearTimeout(existing.timer)

    const lines = [...(existing?.lines ?? [])]
    const dir = this.#mediaDir()
    for (const [index, attachment] of attachments.entries()) {
      const downloaded = await downloadAttachment({ attachment, dir, index })
      lines.push(
        downloaded === undefined ? describeMissing(attachment, index) : describeMedia(downloaded),
      )
    }

    const text = [existing?.text ?? '', this.#composePrompt({ ...message, attachments: [] })]
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .join('\n\n')

    const timer = this.#settings.autoReplyAttachments
      ? setTimeout(() => {
          // 窗口关闭时仍没有指令，就把附件单独交出去。
          // `#deliverParked` 自己认领这批，先删掉会把附件丢掉并发出一轮空的。
          this.#fire('停靠窗口到期', () => this.#deliverParked(conversationId))
        }, this.#settings.mergeWindowMs)
      : undefined
    timer?.unref?.()

    this.#pending.set(conversationId, {
      lines,
      text,
      timer,
      accountId: this.#appId,
      peerId: message.senderId,
    })
    bootLog(
      `附件已停靠：conversation=${conversationId} 附件=${String(lines.length)} ` +
        `${timer === undefined ? '（自动回复已关，等指令）' : `窗口=${String(this.#settings.mergeWindowMs)}ms`}`,
    )
  }

  /** 认领停靠的批次：清掉定时器、删除、交回内容。 */
  #claimParked(conversationId) {
    const parked = this.#pending.get(conversationId)
    if (parked === undefined) return { lines: [], text: '' }
    clearTimeout(parked.timer)
    this.#pending.delete(conversationId)
    return { lines: parked.lines, text: parked.text }
  }

  /** 停靠窗口到期：把这一批单独投递出去。 */
  async #deliverParked(conversationId) {
    const parked = this.#pending.get(conversationId)
    if (parked === undefined) return
    const { lines, text } = this.#claimParked(conversationId)
    // 附件本身也算内容：即使没有说明文字也要投递，否则用户的图就石沉大海。
    await this.#deliverPrompt({
      conversationId,
      accountId: parked.accountId,
      peerId: parked.peerId,
      text,
      attachmentLines: lines,
    })
  }

  /** 丢弃全部停靠批次。卸载时调用，避免定时器活得比插件长。 */
  #clearParked() {
    for (const parked of this.#pending.values()) clearTimeout(parked.timer)
    this.#pending.clear()
  }

  /** 媒体目录，按需创建并缓存。 */
  #mediaDir() {
    if (this.#mediaDirPath === undefined) {
      // 用**工作区路径本身**，不是 home + 常量目录名：路径可自定义后，
      // 后者会把媒体落到别的地方去。
      this.#mediaDirPath = mediaDir(this.#workspace)
    }
    return this.#mediaDirPath
  }

  /**
   * 切换会话文件夹。
   *
   * **坏路径绝不能让它抛出去**：这里是在设置变更或启动读回时被调用的，
   * 一个抛出的异常会顺着 apply 上去把启动搞失败。所以校验不过就回落到
   * 默认位置并记下理由——用户看到的是"没生效"，而不是"应用起不来"。
   *
   * 切换时必须清掉两个缓存：
   * - `#workspaceId`：它记的是**旧目录**对应的工作区 id，不清会继续往旧工作区里塞会话
   * - `#mediaDirPath`：它派生自旧目录
   *
   * @param candidate - 用户填的路径（空串 = 默认）。
   * @returns 实际生效的路径。
   */
  #switchWorkspace(candidate) {
    const resolved = resolveWorkspaceDir(this.#home, candidate)
    const changed = !isSameWorkspace(resolved.path, this.#workspace)
    this.#workspace = resolved.path
    // 路由也有一份"本工作区是哪个"（`/list` 用它分组与计数），所以必须一起换。
    this.#router?.setOwnWorkspace(resolved.path)
    if (changed) {
      this.#workspaceId = undefined
      this.#mediaDirPath = undefined
    }
    if (resolved.fellBack) {
      bootLog(`会话文件夹回落默认：${String(resolved.reason)}（仍用 ${resolved.path}）`)
      this.#recordError(`会话文件夹路径不可用，已回落默认位置：${String(resolved.reason)}`)
    } else if (resolved.reason !== undefined) {
      /*
       * `fellBack: false` 却带着理由 = **默认位置自己不可用**（用户没填自定义路径）。
       * 这一条同样必须可见：返回的路径正是"要用的那个"，只是它建不出来/写不进去，
       * 拿出来会正好撞上会话 cwd 的 `ENOENT`。`resolveWorkspaceDir` 的契约是"永不抛"，
       * 所以理由只能由这里说出来。
       */
      bootLog(`会话文件夹不可用：${String(resolved.reason)}（仍用 ${resolved.path}）`)
      this.#recordError(`会话文件夹路径不可用：${String(resolved.reason)}`)
    } else if (changed) {
      bootLog(`会话文件夹已切换为 ${resolved.path}（只影响之后新建的对话）`)
    }
    return resolved.path
  }

  /**
   * 把入站消息拼成给 agent 的文本。
   *
   * 实现已抽到 `prompt.js`（纯函数、可测）。这里保留方法只是为了调用点读起来连续。
   * 合成的三件事与各自理由都在那个模块里。
   */
  #composePrompt(message) {
    return composePrompt(message)
  }

  /**
   * 让宿主**创建**一条会话，并把它归到本频道的工作区。
   *
   * ## 只用于创建
   *
   * `0.2.1-rc.2` 起 `create` 不再是"创建或采纳"：已经跑过一轮的会话不会被采纳，
   * 而是另铸一个 id（见 `#gateway().ensureSession` 的注释）。所以这条路径**只该收到
   * 磁盘上还没有记录的 id**——路由的 `#bind`（`/new`、首条消息）与记录被删后的重建；
   * 已有会话从来不到这里来，`prompt` 会自己 resume。
   *
   * ## 为什么要用 workspaceId 而不是 cwd
   *
   * 微信插件的原话：**"指名工作区而不是目录，才是把会话归进一个真正的文件夹的东西；
   * 工作区在底下提供同一个 cwd。"** 只给 `cwd` 会让会话落进「未分组」。
   *
   * ## 为什么不再读"会话自己的工作区"
   *
   * 那段分支（`storedSessionWorkspace`）只为"create 会 resume 一条属于别的项目的旧会话"
   * 而存在：那时必须指名**那个项目**的工作区，否则会把用户限制在本频道的会话里。
   * 既然已有会话根本不进 `create`，这个路径上读出来的永远是"没有记录"，
   * 分支也就永远走不到它服务的那一半。所以这里一律用本频道的工作区。
   *
   * @param sessionId - 要创建的会话 id（磁盘上没有记录的）。
   */
  async #createSession(sessionId) {
    const workspaceId = await this.#workspaceIdFor(this.#workspace, WORKSPACE_TITLE)
    if (workspaceId === '') {
      // 没有工作区服务：退回钉死的 cwd，会话显示在「未分组」下。
      await this.#ctx.sessionController.create({ sessionId, cwd: this.#workspace })
    } else {
      await this.#ctx.sessionController.create({ sessionId, workspaceId })
    }
    this.#applyPermissionPreset(sessionId)
  }

  /**
   * 把一个标题**显式**交给宿主。
   *
   * ## 为什么必须显式给
   *
   * 会话还没有标题时，DSH 会**从首条消息猜**一个
   * （`fallbackSessionTitle`，实现 `dsh-session-title/lib/types/normalize.js:66`，
   * 参数 5 词 / 40 字节见 `@deepseek-ai/dsh-base/cordis.patch.yml:58-59`），
   * 而那条消息是频道拼出来的：用户的话 + 附件描述 + 渠道说明。
   * 于是标题里混进渠道说明——这就是"标题被污染"。
   *
   * 从前绕开它的办法是把命名那条拆成两条消息（先用户的话、再说明），
   * 代价正是用户报的 bug：agent 收到两条**先后独立的用户消息**。
   * 标题在这里显式给出之后，首条消息就不必再为它让路。
   *
   * ## 为什么落在 `rename` 上
   *
   * `sessionController.create` 的请求里**没有标题字段**
   * （"requested identity, location, and Agent preset"，
   * `dsh-api-session-controller/lib/types/commands.js:107`），
   * 所以"创建时给标题"只能落在这里。而 `rename` 会把标题**钉住**：
   * 自动生成被取代、之后的消息也不再触发
   * （`dsh-session-title/lib/types/index.js:243-267`），
   * 那正是"标题不被首条消息污染"所需要的那条保证——**普通的重命名做不到这件事**。
   *
   * ## 顺序：必须 await 在提交提示词之前
   *
   * 宿主侧的首条消息一到就可能起自动命名，而这里做的正是抢在它前面把标题钉死。
   * 所以这条路**不走 `#fire`**（那会让两者去赛跑，结果取决于调度）。
   * 它整条都在 await 链上：`#handleInbound` → `#deliverPrompt` → `route` → `#bind`。
   *
   * ## 失败：记下来，但不丢消息
   *
   * 尽力而为。没有 `rename` 接口（旧宿主）或调用失败时只记一行，消息照发——
   * 最坏情况是标题退回"宿主自己从首条消息猜"，也就是修复前的行为。
   * 一个不理想的标题远不如丢掉用户的消息严重。
   *
   * @param sessionId - 刚创建的会话。
   * @param title - 要钉住的标题，调用方保证非空。
   */
  async #nameSession(sessionId, title) {
    const controller = this.#ctx.sessionController
    if (typeof controller?.rename !== 'function') {
      bootLog(`会话标题未显式给出（此组合的会话控制器没有 rename 接口，将回落自动命名）：${title}`)
      return
    }
    try {
      await controller.rename({ sessionId, title })
      bootLog(`会话标题已给出：${title}`)
    } catch (error) {
      // 记下来而不是只吞掉：这一行是"为什么桌面上的标题是渠道说明"的唯一线索。
      this.#recordError(`会话标题未能给出（回落宿主自动命名）: ${describeError(error)}`)
    }
  }

  /**
   * 解析——或创建——拥有某目录的工作区。
   *
   * @param path - 工作区拥有的目录。
   * @param title - 仅当这是本频道自己的工作区时施加的标题。
   * @returns 工作区 id；组合里没有注册表时返回 `''`。
   */
  async #workspaceIdFor(path, title) {
    const registry = safeGet(this.#ctx, 'workspaceRegistry')
    if (registry === undefined || typeof registry.resolveByPath !== 'function') {
      // 没有工作区服务不算错误：会话照常收发，只是显示在「未分组」下。只记一次。
      if (isSameWorkspace(path, this.#workspace)) {
        recordOnce(this.#seen, '#noWorkspaceRegistry', '此组合没有工作区服务，会话将显示在「未分组」下')
      }
      return ''
    }
    // 本频道自己的工作区保留 id，且强制标题，让桌面端的文件夹读起来正确。
    // 别人的工作区原样保留它主人的命名。
    if (isSameWorkspace(path, this.#workspace) && this.#workspaceId !== undefined) {
      return this.#workspaceId
    }
    const workspace = (await registry.resolveByPath(path)) ?? (await registry.create(path))
    if (title !== '' && workspace.title !== title) await workspace.setTitle(title)
    if (isSameWorkspace(path, this.#workspace)) this.#workspaceId = workspace.id
    return workspace.id
  }

  /**
   * 给会话套上本频道选择的权限预设。
   *
   * **为什么必须有**：策略为 `ask` 的会话会把权限提示发到 QQ 然后等。在手机上那是死路——
   * 用户离开电脑正是为了不必守着提示，而一个卡在提示上的任务等于跑不了。
   * 所以默认给本频道的会话松掉这道闸。
   *
   * 两个决定成败的细节：
   * - **必须在会话第一个回合之前**：DSH 在回合开始后拒绝改预设（`agent-preset/locked`），
   *   所以它从 `#createSession` 调用，而那总是早于任何 prompt。
   * - **尽力而为**：服务可能不存在，失败也不能让用户丢消息——最坏情况是会话沿用 profile 的策略。
   *
   * @param sessionId - 刚创建的会话。
   */
  #applyPermissionPreset(sessionId) {
    const preset = this.#settings.permissionPreset
    if (preset === 'default') return
    try {
      const sessions = safeGet(this.#ctx, 'sessions')
      const presets = safeGet(this.#ctx, 'permissionPresets')
      const session = sessions?.get?.(sessionId)
      if (session === undefined || typeof presets?.set !== 'function') {
        bootLog(`权限预设 '${preset}' 未施加到 ${sessionId}：服务不可用`)
        return
      }
      presets.set(session, preset)
      bootLog(`权限预设 '${preset}' 已施加到 ${sessionId}`)
    } catch (error) {
      // 记录而非抛出：会话已跑过第一个回合是预期内的失败方式，
      // 为一个权限偏好丢掉用户的消息更糟。
      bootLog(`权限预设施加失败 ${sessionId}: ${describeError(error)}`)
    }
  }

  /**
   * 提交一次 prompt。
   *
   * `mode` 由调用方指定：默认 `'steer'`（插话，能打断正在跑的回合）。
   * 微信插件的理由同样成立：steer 被拒只意味着"晚一点回答"，而丢消息是不可修复的。
   *
   * @param sessionId - 目标会话。
   * @param prompt - 文本。
   * @param mode - `'steer'` 或 `'queue'`；省略时先 steer、被拒再 queue。
   */
  async #submit(sessionId, prompt, mode) {
    const content = [{ type: 'text', text: prompt }]
    const signal = new AbortController().signal
    if (mode !== undefined) {
      try {
        await this.#ctx.sessionController.prompt(
          { content, requestId: `qq-${randomUUID()}`, sessionId, mode },
          signal,
        )
        return true
      } catch (error) {
        // 带上会话 id：微信那批修复的第四条就是"提交失败没带会话 id"，
        // 而没有它，这行日志说不出"哪条会话被拒了"——正是排查时最需要的那一个字段。
        bootLog(`${mode} 提交被拒: session=${sessionId} ${describeError(error)}`)
        return false
      }
    }
    try {
      await this.#ctx.sessionController.prompt(
        { content, requestId: `qq-${randomUUID()}`, sessionId, mode: 'steer' },
        signal,
      )
      return true
    } catch (error) {
      bootLog(`steer 被拒，退回 queue: ${describeError(error)}`)
    }
    try {
      await this.#ctx.sessionController.prompt(
        { content, requestId: `qq-${randomUUID()}`, sessionId, mode: 'queue' },
        signal,
      )
      return true
    } catch (error) {
      this.#recordError(`排队提交也失败: session=${sessionId} ${describeError(error)}`)
      return false
    }
  }

  // ---------------------------------------------------------------- 出站

  /**
   * 助手流的每一帧。
   *
   * 保持**同步**：两个帧交错会丢掉回复的前半段。
   */
  onAssistantFrame(payload) {
    const { sessionId, text, completed, toolCall, frameShape } = readStreamFrame(payload)
    /*
     * ★ 帧里没有会话 id = **这一帧的内容无处可投**。
     *
     * 只在它**确实带着要送的东西**（可见正文或"回合结束"）时才记：那种帧按定义就是该发给用户的
     * 东西，丢掉的是真回复。而没有正文的元数据帧（`usage` / `block` 边界 / `finish`…）本来就无事可做，
     * 记它们只会把有用的行淹掉——这一步的仪器曾经就是这么变成障碍的（见下面 `frameShape` 那条）。
     *
     * 这一条同时是**宿主改了事件词汇的警报**：若 `agent.session.id` 换了位置或改了名，
     * 每一帧都会走到这个 return（而不是走到下面 `frameShape` 那一条），现象是"机器人整个不再回复"
     * 而日志里一个字都没有。`recordOnce` 保证一个形态只记一次。
     */
    if (sessionId === undefined) {
      if ((text !== undefined && text !== '') || completed === true) {
        // 桶按**形态**分：宿主换字段名（`frameShape` 有值）与"这一帧本来就没有会话 id"
        // 是两件事；"带正文的帧"与"回合结束帧"也是两件事，各记一条才看得出是哪一种。
        const shape = frameShape ?? (completed === true ? 'end' : 'chunk')
        recordOnce(
          this.#seen,
          `#framesWithoutSession:${shape}`,
          `帧没有会话 id，其中 ${String(text?.length ?? 0)} 字正文无处投递（已丢弃` +
            `${completed === true ? '，且是回合结束帧' : ''}）`,
        )
      }
      return
    }

    /*
     * ★ 只留这一条，其余四条"帧形态观测"已删除。
     *
     * 删掉的是 `#chunkTypes` / `#toolShapes` / `#blockShapes` / `#toolNames`——
     * 第一步能力体检留下的仪器。宿主的事件词汇没有文档，只能把它们印出来学；
     * 事实已经学到并**记进 `docs/HOST-STREAM-SHAPES.md`**，那里比日志更该待。
     *
     * 删它们不是嫌占地方，而是**它们把有用的行淹没了**：排查"会话夹进不去"时，
     * 日志尾部的非 sdk 行全是那五条，而想找的"路由做了什么"一个字都没有。
     * **观测手段本身变成了观测的障碍。**
     *
     * 留下的这一条性质不同：它是**警报**，只在宿主发了本解析器不认识的帧时触发
     * （那三个在正常流量上每次都会触发）。如果将来 DSH 改了事件词汇，
     * 机器人会**静默地不再回复**，而这一行是唯一能让人当场看见"帧变了"的东西。
     */
    if (frameShape !== undefined) {
      recordOnce(this.#seen, `#frameShapes:${frameShape}`, `未知帧形态（宿主可能改了事件词汇）: ${frameShape}`)
    }

    if ((text === undefined || text === '') && completed !== true) return

    this.#fire('回复聚合', async () => {
      const state = await this.#store.read()
      const conversationId = Object.keys(state.bindings).find(
        (key) => state.bindings[key]?.sessionId === sessionId,
      )
      /*
       * ★ 助手流找不到绑定的对话 → **这一轮的回答整个丢在这里**（微信的"助手流找不到绑定会话"）。
       *
       * 它是**观察**而不是错误：用户自己在电脑上开的会话每答一轮都会经过这里，那些回答本来就不该
       * 发给手机。但它同样是"绑定没了"的样子，而那时答案是**真的丢了**——没有这一行，
       * 现象就是"模型明明答完了，手机上什么都没有"，任何地方都查不到。所以每条会话记一次
       * （`recordOnce`），既留下痕迹又不把日志刷爆。
       */
      if (conversationId === undefined) {
        recordOnce(
          this.#seen,
          `#unboundStreams:${sessionId}`,
          `助手流：没有 QQ 对话绑定到 ${sessionId}，这一轮的回答不会送达` +
            `（本帧 ${String(text?.length ?? 0)} 字）`,
        )
        return
      }

      const existing = this.#replies.get(sessionId)
      if (existing !== undefined) clearTimeout(existing.timer)
      const entry = existing ?? { text: '', conversationId, timer: undefined }
      if (text !== undefined) entry.text += text

      if (completed === true) {
        // 回合结束：立刻发，不要压在静默窗口后面。
        this.#replies.set(sessionId, entry)
        this.#stopTyping(conversationId)
        await this.#flushReply(sessionId)
        return
      }
      entry.timer = setTimeout(() => {
        this.#fire('静默窗口到期发送', () => this.#flushReply(sessionId))
      }, this.#settings.settleMs)
      entry.timer.unref?.()
      this.#replies.set(sessionId, entry)
    })
  }

  /** 发出并清空某会话缓冲的回复。 */
  async #flushReply(sessionId) {
    const entry = this.#replies.get(sessionId)
    // 没有缓冲（别处已经发过 / 定时器与回合结束撞在一起）**不是丢东西**：
    // 下面那个 `text === ''` 同理——两处都无事可做，所以刻意不记日志。
    if (entry === undefined) return
    this.#replies.delete(sessionId)
    const text = entry.text.trim()
    if (text === '') return
    await this.#sendReply(entry.conversationId, text)
  }

  /**
   * 发送一条**回复**，超长时降级为文件。
   *
   * 移植自微信的 `maxReplyChars`。不降级的话，一条上万字的回复会被
   * `TEXT_CHUNK_LIMIT` 切成好几条消息刷屏——手机上要连划好几屏，
   * 而且中间那几条读起来是断的。
   *
   * 微信的原话同样适用：先给一句 caption，**免得文件变成一个没有说明的附件**。
   * 文件写进媒体目录，所以用户在电脑上也能找到它。
   *
   * @param conversationId - 对话键。
   * @param text - 已 trim 的回复正文。
   */
  async #sendReply(conversationId, text) {
    const plan = planReply(text, this.#settings.maxReplyChars)
    if (plan.kind === 'send') {
      await this.#send(conversationId, plan.text)
      return
    }
    await this.#send(conversationId, plan.caption)
    const name = longReplyFileName()
    const path = join(this.#mediaDir(), name)
    try {
      writeFileSync(path, plan.text, 'utf8')
    } catch (error) {
      // 写不进去时**退回到分条发送**，而不是让这条回复消失。
      this.#recordError(`长回复写文件失败，改为分条发送: ${describeError(error)}`)
      await this.#send(conversationId, plan.text)
      return
    }
    try {
      await this.#sendFile(conversationId, path)
      bootLog(`长回复 ${String(plan.text.length)} 字 -> ${name}`)
    } catch (error) {
      this.#recordError(`长回复发送文件失败，改为分条发送: ${describeError(error)}`)
      await this.#send(conversationId, plan.text)
    }
  }

  /**
   * 把还缓冲着的回复全部发出（关闭时用）。
   *
   * 逐条 catch：这个方法在插件卸载时被调用，而卸载路径抛出的 rejection 同样是**致命**的。
   * 关闭阶段发不出去只该记一笔，不该带走整个应用。
   */
  async flushReplies() {
    for (const sessionId of [...this.#replies.keys()]) {
      const entry = this.#replies.get(sessionId)
      if (entry !== undefined) clearTimeout(entry.timer)
      try {
        await this.#flushReply(sessionId)
      } catch (error) {
        this.#recordError(`关闭时发送失败: ${describeError(error)}`)
      }
    }
  }

  /**
   * 发一段文本到 QQ。
   *
   * **被动优先，主动兜底**：能带 `msgId` 就带（走被动回复路径），
   * 窗口过期或超过 4 次时由 `ReplyLimiter` 判定降级为主动推送。
   * 超长文本按 `TEXT_CHUNK_LIMIT` 分块，每块一次 `sendText`。
   *
   * @param conversationId - 对话键。
   * @param text - 要发送的文本。
   * @returns **是否真的发出去了**。
   *
   * ⚠️ 这个返回值不是装饰：待发队列靠它判断该不该入队。
   * 以前它什么都不返回、失败只记一行错误，于是"发失败"与"发成功"对调用方**不可区分**——
   * 队列永远不会触发（这一条是审查时发现的）。
   *
   * 仍然**不抛**：绝大多数调用点是"发一条通知"，让它们各自去处理异常会把这个方法
   * 变成一个随时可能炸的东西。需要抛的场合（`send_to_qq`）自己看返回值。
   */
  async #send(conversationId, text) {
    const bot = this.#bot
    if (bot === undefined) {
      this.#recordError('未连接 QQ，消息丢弃')
      return false
    }
    const resolved = this.#targetFor(conversationId)
    if (resolved === undefined) {
      this.#recordError('找不到对话的 peerId')
      return false
    }
    const { target, peerId, passive } = resolved

    try {
      for (const chunk of chunkText(text, TEXT_CHUNK_LIMIT)) await bot.sendText(target, chunk)
      return true
    } catch (error) {
      // 被动失败时退到主动再试一次：被拒的可能是窗口而不是内容。
      if (passive) {
        try {
          for (const chunk of chunkText(text, TEXT_CHUNK_LIMIT)) {
            await bot.sendText({ scope: 'c2c', targetId: peerId }, chunk)
          }
          bootLog('被动发送失败，主动推送成功')
          return true
        } catch (secondError) {
          this.#recordError(`主动推送也失败: ${describeError(secondError)}`)
        }
      }
      this.#recordError(`发送失败: ${describeError(error)}`)
      return false
    }
  }

  /**
   * 算出某对话这次该用的发送目标。
   *
   * **被动优先，主动兜底**：能带 `msgId` 就带（走被动回复路径），
   * 窗口过期或超过 4 次时由 `ReplyLimiter` 判定降级为主动推送。
   * 实测两者都可用（第一步 9/9 通过）。
   *
   * @param conversationId - 对话键。
   * @returns `{ target, peerId, passive }`，找不到 peerId 时 `undefined`。
   */
  #targetFor(conversationId) {
    const inbound = this.#lastInbound.get(conversationId)
    const peerId = inbound?.peerId ?? conversationId.split(':')[1]
    if (peerId === undefined || peerId === '') return undefined

    let msgId
    if (inbound?.msgId !== undefined) {
      const limit = this.#limiter.checkLimit(inbound.msgId)
      if (limit.allowed) {
        msgId = inbound.msgId
        this.#limiter.record(inbound.msgId)
      } else {
        bootLog(`被动回复不可用（${limit.fallbackReason ?? 'unknown'}），转主动推送`)
      }
    }
    return {
      peerId,
      passive: msgId !== undefined,
      target: msgId === undefined ? { scope: 'c2c', targetId: peerId } : { scope: 'c2c', targetId: peerId, msgId },
    }
  }

  /**
   * 主动推送到某个对话，供 `notify_qq` 工具使用。
   *
   * @param conversationId - 对话键。
   * @param text - 文本。
   */
  async push(conversationId, text) {
    await this.#send(conversationId, text)
  }

  // ---------------------------------------------------------------- typing

  #startTyping(conversationId, peerId) {
    if (this.#typing.has(conversationId)) return
    /*
     * 记下开始时刻，好在超过 `TYPING_MAX_MS` 之后**停止刷新**（微信的 `TYPING_MAX_MS`）。
     *
     * 没有这个上限的话，一个卡住的回合（等审批、等一个永不返回的工具）会让
     * `setInterval` 一直跑下去，用户看到的是**永远在输入**——
     * 那既是一个资源泄漏，也是一句谎话：它让"还在想"和"已经死了"看起来一样。
     */
    const startedAt = Date.now()
    const tick = () => {
      if (Date.now() - startedAt > TYPING_MAX_MS) {
        bootLog(`typing: 已超过 ${String(Math.round(TYPING_MAX_MS / 60_000))} 分钟上限，停止刷新`)
        this.#stopTyping(conversationId)
        return
      }
      // 定时器回调里同步抛出 = 宿主眼中的**致命错误**（释放整个应用）。
      // 所以这里不能直接调用，必须经 #fire。
      this.#fire('typing', () => {
        const bot = this.#bot
        if (bot === undefined) return undefined
        return bot.sendTyping({ scope: 'c2c', targetId: peerId }, TYPING_DURATION_SEC)
      })
    }
    tick()
    const timer = setInterval(tick, TYPING_REFRESH_MS)
    timer.unref?.()
    this.#typing.set(conversationId, timer)
  }

  #stopTyping(conversationId) {
    const timer = this.#typing.get(conversationId)
    if (timer === undefined) return
    clearInterval(timer)
    this.#typing.delete(conversationId)
  }

  #stopTypingAll() {
    for (const conversationId of [...this.#typing.keys()]) this.#stopTyping(conversationId)
  }

  // ------------------------------------------------------- 审批与提问回流

  /**
   * 尝试把一条入站消息当作某个挂起交互的回答。
   *
   * **必须在投递链最前面调用**，否则用户回的「1」会被当成新请求发给 agent，
   * 而那条提示永远悬在那里。
   *
   * @param conversationId - 对话键。
   * @param text - 用户消息。
   * @returns 是否消费了这条消息。
   */
  async #settleInteraction(conversationId, text) {
    const pending = this.#interactions.get(conversationId)
    if (pending === undefined) return false
    const value = pending.accept(text)
    if (value === undefined) {
      // 这不是对当前提示的回答。**重发提示而不是吞掉文本**——
      // 一条聊别的事情的消息既不该丢失，也不该被误当成糟糕的回答。
      pending.reprompt()
      return false
    }
    this.#interactions.delete(conversationId)
    bootLog(`交互已解决：${pending.kind}`)
    pending.settle(value)
    return true
  }

  /**
   * 在 QQ 上问用户一个问题并等回答。
   *
   * `peerId` 由调用方传入而不是从绑定里查：会话控制工具跑在一个可能还没有绑定的会话里
   * （它可能被要求创建第一个绑定），在这里强行查找恰好会在这个功能最需要的时候失败。
   *
   * @param conversationId - 要提问的对话。
   * @param peerId - 提问的接收者。
   * @param body - 提示文本。
   * @param kind - 交互种类，用于日志。
   * @param parse - 读回答；不是回答时返回 `undefined`。
   * @param signal - 宿主撤回请求时中止。
   * @returns 解析出的回答；请求先被撤回时 `undefined`。
   */
  async #ask(conversationId, peerId, body, kind, parse, signal) {
    const settled = Promise.withResolvers()
    // 同一对话里后来的提示替换先前的。
    const previous = this.#interactions.get(conversationId)
    if (previous !== undefined) {
      this.#interactions.delete(conversationId)
      previous.settle(undefined)
    }
    this.#interactions.set(conversationId, {
      kind,
      accept: parse,
      settle: settled.resolve,
      reprompt: () => {
        this.#fire('重发交互提示', () => this.#send(conversationId, `请回复上一条提示。\n\n${body}`))
      },
    })
    const onAbort = () => {
      this.#interactions.delete(conversationId)
      settled.resolve(undefined)
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    try {
      await this.#send(conversationId, body)
      bootLog(`交互已发出：${kind} -> ${peerId}`)
      return await settled.promise
    } finally {
      signal?.removeEventListener?.('abort', onAbort)
      // 只清理自己的那一条：更新的提示可能已经把它替换掉了。
      const current = this.#interactions.get(conversationId)
      if (current?.settle === settled.resolve) this.#interactions.delete(conversationId)
    }
  }

  /**
   * 一个会话可以为哪个对话代言。
   *
   * **只认"当前"绑定它的那个对话。**
   *
   * 微信插件的记录值得照抄：它曾经还接受"这个会话曾经服务过的任何对话"
   * （通过一张 `sessionOwners` 表），结果对话换走之后旧会话永久保有发言权，
   * 开发会话里的提问跑到了用户的手机上。**"曾经"不等于"现在"。**
   *
   * @param sessionId - 会话 id。
   * @returns 对话键，没有则 `undefined`。
   */
  async #conversationForSession(sessionId) {
    if (sessionId === undefined) return undefined
    const state = await this.#store.read()
    return Object.keys(state.bindings).find((key) => state.bindings[key]?.sessionId === sessionId)
  }

  /** 某对话的绑定与 peerId；未绑定时 `undefined`。 */
  async #askTarget(conversationId) {
    const state = await this.#store.read()
    const binding = state.bindings[conversationId]
    if (binding === undefined) return undefined
    return { peerId: binding.peerId }
  }

  /**
   * 为绑定到 QQ 的对话**认领**权限提示。
   *
   * 未绑定的对话一律委托出去，桌面面板照旧应答。
   *
   * @returns 给 `ctx.on('approval/request', ...)` 的监听器。
   */
  approvalListener() {
    return async (request, next) => {
      const record = request ?? {}
      const sessionId = sessionIdOf(record.agent)
      const conversationId = await this.#conversationForSession(sessionId)
      // 两种情况都记：一个从未被调用的应答者，和一个主动弃权的应答者，从手机上看是一样的
      // （提示都留在了桌面端），所以要写下来让下一次诊断找得到。
      bootLog(
        `审批事件：tool=${String(record.toolName)} session=${sessionId ?? '(none)'} ` +
          `${conversationId === undefined ? '非本频道会话 -> 委托' : '认领'}`,
      )
      if (conversationId === undefined) return await next()
      const target = await this.#askTarget(conversationId)
      if (target === undefined) return await next()
      const answer = await this.#ask(
        conversationId,
        target.peerId,
        presentApproval(record).body,
        'approval',
        parseApprovalReply,
        record.signal,
      )
      // 被撤回或无法回答：交还回去而不是猜。在权限提示上猜等于授予用户从未同意的东西。
      if (answer === undefined) return await next()
      return answer
    }
  }

  /**
   * 为绑定到 QQ 的对话**认领**结构化提问。
   *
   * @returns 给 `ctx.on('user-questions/request', ...)` 的监听器。
   */
  questionListener() {
    return async (request, next) => {
      const record = request ?? {}
      const questions = record.questions
      if (!Array.isArray(questions) || questions.length === 0) return await next()
      const sessionId = sessionIdOf(record.agent)
      const conversationId = await this.#conversationForSession(sessionId)
      bootLog(
        `提问事件：count=${String(questions.length)} session=${sessionId ?? '(none)'} ` +
          `${conversationId === undefined ? '非本频道会话 -> 委托' : '认领'}`,
      )
      if (conversationId === undefined) return await next()
      const target = await this.#askTarget(conversationId)
      if (target === undefined) return await next()
      const answer = await this.#ask(
        conversationId,
        target.peerId,
        presentQuestions(questions).body,
        'question',
        (reply) => parseQuestionReply(questions, reply),
        record.signal,
      )
      if (answer === undefined) return await next()
      return answer
    }
  }

  // ------------------------------------------------- 自然语言会话控制（工具）

  /**
   * 注册本插件的工具。
   *
   * 注册是 effect：返回的清理函数必须挂到 `ctx.effect`，否则插件卸载后会留下
   * 指向已拆除运行时的处理器。
   *
   * @returns 清理函数。
   */
  registerTools() {
    const tools = safeGet(this.#ctx, 'tools')
    if (tools === undefined || typeof tools.register !== 'function') {
      this.#recordError('此组合没有工具服务，agent 无法主动操作会话或发送文件')
      return () => {}
    }
    const disposers = []
    try {
      disposers.push(
        tools.register(
          sessionToolDefinition({
            requireConfirmation: this.#settings.requireConfirmation,
            control: (action, target, level, exec) =>
              this.controlSession(sessionIdOf(exec?.agent), action, target, level),
            log: (line) => bootLog(line),
          }),
        ),
      )
    } catch (error) {
      // 工具注册失败通常意味着 schema 不被接受——那正是启动审计会拒绝的一类事故，必须记下来。
      this.#recordError(`注册 ${TOOL_NAME} 失败: ${describeError(error)}`)
    }
    try {
      disposers.push(
        tools.register(
          sendToQqToolDefinition({
            deliver: (args, exec) => this.sendFromTool(args, exec),
            log: (line) => bootLog(line),
          }),
        ),
      )
    } catch (error) {
      this.#recordError(`注册 send_to_qq 失败: ${describeError(error)}`)
    }
    try {
      disposers.push(
        tools.register(
          notifyQqToolDefinition({
            deliver: (args, exec) => this.notifyFromTool(args, exec),
            log: (line) => bootLog(line),
          }),
        ),
      )
    } catch (error) {
      this.#recordError(`注册 notify_qq 失败: ${describeError(error)}`)
    }
    const disposer = () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch (error) {
          bootLog(`注销工具失败: ${describeError(error)}`)
        }
      }
    }
    // 自己留一份：设置变更后要重新注册，那时需要先注销旧的。
    this.#toolDisposer = disposer
    return disposer
  }

  /** 注销当前已注册的全部工具（若已注销则不做事）。 */
  disposeTools() {
    const dispose = this.#toolDisposer
    this.#toolDisposer = undefined
    if (typeof dispose !== 'function') return
    try {
      dispose()
    } catch (error) {
      bootLog(`注销工具失败: ${describeError(error)}`)
    }
  }

  /**
   * 执行一次会话操作。
   *
   * 核心手法：**把动作翻译回 `/` 指令，喂给同一个 `SessionRouter`**——
   * 一份实现，两个入口（打字的与说话的），所以两者不可能给出不同的结果。
   *
   * @param callerSessionId - 调用工具的 agent 所在的会话。
   * @param action - `list` / `switch` / `new` / `current` / `cancel` / `model`。
   * @param target - 目标（编号、标题、模型名、或 `all`）。
   * @param level - 推理等级（只对 `model` 有意义）。有目标时与模型一起切，
   *   没目标时只改当前模型的等级——两种写法都是 `/model` 自己的语法（见 `router.js` 的
   *   `parseModelCommand`），这里只负责拼出用户会打的那句话。
   * @returns `{ ok, detail, sessions, otherWorkspaces, otherNames }`
   */
  async controlSession(callerSessionId, action, target, level) {
    const empty = { sessions: [], otherWorkspaces: 0, otherNames: [] }
    const conversationId = await this.#conversationForSession(callerSessionId)
    if (conversationId === undefined) {
      return { ok: false, detail: '这个会话没有绑定任何 QQ 对话，无法操作。', ...empty }
    }
    const binding = (await this.#store.read()).bindings[conversationId]
    if (binding === undefined) {
      return { ok: false, detail: '这个会话没有绑定任何 QQ 对话，无法操作。', ...empty }
    }

    /*
     * 每个动作都翻译成**用户会打的那句指令**，`list all` 与 `等级` 也是。
     *
     * 这是"一份实现、两个入口"的落点：`等级` 是 `router.js` 解析的词，
     * 在这里另发明一种拼法就是对同一个请求给出第二个答案。
     */
    const withTarget = target !== undefined && target !== ''
    const withLevel = level !== undefined && level !== ''
    const named = withLevel ? ` 等级 ${String(level).trim()}` : ''
    const text =
      action === 'switch'
        ? `/switch ${target ?? ''}`
        : action === 'new' && withTarget
          ? `/new ${target}`
          : action === 'list' && target === 'all'
            ? '/list all'
            : action === 'model' && withTarget
              ? `/model ${String(target).trim()}${named}`
              : action === 'model' && withLevel
                ? `/model 等级 ${String(level).trim()}`
                : `/${action}`
    const result = await this.#router.route({
      conversationId,
      accountId: binding.accountId,
      peerId: binding.peerId,
      text,
      // 说话要来的清单与打字要来的清单用**不同的话**说"其余的在哪"：
      // 说话的人从没打过 `/list all`，叫他去打一句指令不是个说明。
      ...(action === 'list' ? { heldHint: '说「看全部对话」就能一起看，也可以直接切过去。' } : {}),
    })
    if (result.kind !== 'reply') {
      return { ok: false, detail: `不支持的操作：${action}`, ...empty }
    }

    const includeAll = target === 'all'
    /*
     * agent 拿到的是**用户刚收到的那一屏**（`result.numbered`），不是另算一份清单。
     *
     * 这正是微信把"编号"从 host 交回给工具的原因：一个自己重新编号的表会让 agent
     * 复述出与用户屏幕上不同的数字，而那个数字是用户要回给我们的东西。
     * 模型操作**完全不带会话表**：那张表是给"切对话"用的，
     * 把它附在模型结果后面，agent 会拿到一份与刚才那件事无关的清单。
     */
    const sessionsAndHeld =
      action === 'list'
        ? await this.#listReport(conversationId, result.numbered, includeAll)
        : { sessions: [], otherWorkspaces: 0, otherNames: [] }
    const { sessions, otherWorkspaces, otherNames } = sessionsAndHeld

    // 切到未知目标是"用引导回答"而不是抛错，所以必须**读文本**而不是假定成功——
    // 否则 agent 会报告一个从未发生的移动。
    // `没有成功` 是模型（与等级）切换失败时的措辞（见 router 的 `/model`），
    // `有多个` 是"id 太短，请用更长的那个"——那句同样**没有**切换成功，
    // 漏掉它就会对用户报一句"已切换"（微信插件在这里漏过一次）。
    const failed = /找不到|未知指令|没有成功|不支持|有多个/.test(result.text)

    if (action === 'switch' || action === 'new') {
      if (failed) {
        await this.#notify(conversationId, switchFailure(action, target, result.text))
      } else {
        const after = (await this.#store.read()).bindings[conversationId]
        await this.#notify(conversationId, switchConfirmation(action, after?.title ?? ''))
      }
      // 一次切换结束这次浏览：用户读过的那份清单已经用完了，
      // 之后一句「查看其余」不该接着它往下翻。
      await this.#router.delivered(conversationId, result)
    }

    if (action === 'model') {
      /*
       * 模型这件事**由频道自己说**，与切换对话同一条理由：
       * 清单如果交给 agent 转述，用户拿到的就是一份自创格式、编号对不上的清单
       * （`session-tool.js` 文件头记着这个失败）。成功与失败都发，失败尤其要发——
       * 那是唯一一种"聊天里什么都没变、用户无从分辨"的结果。
       */
      await this.#notify(conversationId, result.text)
      await this.#router.delivered(conversationId, result)
    }

    if (failed) {
      return {
        ok: false,
        // 写成"已完成"，因为它确实完成了：用户已被直接告知，复述只会与他们刚读到的相矛盾。
        detail: `操作失败，已直接告诉用户。原因：${result.text.split('\n')[0] ?? ''}`,
        sessions,
        otherWorkspaces,
        otherNames,
      }
    }

    if (action === 'model') {
      return {
        ok: true,
        // 与 `list` 同一个理由：结果已经发给用户了，再给 agent 一份只会被复述一遍。
        // 三种结果分开说，因为说得更准的 agent 更不会多嘴。
        detail: withLevel
          ? withTarget
            ? '模型与推理等级已切换，已直接告诉用户。不要重复。'
            : '推理等级已切换，已直接告诉用户。不要重复。'
          : withTarget
            ? '模型切换结果已直接发给用户。不要重复说明切换结果。'
            : '模型清单已直接发给用户。不要重复这份清单。',
        sessions,
        otherWorkspaces,
        otherNames,
      }
    }

    if (failed) {
      return {
        ok: false,
        // 写成"已完成"，因为它确实完成了：用户已被直接告知，复述只会与他们刚读到的相矛盾。
        detail: `切换失败，已直接告诉用户。原因：${result.text.split('\n')[0] ?? ''}`,
        sessions,
        otherWorkspaces,
        otherNames,
      }
    }

    if (action === 'list' || action === 'current') {
      /*
       * 清单**由频道自己发**，而且发的就是路由刚才渲染的那份字节。
       *
       * 这里曾经拿会话表另渲染一份给用户，那正是微信记下的那个失败：
       * 消息与编号各说各的（"看第 3 个"指到第 3 个以外的东西）。
       * 现在两者只有一份来源：`result.text` 发给用户，`result.numbered` 给 agent 复述编号。
       */
      const sent = await this.#notify(conversationId, result.text)
      if (sent) await this.#router.delivered(conversationId, result)
      /*
       * 告诉 agent 发生了什么，而**不是**把列表给它：复述会让每个请求翻倍，
       * 而转述正是产生"用户无法据此操作的列表"的原因。`/current` 不同——
       * 它那句话本身就是有用的正文，所以原样交给 agent。
       */
      return {
        ok: true,
        detail:
          action === 'list' ? '列表已直接发给用户。不要重复这份列表。' : result.text,
        sessions,
        otherWorkspaces,
        otherNames,
      }
    }

    return { ok: true, detail: result.text, sessions, otherWorkspaces, otherNames }
  }

  /**
   * 按本频道自己的名义发一条消息给某对话。
   *
   * 用在"无论 agent 选择说什么，用户都必须被告知"的场合。
   * 失败只记录不抛出：**漏掉一条确认不该让它正在确认的那个动作失败**。
   *
   * @returns **是否真的发出去了**；调用方据此决定要不要推进浏览位置
   *   （一个没送到的消息不该让下一次「查看其余」跳过一整屏）。
   */
  async #notify(conversationId, text) {
    try {
      return await this.#send(conversationId, text)
    } catch (error) {
      this.#recordError(`频道通知发送失败: ${describeError(error)}`)
      return false
    }
  }

  /**
   * 把路由刚印出的那一屏编号，翻译成 agent 要的那张表（以及"其余的在哪个会话夹"）。
   *
   * **编号取自路由，不是重新数一遍**：用户看到的是 11–20 那第二屏，
   * 而 agent 复述的"第 14 个"必须就是那一行。这也顺手修掉了原来那条分叉：
   * 工具与用户各拿一份自己编好的表，于是"看第 3 个"可能指到第 3 个以外的东西。
   *
   * 标题与时间取**活**的那一份（编号里只有 id 与标题），因为它们是给人认的；
   * 编号与顺序则完全按那一屏。整台机器的清单只读一次，两个用途共用它——
   * 这条路上的每一次读取都是一遍会话目录树。
   *
   * @param conversationId - 用作"当前"标记的对话。
   * @param numbered - 路由印出的那一屏编号；没有（会话夹那一层）时表是空的。
   * @param includeAll - 这次要的就是全部（会话夹那一层）：那就没有"别处的会话"可报。
   * @returns `{ sessions, otherWorkspaces, otherNames }`。
   */
  async #listReport(conversationId, numbered, includeAll) {
    const all = await this.#gateway().listSessions()
    const own = await this.#gateway().listOwnSessions()
    const currentId = (await this.#store.read()).bindings[conversationId]?.sessionId
    const byId = new Map(all.map((session) => [session.sessionId, session]))

    const sessions = (numbered?.sessions ?? []).map((row, offset) => {
      const live = byId.get(row.sessionId)
      return {
        // 印在行旁边的那个数字，不是它在这个数组里的位置：第二屏从 11 起。
        index: numbered.first + offset,
        sessionId: row.sessionId,
        title: (live?.title ?? row.title ?? '').trim() || '(无标题)',
        updatedAt: live?.updatedAt,
        current: row.sessionId === currentId,
      }
    })

    // 其余的口径与路由渲染那一句"另有 N 个对话在其它会话夹"完全相同（都按工作区分），
    // 这样 agent 口中的数目与用户读到的那个不会互相矛盾。
    const ownIds = new Set(own.map((session) => session.sessionId))
    const held = includeAll ? [] : all.filter((session) => !ownIds.has(session.sessionId))
    const names = new Set()
    for (const session of held) {
      // 用末段路径，因为那是用户从桌面端认得出的东西。点名而不是只报数量，
      // 于是"还有哪些列表"不需要再问一次。
      if (typeof session.workspace === 'string' && session.workspace !== '') {
        names.add(workspaceLabel(session.workspace))
      }
    }
    return { sessions, otherWorkspaces: held.length, otherNames: [...names].sort() }
  }

  // ------------------------------------------------- 出站文件与主动推送（工具）

  /**
   * `send_to_qq` 的实现：发给**调用者所属会话所绑定的**那个对话。
   *
   * 只对绑定的对话生效，所以真正干活的会话通常报不了自己的结果——那正是 `notify_qq` 存在的理由。
   *
   * @param args.path - 本机绝对路径。
   * @param args.caption - 可选的先行文本。
   * @param exec - 工具执行上下文（取 `exec.agent` 定位调用者）。
   * @returns 一句人话结果。
   */
  async sendFromTool(args, exec) {
    const path = String(args?.path ?? '').trim()
    if (path === '') throw new Error('path 不能为空。')
    const conversationId = await this.#conversationForSession(sessionIdOf(exec?.agent))
    if (conversationId === undefined) {
      throw new Error('这个会话没有绑定任何 QQ 对话，无法发送。请让用户在 QQ 里先发一条消息。')
    }
    return await this.#deliverTo(conversationId, {
      text: typeof args?.caption === 'string' ? args.caption : undefined,
      path,
    })
  }

  /**
   * `notify_qq` 的实现：发给**当前绑定的**那个对话，而不是调用者的。
   *
   * 目标从存储里解析，所以任何会话都能送到用户此刻手上的手机。
   * **不接受目标参数**，于是 agent 没有东西可以瞄错。
   *
   * @param args.text - 要发送的文本。
   * @param args.path - 可选的文件路径（在文本之后发送）。
   * @param exec - 工具执行上下文（本方法刻意不使用它来定位目标）。
   * @returns 一句人话结果。
   */
  async notifyFromTool(args, exec) {
    const text = typeof args?.text === 'string' ? args.text : ''
    const path = typeof args?.path === 'string' ? args.path.trim() : ''
    if (text.trim() === '' && path === '') {
      throw new Error('至少要给 text 或 path 其中一个。')
    }

    /*
     * 关掉「允许任意会话主动推送」时，本工具的行为**与 `send_to_qq` 完全一致**：
     * 调用者必须就是绑定到那个对话的会话。
     *
     * 微信的注释说明了为什么保留这条更严的规则而不是删掉它：
     * **关闭这个设置恢复的是原先的安全姿态，而不只是关掉一个便利功能。**
     *
     * 所以这里是 fail-closed：查不到调用者自己的对话就**拒绝**，
     * 而不是退回"推给当前绑定的那个"——那正是这个开关要禁止的事。
     */
    if (!this.#settings.allowCrossSessionNotify) {
      const own = await this.#conversationForSession(sessionIdOf(exec?.agent))
      if (own === undefined) {
        throw new Error(
          '这个会话没有绑定 QQ 对话，而「允许任意会话主动推送」是关闭的。请在设置里打开它，或先在 QQ 里发一条消息。',
        )
      }
      return await this.#deliverOrQueue(own, { text, path })
    }

    const conversationId = await this.#boundConversation()
    if (conversationId === undefined) {
      throw new Error('当前没有绑定任何 QQ 对话，无法推送。请让用户在 QQ 里先发一条消息。')
    }
    // 发不出去就排队——用户等的那条通知不该凭空消失。
    return await this.#deliverOrQueue(conversationId, { text, path })
  }

  /**
   * 当前绑定的对话。
   *
   * 多个绑定时**拒绝而不是猜**：推给错的对话比推不出去更糟。
   *
   * @returns 对话键，没有绑定时 `undefined`。
   */
  async #boundConversation() {
    const state = await this.#store.read()
    const keys = Object.keys(state.bindings)
    if (keys.length === 0) return undefined
    if (keys.length === 1) return keys[0]
    // 多于一个：按 lastUsedAt 取最近使用的那个，并记一笔，免得这是静默的猜。
    const sorted = keys.sort(
      (a, b) => (state.bindings[b]?.lastUsedAt ?? 0) - (state.bindings[a]?.lastUsedAt ?? 0),
    )
    bootLog(`notify_qq: 有 ${String(keys.length)} 个绑定，用最近使用的 ${sorted[0]}`)
    return sorted[0]
  }

  /**
   * 先发文本再发文件。**任一段失败就抛出**——调用方据此决定是入队还是报错。
   *
   * 顺序是有意的：文件到达时它的说明已经在那里了。
   */
  async #deliverTo(conversationId, { text, path }) {
    const done = []
    if (typeof text === 'string' && text.trim() !== '') {
      if (!(await this.#send(conversationId, text))) throw new Error('文本发送失败')
      done.push('文本已发送')
    }
    if (typeof path === 'string' && path !== '') {
      done.push(await this.#sendFile(conversationId, path))
    }
    if (done.length === 0) throw new Error('至少要给 text 或 path 其中一个。')
    return done.join('；')
  }

  /**
   * 发不出去就**排队**，而不是丢掉。
   *
   * 与微信的 `#sendOrQueue` 同构：那边的平台硬规则是"不能主动发"，QQ 这边则是
   * **任何原因都可能发不出去**（网络、平台拒绝，或者平台规则改了——官方文档对主动推送
   * 的说法互相矛盾，这里不假设额度）。两条路的后果一样——用户等的通知凭空消失，
   * 而且他永远不会知道。
   *
   * ⚠️ **只把被拒的那一段入队**（微信的注释）：
   * *"每一段各自尝试，一次拒绝只排队被拒的那一段，于是窗口关闭前到达的消息，
   * 不会因为它后面的文件被押后而在补发时被发送两次。"*
   *
   * 整条入队是我第一版的写法，它会导致：文本发出去了、文件被拒，
   * 补发时**把文本重复发一遍**。
   *
   * @param conversationId - 对话键。
   * @param args.text - 文本。
   * @param args.path - 可选文件。
   * @returns 一句人话结果。
   */
  async #deliverOrQueue(conversationId, { text, path }) {
    const done = []
    const queued = []

    if (typeof text === 'string' && text.trim() !== '') {
      if (await this.#send(conversationId, text)) done.push('文本已发送')
      else {
        await this.#queuePending(conversationId, { text })
        queued.push('文本已排队')
      }
    }

    if (typeof path === 'string' && path !== '') {
      try {
        done.push(await this.#sendFile(conversationId, path))
      } catch (error) {
        await this.#queuePending(conversationId, { path })
        queued.push(`文件已排队（${describeError(error)}）`)
      }
    }

    if (done.length === 0 && queued.length === 0) {
      throw new Error('至少要给 text 或 path 其中一个。')
    }
    const parts = [...done, ...queued]
    if (queued.length > 0) parts.push('等你下次说话时补发')
    return parts.join('；')
  }

  /** 入队一条待发消息。入队失败**必须抛出**：那意味着这条消息彻底没救了。 */
  async #queuePending(conversationId, { text, path }) {
    let dropped = 0
    await this.#store.update((state) => {
      dropped = queuePendingNotification(state, {
        conversationId,
        text: typeof text === 'string' ? text : '',
        path: typeof path === 'string' ? path : undefined,
      })
    })
    if (dropped > 0) bootLog(`待发队列已满，丢弃 ${String(dropped)} 条最旧的`)
    bootLog(`待发已入队：conversation=${conversationId}`)
  }

  /** 从待发队列移除一条。 */
  async #dropPending(id) {
    await this.#store.update((state) => {
      dropPending(state, id)
    })
  }

  /**
   * 窗口重新打开了：把积压的消息补发出去。
   *
   * **必须在处理这条入站消息之前调用**（微信的注释）：用户自己的那条消息才是
   * "重新打开窗口"的东西，所以积压的通知属于这条回答**之前**——
   * 否则用户等着的通知会出现在一条毫不相干的回复下面。
   *
   * @param conversationId - 刚开窗的对话。
   */
  async #flushPending(conversationId) {
    try {
      // 先过期、再读。反过来的话，刚被判定为过期的东西会被读进这次循环里照样发出去。
      let expired = 0
      await this.#store.update((state) => {
        expired = expirePendingNotifications(state).length
      })
      if (expired > 0) bootLog(`待发：丢弃 ${String(expired)} 条过期消息`)

      const state = await this.#store.read()
      const mine = pendingFor(state, conversationId)
      if (mine.length === 0) return

      // 只在本对话仍是当前绑定时补发：**发错人比发不出去更糟**。
      const bound = await this.#boundConversation()
      if (bound !== conversationId) {
        bootLog(`待发：当前绑定是 ${bound ?? '(无)'}，与 ${conversationId} 不同，跳过补发`)
        return
      }

      let sent = 0
      for (const entry of mine) {
        try {
          if (entry.text.trim() !== '') await this.#send(conversationId, entry.text)
          if (entry.path !== undefined) {
            if (!existsSync(entry.path)) {
              /*
               * 丢弃而**不是**重试：上面的文字已经发出去了，留着这条只会在之后
               * 每条消息上把那段文字重复一遍，并且把后面所有条目堵死（微信的原话）。
               */
              await this.#dropPending(entry.id)
              bootLog(`待发：文件已不存在，丢弃 ${basename(entry.path)}`)
              continue
            }
            await this.#sendFile(conversationId, entry.path)
          }
          await this.#dropPending(entry.id)
          sent += 1
        } catch (error) {
          // 又被拒：留在队列里等下次。**跳出以保持顺序**——越过它发后面的会让对话错位。
          bootLog(`待发补发被拒，保留待下次: ${describeError(error)}`)
          break
        }
      }
      if (sent > 0) bootLog(`待发：补发 ${String(sent)} 条`)
    } catch (error) {
      this.#recordError(`补发待发消息失败: ${describeError(error)}`)
    }
  }

  /**
   * 把一个本机文件发到某对话。
   *
   * 按扩展名选通道：图片走图片消息（手机上显示为照片），视频走视频消息（可直接播放），
   * 其余走文件消息。**路径必须是绝对路径**——相对路径会被 agent 的 cwd 解释成
   * 跟用户以为的完全不同的文件。
   *
   * @param conversationId - 对话键。
   * @param path - 绝对路径。
   * @returns 一句人话结果。
   */
  async #sendFile(conversationId, path) {
    const bot = this.#bot
    if (bot === undefined) throw new Error('未连接 QQ，无法发送文件。')
    if (!isAbsolute(path)) throw new Error(`路径必须是绝对路径：${path}`)
    let info
    try {
      info = statSync(path)
    } catch {
      throw new Error(`找不到这个文件：${path}`)
    }
    if (!info.isFile()) throw new Error(`不是一个文件：${path}`)

    const resolved = this.#targetFor(conversationId)
    if (resolved === undefined) throw new Error('找不到对话的 peerId，无法发送。')
    const { target } = resolved
    const kind = mediaKindFor(path)
    const name = basename(path)

    if (kind === 'image') await bot.sendImage(target, { localPath: path })
    else if (kind === 'video') await bot.sendVideo(target, { localPath: path })
    else await bot.sendFile(target, { localPath: path }, { fileName: name })

    return kind === 'image' ? `已发送图片 ${name}` : kind === 'video' ? `已发送视频 ${name}` : `已发送文件 ${name}`
  }

  // ---------------------------------------------------------------- 诊断

  /**
   * 安全地发起一件脱离 await 链的异步工作。
   *
   * ## 为什么这个方法是必需的，而不是"防御性编程"
   *
   * `@deepseek-ai/dsh-app-boot` 的「启动与重载失败」表里有两条**与 optional/required 无关**的
   * 致命规则：
   *
   * - 脱离 `apply()` 的异步任务产生**未处理 rejection** → 致命错误：释放应用并以非零码退出
   * - 定时器 / 流回调在进程生命周期任一时刻**同步抛出未捕获异常** → 同上
   *
   * 也就是说：本插件里任何 `void someAsync()`、任何 `setTimeout`/`setInterval` 回调，
   * 只要漏一个 catch，就足以让用户的整个桌面端起不来。**所有这类调用都必须经此发起。**
   *
   * @param label - 出错时记录用的标签。
   * @param factory - 实际工作；返回 Promise 时会被接上 catch。
   */
  #fire(label, factory) {
    try {
      const result = factory()
      if (result !== undefined && result !== null && typeof result.then === 'function') {
        result.then(undefined, (error) => {
          this.#recordError(`${label}: ${describeError(error)}`)
        })
      }
    } catch (error) {
      // 同步抛出同样致命，必须先接住。
      this.#recordError(`${label} 同步抛出: ${describeError(error)}`)
    }
  }

  #recordError(message) {
    this.#errors.push(`${new Date().toISOString()} ${message}`)
    if (this.#errors.length > MAX_ERRORS) this.#errors.shift()
    bootLog(`ERROR ${message}`)
  }

  /**
   * 供设置页/诊断路由使用的状态快照。**不含任何密钥。**
   */
  async status() {
    const state = await this.#store.read()
    const account = state.accounts[this.#appId]
    return {
      connected: this.connected,
      appId: this.#appId === '' ? undefined : this.#appId,
      boundUserOpenid: account?.userOpenid,
      boundAt: account?.boundAt,
      workspace: this.#workspace,
      conversationCount: Object.keys(state.bindings).length,
      replyLimiter: this.#limiter.getConfig(),
      permissionPreset: this.#settings.permissionPreset,
      pendingInteractions: this.#interactions.size,
      errors: this.#errors.slice(-20),
    }
  }
}
