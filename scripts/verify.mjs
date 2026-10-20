/**
 * 离线自检：不依赖 DSH 宿主，只验证模块解析与纯函数行为。
 *
 * 这类错误在 DSH 里只表现为"插件加载失败"，排查代价高，所以在装进 profile 之前先在这里挡住。
 *
 * 用法：node scripts/verify.mjs
 */
let failures = 0

function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  期望 ${String(expected)}，实际 ${String(actual)}`}`)
}

function show(label, value) {
  console.log(`      ${label}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
}

// ---- 官方 SDK 的两个入口都要能解析 ----------------------------------------
const main = await import('@tencent-connect/qqbot-nodejs')
const proto = await import('@tencent-connect/qqbot-nodejs/protocol')

check('QQBot 导出', typeof main.QQBot, 'function')
check('ReplyLimiter 从 protocol 子入口导出', typeof proto.ReplyLimiter, 'function')
check('chunkText 导出', typeof proto.chunkText, 'function')
show('TEXT_CHUNK_LIMIT', proto.TEXT_CHUNK_LIMIT)
check('MsgType.TEXT', main.MsgType.TEXT, 0)
check('MsgType.MARKDOWN', main.MsgType.MARKDOWN, 2)

// ---- 限流器行为：4 次 / 1 小时 ---------------------------------------------
const limiter = new proto.ReplyLimiter()
show('limiter 默认配置', limiter.getConfig())
const first = limiter.checkLimit('m1')
check('首次允许被动回复', first.allowed, true)
for (let i = 0; i < 4; i += 1) limiter.record('m1')
const after = limiter.checkLimit('m1')
check('用完 4 次后不再允许', after.allowed, false)
check('并建议降级为主动', after.shouldFallbackToProactive, true)
show('降级原因', after.fallbackReason)
check('新消息不受影响', limiter.checkLimit('m2').allowed, true)

// ---- 文本切分 --------------------------------------------------------------
const long = 'a'.repeat(proto.TEXT_CHUNK_LIMIT * 2 + 10)
const chunks = proto.chunkText(long, proto.TEXT_CHUNK_LIMIT)
check('超长文本被切成 3 段', chunks.length, 3)
check('切分不丢字符', chunks.join('').length, long.length)

// ---- 本插件自己的模块 ------------------------------------------------------
const runtime = await import('../lib/runtime.js')
check('QqRuntime 导出', typeof runtime.QqRuntime, 'function')
const sessionId = runtime.mintSessionId()
check('sessionId 形如 session-<8hex>-<uuid>', /^session-[0-9a-f]{8}-[0-9a-f-]{36}$/.test(sessionId), true)
show('mintSessionId()', sessionId)
check('shortId 与 /list 打印的一致', runtime.shortId(sessionId), sessionId.split('-')[1].slice(0, 6))

const state = await import('../lib/state.js')
check('conversationKey 只有两维', state.conversationKey('1905760478', 'E56C740F'), '1905760478:E56C740F')
const normalized = state.normalizeState({
  accounts: { '1': { userOpenid: 'u1', enabled: true } },
  bindings: { 'k': { sessionId: 's', peerId: 'p', accountId: '1' } },
})
check('normalizeState 保留账号', normalized.accounts['1'].userOpenid, 'u1')
check('normalizeState 保留绑定', normalized.bindings['k'].sessionId, 's')
check('normalizeState 拒绝缺 sessionId 的绑定', Object.keys(state.normalizeState({ bindings: { k: { peerId: 'p' } } }).bindings).length, 0)

const creds = await import('../lib/credentials.js')
check('appId 是纯数字时 key 仍合法', creds.accountRecordKey('1905760478'), 'dsh-qq-plugin/app-1905760478')
check('key 段符合 ^[a-z][a-z0-9-]*$', /^[a-z][a-z0-9-]*$/.test(creds.sanitizeKeySegment('app-1905760478')), true)
// ★ 这几条是为一次**造成用户应用无法启动**的事故而加的：凭据记录的 `kind` 是封闭枚举，
//   写错会让 @deepseek-ai/dsh-credentials-local 在启动时解析失败，进而拖垮整个桌面端。
check('★ 凭据记录 kind 是官方承认的 grant', creds.CREDENTIAL_KIND, 'grant')
check('★ kind 落在官方枚举内', creds.ALLOWED_RECORD_KINDS.includes(creds.CREDENTIAL_KIND), true)
check('官方枚举就是 api-key 与 grant', JSON.stringify([...creds.ALLOWED_RECORD_KINDS]), JSON.stringify(['api-key', 'grant']))

const frame = await import('../lib/stream-frame.js')
const wrap = (frameObj) => frame.readStreamFrame({ agent: { session: { id: 's1' } }, frame: frameObj })
check('end 帧 = 回合结束', wrap({ type: 'end' }).completed, true)
check('text-delta 取到文本', wrap({ chunk: { type: 'text-delta', text: 'hi' } }).text, 'hi')
check('sessionId 正确', wrap({ chunk: { type: 'text-delta', text: 'hi' } }).sessionId, 's1')
check('finish 不算回合结束', wrap({ chunk: { type: 'finish' } }).completed, undefined)
check('reasoning-delta 不进正文', wrap({ chunk: { type: 'reasoning-delta', text: '想' } }).text, undefined)
check('未知帧被记录形态', typeof wrap({ weird: 1 }).frameShape, 'string')

// ---- 会话路由（纯函数；手机键盘容错最易悄悄写错）---------------------------
{
  const r = await import('../lib/router.js')

  // splitCommand：空格可选、冒号可代、`/news` 不能被吃成 `/new` + `s`
  check('"/switch 3"', JSON.stringify(r.splitCommand('/switch 3')), JSON.stringify({ command: '/switch', args: '3' }))
  check('"/switch3" 粘连也认', JSON.stringify(r.splitCommand('/switch3')), JSON.stringify({ command: '/switch', args: '3' }))
  check('"/switch:3" 冒号也认', JSON.stringify(r.splitCommand('/switch:3')), JSON.stringify({ command: '/switch', args: '3' }))
  check('★ "/news" 不是 /new', JSON.stringify(r.splitCommand('/news')), JSON.stringify({ command: '/news', args: '' }))
  check('★ "/new我的任务" 合法粘连参数', JSON.stringify(r.splitCommand('/new我的任务')), JSON.stringify({ command: '/new', args: '我的任务' }))
  check('"/new 修复登录"', JSON.stringify(r.splitCommand('/new 修复登录')), JSON.stringify({ command: '/new', args: '修复登录' }))
  check('"/list all"', JSON.stringify(r.splitCommand('/list all')), JSON.stringify({ command: '/list', args: 'all' }))
  check('"/help" 无参数', JSON.stringify(r.splitCommand('/help')), JSON.stringify({ command: '/help', args: '' }))
  check('大小写不敏感', JSON.stringify(r.splitCommand('/LIST')), JSON.stringify({ command: '/list', args: '' }))

  // resolveTarget
  // id 用真实的 uuid 形态：尾巴是随机十六进制，所以"1"这种数字不会碰巧被 endsWith 撞上。
  const sessions = [
    { sessionId: 'session-aaaaaaaa-47fd-4e61-bec6-d21d19457f37', title: '修复登录', updatedAt: 3 },
    { sessionId: 'session-bbbbbbbb-47fd-4e61-bec6-d21d19457f37', title: '北京行程', updatedAt: 2 },
    { sessionId: 'session-cccccccc-47fd-4e61-bec6-d21d19457f37', title: '', updatedAt: 1 },
  ]
  /** 解析结果里的会话 id；没命中时印出那个 kind（失败信息里看得出来是歧义还是没找到）。 */
  const picked = (resolution) => (resolution.kind === 'found' ? resolution.session.sessionId : resolution.kind)
  /** 一份"用户看到过的清单"：行 + 印在第一行旁边的数字。 */
  const numbering = (rows, first = 1) => ({ sessions: rows, first })

  check('序号 2', picked(r.resolveTarget('2', sessions, numbering(sessions))), 'session-bbbbbbbb-47fd-4e61-bec6-d21d19457f37')
  check('★ 编号带偏移：第二屏的第一行是 11', picked(r.resolveTarget('11', sessions, numbering(sessions, 11))), 'session-aaaaaaaa-47fd-4e61-bec6-d21d19457f37')
  check('★ 编号带偏移：那一屏之前的数字不折回第 1 行', picked(r.resolveTarget('1', sessions, numbering(sessions, 11))), 'none')
  check('完整 id', picked(r.resolveTarget('session-cccccccc-47fd-4e61-bec6-d21d19457f37', sessions, numbering(sessions))), 'session-cccccccc-47fd-4e61-bec6-d21d19457f37')
  check('★ 短 id 是 6 位', r.shortId('session-aaaaaaaa-47fd-4e61-bec6-d21d19457f37'), 'aaaaaa')
  check('短 id 能切', picked(r.resolveTarget('aaaaaa', sessions, numbering(sessions))), 'session-aaaaaaaa-47fd-4e61-bec6-d21d19457f37')
  check('★ 更长的前缀也能切（"用更长的 id"这句建议必须真的可用）', picked(r.resolveTarget('aaaaaaaa', sessions, numbering(sessions))), 'session-aaaaaaaa-47fd-4e61-bec6-d21d19457f37')
  check('印出来的短 id 与切过去用的是同一个', r.resolveTarget(r.shortId(sessions[1].sessionId), sessions, numbering(sessions)).session?.title, '北京行程')
  check('精确标题', picked(r.resolveTarget('修复登录', sessions, numbering(sessions))), 'session-aaaaaaaa-47fd-4e61-bec6-d21d19457f37')
  check('★ 双向包含：敲片段', picked(r.resolveTarget('北京', sessions, numbering(sessions))), 'session-bbbbbbbb-47fd-4e61-bec6-d21d19457f37')
  check('★ 双向包含：自己加词', picked(r.resolveTarget('北京行程安排', sessions, numbering(sessions))), 'session-bbbbbbbb-47fd-4e61-bec6-d21d19457f37')
  check('找不到时 none', picked(r.resolveTarget('不存在的对话', sessions)), 'none')
  check('空参数 none', picked(r.resolveTarget('   ', sessions)), 'none')
  check('序号越界不误配', picked(r.resolveTarget('99', sessions)), 'none')

  const all = [...sessions, { sessionId: 'session-dddddddd-47fd-4e61-bec6-d21d19457f37', title: '别的项目', updatedAt: 0 }]
  check('★ 序号按用户看到的列表编号', picked(r.resolveTarget('1', all, numbering(sessions))), 'session-aaaaaaaa-47fd-4e61-bec6-d21d19457f37')
  check('★ 标题可在全机器范围搜到', picked(r.resolveTarget('别的项目', all, numbering(sessions))), 'session-dddddddd-47fd-4e61-bec6-d21d19457f37')

  // 短 id 撞车：id 太短必须**问回去**，而不是猜一个
  const clash = [
    { sessionId: 'session-e716f0aa-e716f0aa-47fd', title: '写周报', updatedAt: 2 },
    { sessionId: 'session-e716f0bb-e716f0bb-47fd', title: '查天气', updatedAt: 1 },
  ]
  const ambiguous = r.resolveTarget('e716f0', clash, numbering(clash))
  check('★ 两个会话共用一个短 id → 有歧义（不猜）', ambiguous.kind, 'ambiguous')
  const clashMessage = r.ambiguousTargetMessage('e716f0', ambiguous.candidates)
  check('★ 撞车时说明"请用更长的 id"', clashMessage.includes('更长的 id'), true)
  check('★ 候选带上更长的前缀（那正是用户该回的东西）', clashMessage.includes('e716f0aa') && clashMessage.includes('e716f0bb'), true)
  check('★ 候选带上标题（人认得出的是对话）', clashMessage.includes('写周报') && clashMessage.includes('查天气'), true)
  check('多给一位就唯一了', picked(r.resolveTarget('e716f0a', clash, numbering(clash))), 'session-e716f0aa-e716f0aa-47fd')

  // 分页：每屏 10 条，编号跨屏连续
  const many = Array.from({ length: 25 }, (_, index) => ({
    sessionId: `session-${(index + 1).toString(16).padStart(6, '0')}-0000`,
    title: `对话${index + 1}`,
    updatedAt: 1_000 - index,
  }))
  check('★ 每屏 10 条', r.BROWSE_PAGE_SIZE, 10)
  check('25 条 = 3 屏', r.browsePage(many, 1).pages, 3)
  check('第 1 屏 10 条', r.browsePage(many, 1).items.length, 10)
  check('★ 第 2 屏从第 11 行开始', r.browsePage(many, 2).start, 10)
  check('★ 第 2 屏就是 11–20', r.browsePage(many, 2).items[0].title, '对话11')
  check('★ 越界的屏号被夹到最后一屏（而不是一条空消息）', JSON.stringify([r.browsePage(many, 99).page, r.browsePage(many, 99).items.length]), JSON.stringify([3, 5]))
  check('★ screenRows 的 first 就是印在第一行旁边的数字', r.screenRows(many, 2).first, 11)
  check('screenRows 只取那一屏', r.screenRows(many, 3).sessions.length, 5)
  check('★「查看其余」就是这句话', r.SHOW_REST, '查看其余')
  check('★ 句读不影响认这句话', JSON.stringify([r.isShowRest('查看其余'), r.isShowRest('查看其余。'), r.isShowRest('查看其余！')]), JSON.stringify([true, true, true]))
  check('★ 近似的说法不认（这句话没有目标，猜不得）', JSON.stringify([r.isShowRest('继续'), r.isShowRest('看其余')]), JSON.stringify([false, false]))

  // 一屏会话：标题、时间、行尾短 id，以及"还能不能翻"
  const NOW = 1_800_000_000_000
  const ownTwelve = many.slice(0, 12)
  const screen1 = r.renderSessionScreen(ownTwelve, { label: 'QQ 会话', page: 1, currentId: ownTwelve[0].sessionId, now: NOW })
  const rowLines = (text) => text.split('\n').filter((line) => /^\d+\. /.test(line))
  check('标题带会话夹与屏号', screen1.text.startsWith('【QQ 会话】会话（1/2）'), true)
  check('★ 第 1 屏十条', rowLines(screen1.text).length, 10)
  check('★ 行尾短 id 出现在每一行', rowLines(screen1.text).every((line) => /\s[0-9a-f]{6}$/.test(line)), true)
  check('★ 当前会话被标出', screen1.text.includes('← 当前'), true)
  check('★ 有下一页时邀请翻页', screen1.text.includes('回复「查看其余」看下十个'), true)
  check('★ 行尾 id 被点名，而不只是印出来', screen1.text.includes('行尾 6 位 id'), true)
  check('★ 引用能冻结编号——这句话必须说出来', screen1.text.includes('引用这条消息再回编号'), true)
  const screen2 = r.renderSessionScreen(ownTwelve, { label: 'QQ 会话', page: 2, now: NOW })
  check('★ 第 2 屏的编号接着 11 起', screen2.text.includes('11. 对话11'), true)
  check('★ 第 2 屏 first = 11', screen2.numbered.first, 11)
  check('第 2 屏只印剩下的两条', screen2.numbered.sessions.length, 2)
  check('★ 翻到底就不再邀请翻页', screen2.text.includes('查看其余'), false)
  check('★ 翻到底仍然报出出路', screen2.text.includes('回复编号或行尾 6 位 id 切换。'), true)
  check('空会话夹说明而不是空白', r.renderSessionScreen([], { label: 'QQ 会话', page: 1, now: NOW }).text.includes('（这个会话夹还没有对话）'), true)
  const longTitle = '这是一句很长的标题'.repeat(4)
  const longRow = r.renderSessionRow({ sessionId: 'session-aaaaaa-0000', title: longTitle, updatedAt: 0 }, 0, undefined, NOW)
  check('★ 超长标题裁到 24 字加省略号（时间与 id 才是这一行的用处）', longRow.includes(`${longTitle.slice(0, 24)}…`), true)
  check('★ 超长标题不是整段印出来', longRow.includes(longTitle), false)

  // 会话夹那一层
  const folders = r.sessionFolders(
    [
      { sessionId: 's1', title: 'a', updatedAt: 1, workspace: 'C:\\me\\dsh_qq' },
      { sessionId: 's2', title: 'b', updatedAt: 9, workspace: 'C:\\me\\项目甲' },
      { sessionId: 's3', title: 'c', updatedAt: 5, workspace: 'C:\\me\\项目甲' },
      { sessionId: 's4', title: 'd', updatedAt: 4, workspace: 'C:\\me\\项目乙' },
      { sessionId: 's5', title: 'e', updatedAt: 2 },
    ],
    { ownWorkspace: 'C:\\me\\dsh_qq', ownLabel: 'QQ 会话' },
  )
  check('★ 本工作区排第一', `${folders[0].label}:${folders[0].count}`, 'QQ 会话:2')
  check('★ 其余按最近活跃排，目录名做平手时的次序', folders.map((folder) => folder.label).join(','), 'QQ 会话,项目甲,项目乙')
  check('★ 每个会话夹带会话数', folders.map((folder) => folder.count).join(','), '2,2,1')
  check('★ 没有记录目录的行算本频道自己的（那是唯一能为之背书的工作区）', folders.length, 3)
  const folderScreen = r.renderFolderScreen(folders, 1)
  check('会话夹那一层的标题', folderScreen.startsWith('会话夹（1/1）'), true)
  check('会话夹行带名字与会话数', folderScreen.includes('1. QQ 会话  2 个会话'), true)
  check('会话夹行编号连续', folderScreen.includes('3. 项目乙  1 个会话'), true)
  check('★ 只有一屏时不邀请翻页', folderScreen.includes('查看其余'), false)
  const manyFolders = Array.from({ length: 12 }, (_, index) => ({ path: `C:\\p${String(index)}`, label: `夹${String(index)}`, count: index + 1 }))
  check('★ 会话夹也编号跨屏连续（11–12）', r.renderFolderScreen(manyFolders, 2).includes('11. 夹10  11 个会话'), true)
  check('★ 会话夹还没到底时邀请翻页', r.renderFolderScreen(manyFolders, 1).includes('回复「查看其余」看下十个'), true)

  // 进会话夹：编号、名字、片段都认；有歧义必须问回去
  check('会话夹按编号', r.resolveFolder('2', folders).folder?.label, '项目甲')
  check('会话夹按名字', r.resolveFolder('项目乙', folders).folder?.label, '项目乙')
  check('★ 会话夹按片段（人是这么称呼项目的）', r.resolveFolder('甲', folders).folder?.label, '项目甲')
  check('会话夹找不到 → none', r.resolveFolder('不存在的项目', folders).kind, 'none')
  const twinFolders = [
    { path: 'C:\\a\\workplace', label: 'workplace', count: 1 },
    { path: 'D:\\b\\workplace', label: 'workplace', count: 2 },
  ]
  const twin = r.resolveFolder('workplace', twinFolders)
  check('★ 两个同名会话夹 → 有歧义（进错项目比多问一句更糟）', twin.kind, 'ambiguous')
  check('★ 歧义文案给出编号', r.ambiguousFolderMessage('workplace', twin.candidates, twinFolders).includes('2. D:\\b\\workplace  2 个会话'), true)

  // 本工作区空、别处有：数出来并点名，而不是让它们消失
  const held = [{ sessionId: 's2', title: 'b', updatedAt: 1, workspace: 'C:\\me\\项目甲' }]
  check('★ 本工作区空时也给出路', r.heldOnlyList(held, 'QQ 会话').includes('发 /list all 看会话夹'), true)
  check('本工作区空时点名别的工作区', r.heldOnlyList(held, 'QQ 会话').includes('（项目甲）'), true)
  check('★ heldNames 去重、排序、取末段', JSON.stringify(r.heldNames([...held, ...held, { sessionId: 's9', title: 'z', workspace: 'C:\\b' }])), JSON.stringify(['b', '项目甲']))
  check('一行会话屏里的"其余的在哪"也点名工作区', r.renderSessionScreen(ownTwelve.slice(0, 2), { label: 'QQ 会话', page: 1, now: NOW, held: { count: 3, names: ['项目甲'] } }).text.includes('（项目甲）'), true)
  check('★ "其余"那句话在别人的会话夹里不出现（那是他自己选的夹子）', r.renderSessionScreen(ownTwelve.slice(0, 2), { label: '项目甲', page: 1, now: NOW }).text.includes('其它会话夹'), false)

  check('★ workspaceLabel 只取末段', r.workspaceLabel('C:\\Users\\me\\.dsh\\dsh_qq'), 'dsh_qq')
  check('relativeTime 刚刚', r.relativeTime(NOW, NOW), '刚刚')
  check('relativeTime 分钟', r.relativeTime(NOW - 5 * 60_000, NOW), '5 分钟前')
  check('relativeTime 昨天（24–48 小时）', r.relativeTime(NOW - 25 * 3_600_000, NOW), '昨天')
  check('★ 帮助里给出分页与「查看其余」', r.HELP_TEXT.includes('查看其余') && r.HELP_TEXT.includes('每屏最多 10 条'), true)
  check('★ 帮助里 /list all 说的是会话夹', r.HELP_TEXT.includes('列出全部会话夹'), true)
  check('★ 帮助里 /switch 说明了引用能冻结编号', r.HELP_TEXT.includes('引用列表消息再回编号'), true)
  check('★ 帮助里 /switch <id> 说明行尾那 6 位', r.HELP_TEXT.includes('/switch e716f0'), true)
  check('★ 帮助里说明了"列表在眼前时直接回编号"', r.HELP_TEXT.includes('不必打 /switch'), true)

}

// ---- `/list` `/list all` `/switch` 端到端：两层、分页、引用冻结 -------------
/*
 * 这一节用假宿主跑**整条链路**（路由 + `delivered` 落位），因为要证明的东西全都是
 * "跨若干条消息才有意义"的：编号跨屏连续、引用把旧编号钉住、进会话夹不改绑定、
 * 「查看其余」翻到底之后的措辞。
 *
 * ⚠️ 它证明的是**逻辑与断言符合微信的契约**，不是"手机上看起来一样"——
 * 那要有真机与运行中的 DSH 才谈得上。
 */
{
  const r = await import('../lib/router.js')

  const SELF = 'C:\\me\\dsh_qq'
  const CONV = { conversationId: '111:peer', accountId: '111', peerId: 'peer' }

  /** 一条会话索引行：id 中间那段是 6 位十六进制（与真实铸造出来的同形）。 */
  const row = (n, updatedAt) => ({
    sessionId: `session-${n.toString(16).padStart(6, '0')}-0000`,
    title: `对话${n}`,
    updatedAt,
  })

  /** 一份清单正文里的会话行。 */
  const rowLines = (text) => text.split('\n').filter((line) => /^\d+\. /.test(line))

  /**
   * 假宿主 + 假状态存储。
   *
   * 状态是**内存里的**，但形状与状态文件完全一致（`browsing` / `sessionLists`），
   * 所以"换一个路由实例从同一个 store 读回"这条路可以真的测到——
   * 那正是"重启之后引用仍然有效"的等价物。
   */
  const harness = ({ own = [], others = {} } = {}) => {
    const machine = () =>
      [...own, ...Object.entries(others).flatMap(([workspace, rows]) => rows.map((session) => ({ ...session, workspace })))]
    const byNewest = (a, b) => b.updatedAt - a.updatedAt
    const saved = { bindings: {}, browsing: {}, sessionLists: {} }
    const store = {
      load: async () => saved.bindings,
      save: async (bindings) => {
        saved.bindings = bindings
      },
      loadRouteState: async () => ({ browsing: saved.browsing, sessionLists: saved.sessionLists }),
      saveRouteState: async (state) => {
        saved.browsing = state.browsing
        saved.sessionLists = state.sessionLists
      },
    }
    const gateway = {
      // 创建与采纳是两条路（只有创建带标题）；这一节不测标题，所以两个都收下即可。
      createSession: async () => {},
      ensureSession: async () => {},
      prompt: async () => {},
      cancel: async () => {},
      listSessions: async () => machine().sort(byNewest),
      listOwnSessions: async () => [...own].sort(byNewest),
      listModels: async () => [],
      currentModel: async () => undefined,
      selectModel: async () => {
        throw new Error('这一节不测模型')
      },
    }
    const router = new r.SessionRouter({
      gateway,
      store,
      titlePrefix: 'QQ',
      ownWorkspace: SELF,
      ownWorkspaceLabel: 'QQ 会话',
    })
    return { router, store, own, others, saved, live: () => [...own].sort(byNewest) }
  }

  /** 路由一条消息，并按"真的发出去了"落位——与 `runtime.#deliverPrompt` 同序。 */
  const send = async (h, text, quoted) => {
    const routed = await h.router.route({ ...CONV, text, ...(quoted === undefined ? {} : { quoted }) })
    if (routed.kind === 'reply') await h.router.delivered(CONV.conversationId, routed)
    return routed
  }
  /** 本对话当前绑定的会话 id。 */
  const bound = async (h) => (await h.router.current(CONV.conversationId))?.sessionId

  // ---- 一、分页、短 id、以及"列表就在眼前时直接回编号" ----
  {
    const h = harness({ own: Array.from({ length: 25 }, (_, index) => row(index + 1, 2_000 - index)) })
    check('首条消息交给 agent（还没有清单可看）', (await send(h, '你好')).kind, 'prompt')

    const listed = await send(h, '/list')
    check('★ /list 直接进本工作区那一层', listed.text.startsWith('【QQ 会话】会话（1/3）'), true)
    check('★ 每屏 10 条', rowLines(listed.text).length, 10)
    check('★ 行尾短 id 就是印出来的那个', listed.text.includes(r.shortId(h.live()[0].sessionId)), true)
    check('★ 有下一页时邀请翻页', listed.text.includes('回复「查看其余」看下十个'), true)
    check('★ /list 之后位置落在第一屏', JSON.stringify(h.saved.browsing[CONV.conversationId]), JSON.stringify({ level: 'sessions', workspace: '', page: 1, at: h.saved.browsing[CONV.conversationId].at }))

    const page2 = await send(h, '查看其余')
    check('★ 翻十条：第 2 屏', page2.text.startsWith('【QQ 会话】会话（2/3）'), true)
    check('★ 编号跨屏连续：第 2 屏是 11–20', JSON.stringify([page2.numbered.first, page2.numbered.sessions.length, page2.text.includes('11. 对话11')]), JSON.stringify([11, 10, true]))
    check('还没到底，仍然邀请翻页', page2.text.includes('查看其余'), true)
    check('★ 位置推到第二屏', h.saved.browsing[CONV.conversationId].page, 2)

    const page3 = await send(h, '查看其余。')
    check('★ 句读不挡翻页', page3.text.startsWith('【QQ 会话】会话（3/3）'), true)
    check('★ 最后一屏不邀请翻页', page3.text.includes('查看其余'), false)
    check('★ 最后一屏仍然报出出路', page3.text.includes('回复编号或行尾 6 位 id 切换。'), true)
    check('第 3 屏只印剩下的 5 条', rowLines(page3.text).length, 5)

    const bottom = await send(h, '查看其余')
    check('★ 翻到底明说，且说的是"只有 3 页"', bottom.text.split('\n')[0], '【QQ 会话】只有 3 页，已经到底了。')
    check('★ 到底之后不再邀请翻页', bottom.text.includes('查看其余'), false)
    check('★ 到底之后仍然报出出路', bottom.text.includes('回复编号或行尾 6 位 id 切换'), true)
    check('★ 到底时位置留着（用户显然还在读）', h.saved.browsing[CONV.conversationId].page, 3)

    // 短 id 与编号无关：它在第 20 行，而当前屏是 21–25
    const byId = await send(h, `/switch ${r.shortId(h.live()[19].sessionId)}`)
    check('★ /switch <短 id> 与编号无关', await bound(h), h.live()[19].sessionId)
    check('★ 短 id 永远不会过期（不在当前屏也切得到）', byId.text.includes('已切换到「对话20」'), true)
    check('★ 一次切换结束这次浏览（位置清掉）', h.saved.browsing[CONV.conversationId], undefined)

    // 反向对照：清单不在眼前时，一个光秃秃的编号不是"一步"，它该去 agent
    check('★ 没有清单在眼前时，裸数字交给 agent（不是切换）', (await send(h, '3')).kind, 'prompt')

    // 清单就在眼前时不用打 /switch
    await send(h, '/list')
    const bare = await send(h, '3')
    check('★ 直接回 3 就等于 /switch 3', bare.kind, 'reply')
    check('★ 裸数字按那一屏读', await bound(h), h.live()[2].sessionId)
    check('切换之后浏览结束', h.saved.browsing[CONV.conversationId], undefined)
  }

  // ---- 二、引用冻结编号（以及"编号会过期"的反向对照）----
  {
    const h = harness({ own: Array.from({ length: 25 }, (_, index) => row(index + 1, 2_000 - index)) })
    await send(h, '你好')
    await send(h, '/list')
    const screen = await send(h, '查看其余')
    const frozenText = screen.text
    const frozen = screen.numbered

    // 用户读清单时会话还在跑：先塞 5 条"更新"的，活清单的第 3 行已经换人了
    for (let index = 0; index < 5; index += 1) h.own.push(row(100 + index, 5_000 + index))
    check('前置：活清单第 12 行已经不是那一屏的第 12 行', h.live()[11].sessionId !== frozen.sessions[1].sessionId, true)

    const quoted = await send(h, '12', frozenText)
    check('★ 引用那一屏 + 回编号 = 按那一屏解析', await bound(h), frozen.sessions[1].sessionId)
    check('★ 引用冻结的编号不会漂到"现在最新的"上', (await bound(h)) !== h.live()[11].sessionId, true)
    check('引用之后浏览结束', h.saved.browsing[CONV.conversationId], undefined)

    /*
     * 反向对照：**不引用**时读的是"本对话最近收到的那一屏"，仍然不是活清单。
     * 少掉"钉住"这一步，"12"就会落到活清单的第 12 行——也就是另一条会话。
     */
    const h2 = harness({ own: Array.from({ length: 25 }, (_, index) => row(index + 1, 2_000 - index)) })
    await send(h2, '你好')
    await send(h2, '/list')
    const screen2 = await send(h2, '查看其余')
    for (let index = 0; index < 5; index += 1) h2.own.push(row(100 + index, 5_000 + index))
    await send(h2, '12')
    check('★ 不引用时读最近那一屏（不是活清单）', await bound(h2), screen2.numbered.sessions[1].sessionId)
    check('★ 活清单的第 12 行确实换人了（否则上面那条没有鉴别力）', h2.live()[11].sessionId !== screen2.numbered.sessions[1].sessionId, true)

    // 引用到一条**不是清单**的消息：落到"最近一屏"，与没有引用时同一条路
    const h3 = harness({ own: Array.from({ length: 25 }, (_, index) => row(index + 1, 2_000 - index)) })
    await send(h3, '你好')
    await send(h3, '/list')
    const screen3 = await send(h3, '查看其余')
    await send(h3, '12', '早上好啊这是一句普通消息')
    check('★ 引用非清单时回落"最近一屏"', await bound(h3), screen3.numbered.sessions[1].sessionId)

    /*
     * 跨屏：引用的是一份**印过 11–20 的**旧消息，而屏幕上现在是第一屏（1–10）。
     * 若按当前屏读，"13"落在 1–10 之外 → 不是一步 → 会交给 agent。
     */
    const h4 = harness({ own: Array.from({ length: 25 }, (_, index) => row(index + 1, 2_000 - index)) })
    await send(h4, '你好')
    await send(h4, '/list')
    const oldScreen = await send(h4, '查看其余')
    await send(h4, '/list')
    const oldQuote = await send(h4, '13', oldScreen.text)
    check('★ 引用一屏旧清单：13 仍按那一屏（11–20）解析', oldQuote.kind === 'reply' && (await bound(h4)) === oldScreen.numbered.sessions[2].sessionId, true)

    /*
     * 重启：换一个路由实例，从**同一个 store** 读回状态。
     * 编号清单是落盘的，所以引用仍然有效——这正是微信把编号写进状态文件的理由。
     */
    const h5 = harness({ own: Array.from({ length: 25 }, (_, index) => row(index + 1, 2_000 - index)) })
    await send(h5, '你好')
    await send(h5, '/list')
    const beforeRestart = await send(h5, '查看其余')
    const restarted = new r.SessionRouter({
      gateway: {
        createSession: async () => {},
        ensureSession: async () => {},
        prompt: async () => {},
        cancel: async () => {},
        listSessions: async () => h5.live(),
        listOwnSessions: async () => h5.live(),
      },
      store: h5.store,
      titlePrefix: 'QQ',
      ownWorkspace: SELF,
      ownWorkspaceLabel: 'QQ 会话',
    })
    const afterRestart = await restarted.route({ ...CONV, text: '14', quoted: beforeRestart.text })
    await restarted.delivered(CONV.conversationId, afterRestart)
    check('★ 重启后引用仍然钉得住（编号清单是落盘的）', (await restarted.current(CONV.conversationId))?.sessionId, beforeRestart.numbered.sessions[3].sessionId)

    // 「查看其余」接的也是**存下来的**位置：重启前停在第二屏，重启后就该翻到第三屏
    const h6 = harness({ own: Array.from({ length: 25 }, (_, index) => row(index + 1, 2_000 - index)) })
    await send(h6, '你好')
    await send(h6, '/list')
    await send(h6, '查看其余')
    const restarted2 = new r.SessionRouter({
      gateway: {
        createSession: async () => {},
        ensureSession: async () => {},
        prompt: async () => {},
        cancel: async () => {},
        listSessions: async () => h6.live(),
        listOwnSessions: async () => h6.live(),
      },
      store: h6.store,
      titlePrefix: 'QQ',
      ownWorkspace: SELF,
      ownWorkspaceLabel: 'QQ 会话',
    })
    check('★ 重启后「查看其余」仍然接着翻（位置是落盘的）', (await restarted2.route({ ...CONV, text: '查看其余' })).text.startsWith('【QQ 会话】会话（3/3）'), true)
  }

  // ---- 三、会话夹那一层：进入只改浏览位置，不改绑定 ----
  {
    const h = harness({
      own: [row(1, 100), row(2, 90), row(3, 80)],
      others: { 'C:\\me\\项目甲': [row(11, 300), row(12, 200)], 'C:\\me\\项目乙': [row(21, 50)] },
    })
    await send(h, '你好')
    const before = await bound(h)

    const folders = await send(h, '/list all')
    check('★ /list all 列出会话夹', folders.text.startsWith('会话夹（1/1）'), true)
    check('★ 每个会话夹一行、带会话数', folders.text.includes('1. QQ 会话  3 个会话') && folders.text.includes('2. 项目甲  2 个会话'), true)
    check('★ 会话夹按最近活跃排', folders.text.includes('3. 项目乙  1 个会话'), true)
    check('会话夹那一层不编号会话（那是夹子，不是对话）', folders.numbered, undefined)

    const entered = await send(h, '2')
    check('★ 回编号进入会话夹', entered.text.startsWith('【项目甲】会话（1/1）'), true)
    check('★ 进去了就看到那个夹子的会话', entered.text.includes('1. 对话11'), true)
    check('★★ 进会话夹只改浏览位置，不改绑定', await bound(h), before)
    check('★ 位置落在那个会话夹的会话层', JSON.stringify([h.saved.browsing[CONV.conversationId].level, h.saved.browsing[CONV.conversationId].workspace]), JSON.stringify(['sessions', 'C:\\me\\项目甲']))

    // 从夹子那一层直接回名字也进得去
    await send(h, '/list all')
    const byName = await send(h, '项目乙')
    check('★ 会话夹按名字进入', byName.text.startsWith('【项目乙】会话（1/1）'), true)
    check('进第二个夹子仍然不改绑定', await bound(h), before)

    // 在里面再选一个会话，这才是"切过去"
    const chosen = await send(h, '1')
    check('★ 在夹子里回编号才真的切过去', await bound(h), h.others['C:\\me\\项目乙'][0].sessionId)
    check('切换之后浏览结束', h.saved.browsing[CONV.conversationId], undefined)

    // 反向对照：夹子里越界的编号不是"一步"，交给 agent
    await send(h, '/list all')
    await send(h, '项目乙')
    check('★ 夹子里越界的编号交给 agent（不猜）', (await send(h, '9')).kind, 'prompt')

    // 同名会话夹：必须问回去，而不是进错一个
    const twins = harness({
      own: [row(1, 100)],
      others: { 'C:\\a\\workplace': [row(11, 300)], 'D:\\b\\workplace': [row(21, 200)] },
    })
    await send(twins, '你好')
    const twinBefore = await bound(twins)
    await send(twins, '/list all')
    const ambiguous = await send(twins, 'workplace')
    check('★ 同名会话夹问回去', ambiguous.text.startsWith('有多个会话夹匹配「workplace」'), true)
    check('★ 歧义时点出编号与完整路径', ambiguous.text.includes('3. D:\\b\\workplace  1 个会话'), true)
    check('★ 歧义时什么都不进（绑定与位置都不变）', await bound(twins), twinBefore)
    check('歧义时位置留在会话夹那一层', twins.saved.browsing[CONV.conversationId].level, 'folders')
    const resolved = await send(twins, '3')
    check('回复编号就进得去', resolved.text.startsWith('【workplace】会话（1/1）'), true)
    check('进的是那一个（按路径分的，不是按名字）', twins.saved.browsing[CONV.conversationId].workspace, 'D:\\b\\workplace')

    // 会话夹那一层也要能翻，而且用的是**同一句**「查看其余」
    const manyFolders = harness({
      own: [row(1, 100)],
      others: Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [
          `C:\\me\\项目${String(index).padStart(2, '0')}`,
          [row(50 + index, 500 - index)],
        ]),
      ),
    })
    await send(manyFolders, '你好')
    const folderPage1 = await send(manyFolders, '/list all')
    check('★ 会话夹每屏 10 个', rowLines(folderPage1.text).length, 10)
    check('★ 会话夹还没到底时邀请翻页', folderPage1.text.includes('回复「查看其余」看下十个'), true)
    const folderPage2 = await send(manyFolders, '查看其余')
    check('★ 会话夹也翻十条，编号接着 11 起', JSON.stringify([folderPage2.text.includes('11. 项目09  1 个会话'), folderPage2.text.includes('13. 项目11  1 个会话')]), JSON.stringify([true, true]))
    check('★ 会话夹最后一屏不邀请翻页', folderPage2.text.includes('查看其余'), false)
    const folderBottom = await send(manyFolders, '查看其余')
    check('★ 会话夹翻到底的措辞', folderBottom.text.split('\n')[0], '会话夹只有 2 页，已经到底了。')
    check('★ 到底时仍然给出路（回编号或名字进入）', folderBottom.text.includes('回复编号或名字进入。'), true)
    check('★ 到底时位置留着（用户显然还在读）', manyFolders.saved.browsing[CONV.conversationId].level, 'folders')
  }

  // ---- 四、本工作区空、以及浏览位置过期 ----
  {
    const h = harness({ own: [], others: { 'C:\\me\\项目甲': [row(11, 300), row(12, 200)] } })
    const listed = await send(h, '/list')
    check('★ 本工作区空时说出来，而不是一条空清单', listed.text.includes('【QQ 会话】还没有对话'), true)
    check('★ 并点数出别的会话夹', listed.text.includes('另有 2 个对话在其它会话夹（项目甲）'), true)
    check('★ 没有东西可翻时不留下位置', h.saved.browsing[CONV.conversationId], undefined)
    check('★ /list all 仍然能列出会话夹', (await send(h, '/list all')).text.includes('1. 项目甲  2 个会话'), true)

    const empty = harness()
    check('★ 一台机器一条会话都没有时也有一句人话', (await send(empty, '/list')).text, '还没有任何对话，直接发消息就会新建一个。')
    check('★ /switch 找不到时说的是人话', (await send(empty, '/switch 不存在的对话')).text.startsWith('找不到这个对话'), true)

    /*
     * 位置过期：`at` 是给"用户走开了"用的。过期之后「查看其余」没有可接着的东西，
     * 于是那句话只是一句普通消息（交给 agent），位置也被丢掉。
     */
    const stale = harness({ own: Array.from({ length: 25 }, (_, index) => row(index + 1, 2_000 - index)) })
    stale.saved.browsing[CONV.conversationId] = {
      level: 'sessions',
      workspace: '',
      page: 2,
      at: Date.now() - (r.BROWSE_IDLE_MS + 60_000),
    }
    check('★ 过期位置上的「查看其余」不再算一步', (await send(stale, '查看其余')).kind, 'prompt')
    check('★ 过期位置被清掉', stale.saved.browsing[CONV.conversationId], undefined)
  }
}

// ---- 切换模型：`/model` 的两条行为（列出 / 切换）---------------------------
// `/model` 是本项目第一个**参数可选**的指令，也是模型功能的用户入口；
// 工具的 `model` action 复用同一个路由（见 `runtime.controlSession`），
// 所以这一节把两种输入形态与失败路径都钉住。
{
  const r = await import('../lib/router.js')

  const models = [
    { provider: 'deepseek-account', providerName: 'DeepSeek', model: 'deepseek-chat', name: 'DeepSeek Chat' },
    {
      provider: 'deepseek-account',
      providerName: 'DeepSeek',
      model: 'deepseek-reasoner',
      name: 'DeepSeek Reasoner',
      // 本机自带的 DeepSeek 适配器发布的就是这四个（`dsh-llm-deepseek` 的 REASONING_EFFORTS）。
      levels: [
        { id: 'off', name: 'Off' },
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High' },
        { id: 'max', name: 'Max' },
      ],
      defaultLevel: 'high',
    },
    {
      provider: 'other',
      providerName: 'Other',
      model: 'gpt-x',
      name: 'GPT X',
      levels: [
        { id: 'low', name: 'Low' },
        { id: 'high', name: 'High' },
      ],
      defaultLevel: 'low',
    },
  ]

  // splitCommand：空参数必须落进"没有参数"这一支，而 `/models` 不能被吃成 `/model` + `s`
  check('★ "/model" 无参数', JSON.stringify(r.splitCommand('/model')), JSON.stringify({ command: '/model', args: '' }))
  check('"/model 名字"', JSON.stringify(r.splitCommand('/model deepseek-chat')), JSON.stringify({ command: '/model', args: 'deepseek-chat' }))
  check('"/model:名字" 冒号也认', JSON.stringify(r.splitCommand('/model:gpt-x')), JSON.stringify({ command: '/model', args: 'gpt-x' }))
  check('★ "/model2" 编号粘连可用（手机键盘）', JSON.stringify(r.splitCommand('/model2')), JSON.stringify({ command: '/model', args: '2' }))
  check('★ "/model中文名" 粘连可用', JSON.stringify(r.splitCommand('/model中文名')), JSON.stringify({ command: '/model', args: '中文名' }))
  check('★ "/modelgpt" 不是 /model（不能被吃成 /model + gpt）', JSON.stringify(r.splitCommand('/modelgpt')), JSON.stringify({ command: '/modelgpt', args: '' }))
  check('★ "/models" 不是 /model', JSON.stringify(r.splitCommand('/models')), JSON.stringify({ command: '/models', args: '' }))

  // resolveModel：与 resolveTarget 同一条原则——有歧义必须失败
  check('编号', r.resolveModel('2', models)?.model, 'deepseek-reasoner')
  check('精确 id', r.resolveModel('deepseek-chat', models)?.model, 'deepseek-chat')
  check('★ 精确显示名（大小写不敏感）', r.resolveModel('gpt x', models)?.model, 'gpt-x')
  check('★ provider/model 形式', r.resolveModel('other/gpt-x', models)?.model, 'gpt-x')
  check('★ 唯一子串', r.resolveModel('reasoner', models)?.model, 'deepseek-reasoner')
  check('★ 有歧义必须失败', r.resolveModel('deepseek', models), undefined)
  check('找不到时 undefined', r.resolveModel('不存在的模型', models), undefined)
  check('空参数 undefined', r.resolveModel('   ', models), undefined)
  check('编号越界不误配', r.resolveModel('99', models), undefined)

  // renderModelList：编号必须能被 `/model <编号>` 选到（与 /list 同一份编号契约），
  // 而且每个模型要带上它自己的推理等级——那是用户在手机上唯一看得到它的地方。
  const listText = r.renderModelList(models, { provider: 'deepseek-account', model: 'deepseek-chat' })
  check('列表标出当前模型', listText.includes('← 当前'), true)
  check('列表有编号与显示名', listText.includes('1. DeepSeek Chat'), true)
  check('列表点出提供方', listText.includes('deepseek-account'), true)
  check('列表给出切换提示', listText.includes('回复名字或编号即可切换'), true)
  check('★ 编号空间一致：清单第 2 行就是 /model 2 选中的那个', listText.includes('2. DeepSeek Reasoner') && r.resolveModel('2', models) === models[1], true)
  check('★ 空目录有明确说明而不是空回复', r.renderModelList([], undefined).includes('宿主没有报出可用的模型'), true)
  check('★ 帮助里列出了 /model', r.HELP_TEXT.includes('/model'), true)
  check('★ 帮助里说明 /model 带参数是切换', r.HELP_TEXT.includes('/model <名字>'), true)
  check('★ 帮助里有「/model 等级」这一行', r.HELP_TEXT.includes('/model 等级 <等级>'), true)
  // 没有什么模型带等级时，不许邀请用户去改一个没人支持的设置
  const plain = r.renderModelList([models[0]], { provider: 'deepseek-account', model: 'deepseek-chat' })
  check('★ 没有等级时不提等级', JSON.stringify([plain.includes('推理等级'), plain.includes('/model 等级')]), JSON.stringify([false, false]))

  // 每个模型的等级：印出来、标出生效的那个、例子取自数据
  const withLevels = r.renderModelList(models, {
    provider: 'deepseek-account',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  })
  check('★ 当前模型的等级被标出（当前）', withLevels.includes('推理等级：Off · Low · High（当前） · Max'), true)
  check('★ 别的模型标的是宿主默认值（默认），不是"当前"', withLevels.includes('推理等级：Low（默认） · High'), true)
  check('★ 标题里也报出当前等级', withLevels.includes('当前是 deepseek-account/deepseek-reasoner · High'), true)
  check('★ 例子取自目录（不臆造等级 id）', withLevels.includes('例如 /model 等级 high。'), true)
  check('★ 例子取的是模型的默认等级，不是列表第一个（off 是个坏示范）', withLevels.includes('例如 /model 等级 high。') && !withLevels.includes('例如 /model 等级 off'), true)
  // 宿主没报出等级、但模型自己有默认值时，按"宿主会应用的那个"标出来
  const noEffort = r.renderModelList(models, { provider: 'deepseek-account', model: 'deepseek-reasoner' })
  check('★ 宿主没报等级时用模型自己的默认等级来标', noEffort.includes('High（当前）'), true)

  // 模型没有等级时"没有"要说出来（三种来历同一句）
  const noLevel = r.renderLevels(models[0], { provider: 'deepseek-account', model: 'deepseek-chat' }, [])
  check('模型的等级屏：没有等级时不印空行', noLevel.includes('Off'), false)

  // parseModelCommand：等级是**关键字**说出来的，不靠位置猜
  check('★ 空参数 = 说模型且没有等级', JSON.stringify(r.parseModelCommand('')), JSON.stringify({ target: '', levelForm: false }))
  check('★ 纯模型名还是纯模型名（等级出现之前的形态没变）', JSON.stringify(r.parseModelCommand('deepseek-chat')), JSON.stringify({ target: 'deepseek-chat', levelForm: false }))
  check('★「等级 high」= 只改等级', JSON.stringify(r.parseModelCommand('等级 high')), JSON.stringify({ target: '', level: 'high', levelForm: true }))
  check('★「2 等级 high」= 换模型同时指定等级', JSON.stringify(r.parseModelCommand('2 等级 high')), JSON.stringify({ target: '2', level: 'high', levelForm: true }))
  check('★「推理等级 高」按后缀也认（设置项的完整名字）', JSON.stringify(r.parseModelCommand('推理等级 高')), JSON.stringify({ target: '', level: '高', levelForm: true }))
  check('level / effort / reasoning 三个英文词都认', JSON.stringify([r.parseModelCommand('level high').levelForm, r.parseModelCommand('effort low').levelForm, r.parseModelCommand('reasoning max').levelForm]), JSON.stringify([true, true, true]))
  check('★ 只写关键字不写等级也算"在说等级"（好回一句"缺等级"）', JSON.stringify(r.parseModelCommand('等级')), JSON.stringify({ target: '', levelForm: true }))
  check('★ 多词的模型名整段保留', JSON.stringify(r.parseModelCommand('DeepSeek Reasoner 等级 max')), JSON.stringify({ target: 'DeepSeek Reasoner', level: 'max', levelForm: true }))

  // resolveLevel：宿主发布什么就认什么，只差大小写
  const levels = models[1].levels
  check('等级 id', r.resolveLevel('high', levels)?.id, 'high')
  check('★ 等级名字（大写印的那个）', r.resolveLevel('High', levels)?.id, 'high')
  check('★ 全大写也认（手机键盘免责）', r.resolveLevel('HIGH', levels)?.id, 'high')
  check('空串 undefined', r.resolveLevel('', levels), undefined)
  check('★ 不做部分匹配（猜错会悄悄改变它想多深）', r.resolveLevel('h', levels), undefined)
  check('★ 不存在的中文等级名不认（等级名字就是列表里印的那些）', r.resolveLevel('高', levels), undefined)
  check('★ 模型没发布的等级不认', r.resolveLevel('max', levels.slice(0, 3)), undefined)

  // renderLevels：一个模型自己的等级屏
  const levelScreen = r.renderLevels(models[1], { provider: 'deepseek-account', model: 'deepseek-chat' }, levels)
  check('等级屏标题', levelScreen.startsWith('DeepSeek Reasoner 的推理等级：'), true)
  check('★ 别的模型上标的是默认值', levelScreen.includes('High（默认）'), true)
  check('等级屏给出下一步', levelScreen.includes('回复 /model 等级 off 切换。'), true)

  // 路由端到端：/model 无参 = 列出；有参 = 切换；宿主拒绝 = 如实说失败
  const calls = []
  const binding = {
    conversationId: '111:peer',
    accountId: '111',
    peerId: 'peer',
    sessionId: 'session-aaaaaaaa-1111',
    title: 'QQ',
    createdAt: 1,
    lastUsedAt: 1,
  }
  const makeRouter = (overrides = {}) => {
    let bindings = { '111:peer': { ...binding } }
    return {
      router: new r.SessionRouter({
        gateway: {
          createSession: async () => {},
          ensureSession: async () => {},
          prompt: async () => {},
          listSessions: async () => [],
          listOwnSessions: async () => [],
          cancel: async () => {},
          listModels: async () => models,
          currentModel: async () => ({ provider: 'other', model: 'gpt-x' }),
          selectModel: async (sessionId, provider, model) => {
            calls.push([sessionId, provider, model])
            return { provider, model }
          },
          ...overrides,
        },
        store: {
          load: async () => bindings,
          save: async (next) => {
            bindings = next
          },
        },
        titlePrefix: 'QQ',
      }),
    }
  }
  const routeWith = (router, text) => router.route({ conversationId: '111:peer', accountId: '111', peerId: 'peer', text })

  const listing = await routeWith(makeRouter().router, '/model')
  check('★ /model 无参数 = 列出（不切换）', calls.length, 0)
  check('列出的是模型而不是对话', listing.text.includes('共 3 个可用模型'), true)
  check('列表里标出了当前模型', listing.text.includes('← 当前'), true)

  const switched = await routeWith(makeRouter().router, '/model 1')
  check('★ /model 1 = 切到清单里第 1 个', JSON.stringify(calls), JSON.stringify([['session-aaaaaaaa-1111', 'deepseek-account', 'deepseek-chat']]))
  check('切换有确认文案（带 provider/model）', switched.text.includes('已切换模型：deepseek-account/deepseek-chat'), true)
  check('★ 确认文案说明"对下一步生效"（不谎称对正在跑的那步生效）', switched.text.includes('对下一步生效'), true)

  calls.length = 0
  await routeWith(makeRouter().router, '/model GPT X')
  check('★ 按显示名切换', JSON.stringify(calls.at(-1)), JSON.stringify(['session-aaaaaaaa-1111', 'other', 'gpt-x']))

  calls.length = 0
  const missing = await routeWith(makeRouter().router, '/model 不存在的模型')
  check('★ 找不到的模型不切换', calls.length, 0)
  check('找不到时以「找不到」开门见山', missing.text.startsWith('找不到这个模型'), true)
  check('找不到时附上清单', missing.text.includes('共 3 个可用模型'), true)

  calls.length = 0
  const refused = await routeWith(
    makeRouter({
      selectModel: async () => {
        throw new Error('Select an available model before sending a message.')
      },
    }).router,
    '/model 1',
  )
  check('★ 宿主拒绝时如实说失败（不假装切了）', refused.text.startsWith('切换模型没有成功'), true)
  check('★ 失败文案带上宿主给的原因', refused.text.includes('Select an available model'), true)
  check('★ 失败文案给出下一步', refused.text.includes('/model'), true)

  // ---- 推理等级：四条契约（列出 / 只改等级 / 同时改 / 失败不静默）----
  const levelCalls = []
  /** 记下 selectModel 的四个参数，并像宿主那样把等级归一化后回传。 */
  const levelRouter = (current, overrides = {}) =>
    makeRouter({
      currentModel: async () => current,
      selectModel: async (sessionId, provider, model, reasoningEffort) => {
        levelCalls.push([sessionId, provider, model, reasoningEffort])
        const option = models.find((row) => row.provider === provider && row.model === model)
        const effort = reasoningEffort ?? option?.defaultLevel
        return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
      },
      ...overrides,
    }).router

  /*
   * ① 换模型时**默认等级随选择一起交下去**。
   * 不交的话，"用哪个等级"就交给了一个用户看不见的解析步骤；而交下去的值，用户能在清单里看到。
   */
  levelCalls.length = 0
  const switchedWithLevel = await routeWith(levelRouter({ provider: 'deepseek-account', model: 'deepseek-chat' }), '/model 2')
  check('★ 换模型时带上模型自己声明的默认等级', JSON.stringify(levelCalls), JSON.stringify([['session-aaaaaaaa-1111', 'deepseek-account', 'deepseek-reasoner', 'high']]))
  check('★ 确认文案报出生效的等级', switchedWithLevel.text.includes('推理等级：High'), true)
  check('★ 确认文案仍然说明"对下一步生效"', switchedWithLevel.text.includes('对下一步生效'), true)
  // 反向对照：模型没有等级时**不带**这个参数（写个 undefined 进去会让"没指名"变成一件事）
  levelCalls.length = 0
  await routeWith(levelRouter({ provider: 'deepseek-account', model: 'deepseek-reasoner' }), '/model 1')
  check('★ 反向对照：没有等级的模型不传 reasoningEffort', JSON.stringify(levelCalls), JSON.stringify([['session-aaaaaaaa-1111', 'deepseek-account', 'deepseek-chat', undefined]]))

  // ② 只改等级：模型不动
  levelCalls.length = 0
  const onlyLevel = await routeWith(
    levelRouter({ provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' }),
    '/model 等级 low',
  )
  check('★「/model 等级 low」只改等级（模型仍是同一个）', JSON.stringify(levelCalls), JSON.stringify([['session-aaaaaaaa-1111', 'deepseek-account', 'deepseek-reasoner', 'low']]))
  check('★ 只改等级时说的是"等级切到"，不是"切换模型"', onlyLevel.text.startsWith('已把「QQ」的推理等级切到 Low（DeepSeek Reasoner）。'), true)
  check('只改等级也说明对下一步生效', onlyLevel.text.includes('对下一步生效'), true)

  // ③ 同时改：模型 + 等级
  levelCalls.length = 0
  const both = await routeWith(levelRouter({ provider: 'deepseek-account', model: 'deepseek-chat' }), '/model 2 等级 low')
  check('★「/model 2 等级 low」两个一起改', JSON.stringify(levelCalls), JSON.stringify([['session-aaaaaaaa-1111', 'deepseek-account', 'deepseek-reasoner', 'low']]))
  check('★ 两个都改时按"切换模型"报告，并报出等级', both.text.includes('已切换模型：deepseek-account/deepseek-reasoner') && both.text.includes('推理等级：Low'), true)

  // ④ 只问等级（不带等级值）：什么都不改
  levelCalls.length = 0
  const asked = await routeWith(levelRouter({ provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' }), '/model 等级')
  check('★「/model 等级」= 报出这个模型的等级，不切换', levelCalls.length, 0)
  check('★ 报出等级并标出生效的那个', asked.text.includes('Off · Low · High（当前） · Max'), true)

  // ⑤ 失败必须说出来 —— 三条不同的失败，三种不同的话
  levelCalls.length = 0
  const unknownLevel = await routeWith(
    levelRouter({ provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' }),
    '/model 等级 高',
  )
  check('★ 认不出的等级不切换', levelCalls.length, 0)
  check('★ 认不出的等级以「找不到这个等级」开门见山', unknownLevel.text.startsWith('找不到这个等级「高」'), true)
  check('★ 并把合法取值整份印出来（那是用户猜不出来的东西）', unknownLevel.text.includes('Off、Low、High、Max'), true)

  levelCalls.length = 0
  const noLevels = await routeWith(levelRouter({ provider: 'deepseek-account', model: 'deepseek-chat' }), '/model 等级 high')
  check('★ 模型没有等级时明说，而不是"切成功了"', JSON.stringify([levelCalls.length, noLevels.text.startsWith('当前模型不支持推理等级')]), JSON.stringify([0, true]))

  levelCalls.length = 0
  const levelRefused = await routeWith(
    levelRouter(
      { provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' },
      {
        selectModel: async () => {
          throw new Error('DeepSeek does not support reasoning effort "max"')
        },
      },
    ),
    '/model 等级 max',
  )
  check('★ 宿主拒绝换等级时如实说失败（绝不回一句"已切换"）', levelRefused.text.startsWith('切换推理等级没有成功'), true)
  check('★ 失败文案带上宿主给的原因', levelRefused.text.includes('does not support reasoning effort'), true)
  check('★ 失败的等级切换文案里没有"已把…切到"', levelRefused.text.includes('已把'), false)

  // 没有对话时不能凭空调等级（等级的归属也是会话）
  // 没有对话时不能凭空调模型（模型的归属是会话）
  const noBinding = new r.SessionRouter({
    gateway: { createSession: async () => {}, ensureSession: async () => {}, prompt: async () => {}, listSessions: async () => [], listOwnSessions: async () => [], cancel: async () => {}, listModels: async () => models },
    store: { load: async () => ({}), save: async () => {} },
    titlePrefix: 'QQ',
  })
  const orphan = await routeWith(noBinding, '/model')
  check('★ 没有对话时 /model 不硬造一个会话', orphan.text.includes('当前没有对话'), true)
  const orphanLevel = await routeWith(noBinding, '/model 等级 high')
  check('★ 没有对话时 /model 等级 不硬造一个会话', orphanLevel.text.includes('当前模型不支持推理等级'), true)
}

// ---- 会话索引：目录编码是实测出来的精确字符串 ------------------------------
{
  const si = await import('../lib/session-index.js')
  check('★ encodeWorkspaceDir 精确值', si.encodeWorkspaceDir('C:\\Users\\me\\.dsh\\dsh_qq'), '--C-Users-me-.dsh-dsh_qq--')
  check('★ encodeWorkspaceDir 去首尾分隔符', si.encodeWorkspaceDir('/home/me/x/'), '--home-me-x--')
  check('反斜杠与正斜杠等价', si.isSameWorkspace('C:\\a\\b', 'C:/a/b'), true)
  check('尾部斜杠不影响', si.isSameWorkspace('C:\\a\\b\\', 'C:\\a\\b'), true)
  check('不同目录不相等', si.isSameWorkspace('C:\\a\\b', 'C:\\a\\c'), false)
  /*
   * ★ 大小写归一**是平台的函数**，不是一件常真的事：`lib/session-index.js` 的
   * `CASE_INSENSITIVE_PATHS` 就是 `process.platform === 'win32' || 'darwin'`。
   *
   * 这一条原来只写 `si.isSameWorkspace('C:\\A\\B', 'c:\\a\\b')` 并期望 `true`——那等于把
   * "跑测试的这台机器是 Windows"当成了前提，在 Linux 上必然变红（CI run `38380657508`
   * 就是这样挂在第 6 步的，而且它是那一轮**唯一**一条红的）。
   *
   * 现在把三件事放进同一条里钉住：显式 `true` 归一、显式 `false` 不归一、
   * 以及**不给第三个参数时取的就是本平台的文件系统语义**。
   *
   * ⚠️ 期望值从 `process.platform` **自己写一遍**，不从被测的那个常数抄一份：
   * 抄一份的话，"把常数改成恒 `true`"这种回归会和期望一起移动，这条断言就抓不住它
   * （在 Linux 上把 `/A/B` 与 `/a/b` 当成同一个目录是真的会出事的）。
   */
  const caseInsensitiveHere = process.platform === 'win32' || process.platform === 'darwin'
  check(
    '★ 大小写归一只按平台：显式 true 归一、显式 false 不归一、不给参数时按本平台的文件系统语义',
    JSON.stringify([
      si.isSameWorkspace('C:\\A\\B', 'c:\\a\\b', true),
      si.isSameWorkspace('C:\\A\\B', 'c:\\a\\b', false),
      si.isSameWorkspace('C:\\A\\B', 'c:\\a\\b'),
      si.CASE_INSENSITIVE_PATHS,
    ]),
    JSON.stringify([true, false, caseInsensitiveHere, caseInsensitiveHere]),
  )
  check('★ Linux 不忽略大小写', si.isSameWorkspace('/A/B', '/a/b', false), false)
}

/*
 * ---- 会话索引：时间取自记录、排序构成全序 ----------------------------------
 *
 * 这一节钉的是 QQ 从微信**修之前**的版本抄来的那两个 bug：
 *
 * 1. 时间取自会话目录里最新文件的 mtime——而 mtime 回答的是"这个目录最后被写是什么时候"，
 *    任何写入都会改它，于是同一个会话每次显示的"上次时间"都不同，行序跟着变。
 * 2. 排序只有一个键——时间撞车时落回目录遍历顺序，而"时间撞车"在真实存储里是常态。
 *
 * 断言全部走**真存储**（真目录、真文件），因为这两个 bug 都无法从纯函数上看出来；
 * 而每一条都有反向对照：mtime 与记录时间**刻意反着放**，创建顺序与时间顺序也反着放，
 * 所以任何一处退回旧实现都会当场变红。
 */
{
  const { mkdirSync, rmSync, writeFileSync, utimesSync } = await import('node:fs')
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const si = await import('../lib/session-index.js')

  /**
   * 往真存储里写一条会话记录。
   *
   * `mtimeSeconds` 与记录时间**故意分开给**：这正是"读的是记录不是文件"的判据。
   *
   * @param home - 造的 DSH 主目录。
   * @param cwd - 这条会话记的工作目录。
   * @param id - 会话 id。
   * @param title - 标题。
   * @param record - 记录里的时间字段，见下面三种形态。
   * @param mtimeSeconds - 给正文文件打的 mtime；不给就不动它。
   */
  function seedRecorded(home, cwd, id, title, record, mtimeSeconds) {
    const dir = join(home, 'sessions', si.encodeWorkspaceDir(cwd), id)
    mkdirSync(dir, { recursive: true })
    const transcript = join(dir, 'session.v4.jsonl.zstd')
    writeFileSync(transcript, 'x')
    if (mtimeSeconds !== undefined) utimesSync(transcript, mtimeSeconds, mtimeSeconds)
    const indexDir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(indexDir, { recursive: true })
    writeFileSync(
      join(indexDir, `${id}.json`),
      JSON.stringify({ version: 7, record: { identity: { cwd, ...record.identity }, rows: record.rows } }),
      'utf8',
    )
  }

  /** 一条只带 `lastPromptAt` 的记录，形态与真存储写的一致。 */
  function promptRecord(cwd, title, lastPromptAt) {
    return { identity: { cwd }, rows: { title: { val: title }, sessionListMetadata: { val: { lastPromptAt } } } }
  }

  function makeHome() {
    return mkdtempSync(join(tmpdir(), 'dsh-qq-index-'))
  }

  // ---- 1. 时间取自记录，不是 mtime ----------------------------------------
  {
    const home = makeHome()
    try {
      const workspace = join(home, 'dsh_qq')
      /*
       * 八条会话，`lastPromptAt` 从新到旧分别是 index 0..7，落在 `ids[0..7]`；
       * 而 mtime 是 `index` **秒**（1970 年）——两个量差着五十多年，正反都能分辨。
       * 另外 id 的 6 位前缀按 0f,0e,…,08 **递减**：所以"按 id 升序"给出的是 `ids` 的**逆序**，
       * 与时间顺序**正好相反**——退回单键排序（或用 id 当主键）都会印出另一份清单。
       */
      const ids = []
      const stamps = []
      for (let index = 0; index < 8; index += 1) {
        const hex = (0x08 + index).toString(16).padStart(2, '0')
        const id = `session-${hex}ffff-${hex}ffff-x`
        const at = 1_700_000_000_000 + index * 3_600_000
        ids.push(id)
        stamps.push(at)
        seedRecorded(home, workspace, id, `第${String(index)}条`, promptRecord(workspace, `第${String(index)}条`, at), index)
      }
      /*
       * 反向对照的前提：`ids` 是升序而 `stamps` 是升序，于是**时间倒序**给出的正是 `ids` 的逆序。
       * 一个只按 id 升序、不看时间的比较器会印出 `[...ids].reverse()`——与这里期望的相反。
       */
      check('★ 夹具的两个顺序确实相反（否则这两条断言没有分辨力）', ids[0] < ids[7], true)
      check('★ 时间确实是递增的（新的是 index 大的那条）', stamps[0] < stamps[7], true)

      const listed = await si.listStoredSessions(home, workspace)
      check('★ 清单条目数就是磁盘上的条目数', listed.length, 8)
      check(
        '★ 行序按记录里的 lastPromptAt 倒序（mtime 与 id 顺序都反着放）',
        JSON.stringify(listed.map((row) => row.sessionId)),
        JSON.stringify([...ids].reverse()),
      )
      check(
        '★ updatedAt 就是记录里那个毫秒时间戳，不是文件时间',
        JSON.stringify(listed.map((row) => row.updatedAt)),
        JSON.stringify([...stamps].reverse()),
      )
      check(
        '★ 记录里的时间不是 1970（mtime 全都落在那里）',
        listed.every((row) => row.updatedAt > 1_600_000_000_000),
        true,
      )
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }

  // ---- 2. 没有 lastPromptAt 时退回 createdAt ------------------------------
  {
    const home = makeHome()
    try {
      const workspace = join(home, 'dsh_qq')
      const createdAt = 1_700_000_123_456
      seedRecorded(
        home,
        workspace,
        'session-dddd4444-dddd4444-x',
        '',
        { identity: { cwd: workspace, createdAt }, rows: {} },
        // mtime 又是一个完全不同的值：读它就得不到那个数字。
        2_000_000,
      )
      const listed = await si.listStoredSessions(home, workspace)
      check('★ 没有 lastPromptAt 时退回 identity.createdAt', listed[0]?.updatedAt, createdAt)
      check('★ 那种记录仍然被列出来（只是没有标题）', listed[0]?.title, '')
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }

  // ---- 3. 比较器本身是全序 ------------------------------------------------
  {
    const stamp = 1_700_000_000_000
    const a = { sessionId: 'session-aaaa1111-aaaa1111-x', updatedAt: stamp }
    const b = { sessionId: 'session-bbbb2222-bbbb2222-x', updatedAt: stamp }
    check('★ 时间相同则按 sessionId 升序（a 在前）', si.compareSessionsNewestFirst(a, b) < 0, true)
    check('★ 反向为正在（所以它不是"永远返回 -1"）', si.compareSessionsNewestFirst(b, a) > 0, true)
    check('★ 同一条与自己比是 0', si.compareSessionsNewestFirst(a, { ...a }), 0)
    check('★ 新的永远在前，不管 id 谁大', si.compareSessionsNewestFirst({ ...b, updatedAt: stamp + 1 }, a) < 0, true)
    check('★ 缺 updatedAt 的当成 0（不会因为 NaN 把排序搅乱）', si.compareSessionsNewestFirst({ sessionId: 'x' }, { sessionId: 'y', updatedAt: 1 }), 1)
    // 反向对照：单键比较器在这里只可能返回 0，于是平手落回输入顺序——那正是要终结的不稳定。
    check('★ 单键会返回 0 的那一对，全序给出确定答案', si.compareSessionsNewestFirst(a, b) !== 0, true)
  }

  // ---- 4. 颠倒输入顺序，输出逐字节相同 ------------------------------------
  {
    /** 造 90 条会话 / 6 个工作区，每 3 条共用一个时间戳（时间撞车是常态）。 */
    const workSeconds = 1_786_000_000
    /** 90 个 id 里最小的那个十六进制值；id 按**倒序**发放。 */
    const idTop = 89
    const recordsOf = (workIndex) => {
      const workspace = join('C:\\work', `ws${String(workIndex)}`)
      const rows = []
      for (let local = 0; local < 15; local += 1) {
        const global = workIndex * 15 + local
        /*
         * ⚠️ id 按**倒序**发放（第 0 条拿最大的 id），因为这一节必须能分辨"全序"与"单键"：
         * 时间撞车的那 3 条在输入里是**降序**的，而全序给出的是**升序**。
         * 如果 id 顺着输入递增，单键排序（稳定、保留输入顺序）也会印出同一份清单——
         * 夹具就什么也证明不了（这个坑第一版真踩了）。
         */
        const hex = (idTop - global).toString(16).padStart(6, '0')
        rows.push({
          id: `session-${hex}-${hex}0000-x`,
          title: `对话${String(global)}`,
          // 每三条共享一个时间戳：整个工作区里 15 条只落在 5 个时刻上。
          // 六个工作区用**同一个**基准秒，好让一个主目录里能装下全部 90 条。
          at: (workSeconds - Math.floor(local / 3) * 60) * 1000,
        })
      }
      return { workspace, rows }
    }
    const works = Array.from({ length: 6 }, (_, index) => recordsOf(index))

    /**
     * 全序的**定义**，与实现分开写一份：时间倒序，平手按 sessionId 升序。
     *
     * 独立写一遍是有意的——用它来断言"磁盘走出来的顺序没有渗进结果"。
     *
     * @param rows - 任意顺序的行。
     */
    const expectedOrder = (rows) =>
      [...rows].sort((a, b) => {
        if (a.at !== b.at) return b.at - a.at
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })

    /** 只按时间的单键排序——**旧实现**，留作反向对照。 */
    const singleKeyOrder = (rows) => [...rows].sort((a, b) => b.at - a.at)

    /** 把一个主目录里**全部六个工作区**的会话写进去；`reverse` 决定创建顺序。 */
    const buildStore = (reverse) => {
      const home = makeHome()
      const order = reverse ? [...works].reverse() : works
      for (const work of order) {
        const rows = reverse ? [...work.rows].reverse() : work.rows
        for (const row of rows) {
          // mtime 给一个与记录无关的值：读它的实现会得到另一份清单。
          seedRecorded(home, work.workspace, row.id, row.title, promptRecord(work.workspace, row.title, row.at), 1_000_000)
        }
      }
      return home
    }

    /** 把一次读数拉平成一行，好逐字节比较。 */
    const flatten = (all) => {
      const lines = []
      let count = 0
      for (const [path, list] of all) {
        count += list.length
        lines.push(JSON.stringify([path, list]))
      }
      return { count, groups: all.size, bytes: JSON.stringify(lines) }
    }

    const homes = [buildStore(false), buildStore(true)]
    try {
      const draws = []
      for (const home of homes) draws.push(flatten(await si.listAllStoredSessions(home)))

      check('★ 90 个会话 / 6 个工作区（夹具口径与微信实测一致）', JSON.stringify([draws[0].count, draws[0].groups]), JSON.stringify([90, 6]))
      check('两份存储（目录创建顺序相反）读数逐字节相同', draws[0].bytes === draws[1].bytes, true)
      check('倒着建目录的那一份也读到 90 条', draws[1].count, 90)

      /*
       * `/list` 真正走的是逐工作区那条路，所以每个工作区单独再读一次。
       * 断言分成两半：**行序等于定义**，以及**重复读逐字节相同**。
       */
      const first = []
      for (const work of works) {
        const listed = await si.listStoredSessions(homes[0], work.workspace)
        first.push(JSON.stringify(listed))
        check(
          `★ 工作区 ${work.workspace} 的行序就是全序定义（走的目录顺序没有渗进来）`,
          JSON.stringify(listed.map((row) => row.sessionId)),
          JSON.stringify(expectedOrder(work.rows).map((row) => row.id)),
        )
      }
      const again = []
      for (const work of works) {
        again.push(JSON.stringify(await si.listStoredSessions(homes[0], work.workspace)))
      }
      check('★ 同一个工作区读两次，逐字节相同', first.join('|') === again.join('|'), true)
      const reversedHomes = []
      for (const work of works) {
        reversedHomes.push(JSON.stringify(await si.listStoredSessions(homes[1], work.workspace)))
      }
      check('★ 倒着建目录的那份存储，逐工作区读数逐字节相同', first.join('|') === reversedHomes.join('|'), true)

      // 时间撞车确实发生了，否则这一节什么也没验到。
      const collision = await si.listStoredSessions(homes[0], works[0].workspace)
      const distinct = new Set(collision.map((row) => row.updatedAt)).size
      check('★ 15 条会话只落在 5 个时间戳上（撞车是常态，不是假设）', distinct, 5)
      check('★ 清单整体仍按时间倒序', collision[0].updatedAt > collision[14].updatedAt, true)
      check('★ 时间一律是记录里的毫秒值（没有一条落回 1970）', collision.every((row) => row.updatedAt > 1_700_000_000_000), true)

      /*
       * ★ 反向对照：**同一份 15 条数据，把输入数组整个倒过来再排序，输出必须逐字节相同。**
       *
       * 这一条才是"全序"的真正判据，而且它是**可判定的**——上一版这里做的是
       * "把目录创建顺序倒过来"，那个实验在 NTFS 上什么都证明不了：探针实测
       * `readdirSync` 给出的是**字典序**（创建 d b f a e c，读回来 a b c d e f），
       * 于是"走目录顺序"与"按 sessionId 升序"是同一个顺序，
       * 单键排序也会通过。
       */
      const rowObjects = works[0].rows.map((row) => ({ sessionId: row.id, updatedAt: row.at }))
      const ascending = [...rowObjects].sort(si.compareSessionsNewestFirst)
      const descending = [...rowObjects].reverse().sort(si.compareSessionsNewestFirst)
      check('★ 输入倒序后排序结果逐字节相同（全序的直接判据）', JSON.stringify(ascending), JSON.stringify(descending))
      check(
        '★ 而且这个结果就是全序定义（不是"两次都一样地错"）',
        JSON.stringify(ascending.map((row) => row.sessionId)),
        JSON.stringify(expectedOrder(works[0].rows).map((row) => row.id)),
      )

      /*
       * ★ 反向对照的**前提**：单键排序在这份夹具上确实给出另一份清单。
       *
       * 没有这一条，上面那些"逐字节相同"完全可能因为输入本来就同序而永远为真。
       */
      const naive = singleKeyOrder(works[0].rows).map((row) => row.id)
      check('★ 单键排序（旧实现）在这份夹具上确实给出**不同**的行序', naive.join(',') !== ascending.map((row) => row.sessionId).join(','), true)
      check(
        '★ 单键排序把平手留给了输入顺序（同一个库两次印出不同清单的机制）',
        singleKeyOrder(works[0].rows).map((row) => row.id).join(',') ===
          singleKeyOrder([...works[0].rows].reverse()).map((row) => row.id).join(','),
        false,
      )
    } finally {
      for (const home of homes) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }
}

/*
 * ---- 归档 / 会话在磁盘上不存在 → 消息静默消失 ------------------------------
 *
 * 钉的是这么一件事：**归档不是磁盘标记**。被归档的会话还在磁盘上，`prompt` 照常"接受"，
 * 随后壳的归档门卫在 `agent/pre-step` **静默 reject**，回合以 `blocked` 结束——
 * 没有错误、没有日志、用户什么都没收到。磁盘上已经没有的会话同理。
 * 所以 `#submit` 不会失败 → 不会回"没能把消息交给会话" → 和微信一样**全程静默**。
 *
 * 修法是路由在**复用既有绑定之前**问一句（探针可选），不可用就新建 + 改绑 + 回一句话。
 *
 * ⚠️ 这一节能证明的只有"路由的判定与动作符合微信的契约"。
 * **真机上"归档一条真实会话之后消息是否被正确换绑"没有验证过**——那要有运行中的 DSH，
 * 而且会动到真实会话，只能由用户实测。
 */
{
  const r = await import('../lib/router.js')

  const CONV = { conversationId: '111:peer', accountId: '111', peerId: 'peer' }
  const OLD = 'session-e716f0aa-e716f0aa-47fd'
  const OLD_TITLE = 'QQ e716f0'

  /**
   * 一个只有一条绑定的假宿主。
   *
   * `state` 是探针的答案；不给 `state` 就是**没有探针**（可选能力的缺席）。
   * `throws` 让探针抛错。
   *
   * `heal` = 探针只对**原来那条**会话给 `state`，新建出来的会话一律报 `usable`——
   * 那是真实宿主的行为（新会话没被归档），也是"搬一次家就够"的前提。
   * 不开 `heal` 时探针对谁都说 `state`，于是每来一条消息就再搬一次：
   * 那是宿主**自相矛盾**的答案，不是路由的死循环，所以那个形状单独断言。
   */
  const harness = ({ state, throws = false, ageMs = 0, withProbe = true, heal = true } = {}) => {
    const calls = []
    let bindings = {
      [CONV.conversationId]: {
        conversationId: CONV.conversationId,
        accountId: CONV.accountId,
        peerId: CONV.peerId,
        sessionId: OLD,
        title: OLD_TITLE,
        createdAt: Date.now() - ageMs,
        lastUsedAt: Date.now() - ageMs,
      },
    }
    const gateway = {
      createSession: async (sessionId) => calls.push(['createSession', sessionId]),
      // 采纳那条路必须**不被走到**：定死的绑定被换掉之后不该再去 ensure 旧会话。
      ensureSession: async (sessionId) => calls.push(['ensureSession', sessionId]),
      prompt: async () => {},
      cancel: async () => {},
      listSessions: async () => [],
      listOwnSessions: async () => [],
      listModels: async () => [],
      currentModel: async () => undefined,
      selectModel: async () => {
        throw new Error('这一节不测模型')
      },
      ...(withProbe
        ? {
            sessionState: async (sessionId) => {
              calls.push(['sessionState', sessionId])
              if (throws) throw new Error('探针炸了')
              if (heal && sessionId !== OLD) return 'usable'
              return state
            },
          }
        : {}),
    }
    const lines = []
    const router = new r.SessionRouter({
      gateway,
      store: {
        load: async () => bindings,
        save: async (next) => {
          bindings = next
        },
      },
      titlePrefix: 'QQ',
      onDiagnostic: (line) => lines.push(line),
    })
    return {
      router,
      calls,
      lines,
      /** 现在落盘的绑定。 */
      binding: () => bindings[CONV.conversationId],
      route: (text) => router.route({ ...CONV, text }),
    }
  }

  // ---- 1. 没有探针：行为与加它之前完全一样，绝不换绑 ----------------------
  {
    const h = harness({ withProbe: false })
    const routed = await h.route('你好')
    check('★ 宿主没有探针时不换绑（消息照旧交给原来那条会话）', routed.decision.sessionId, OLD)
    check('★ 也不建新会话', h.calls.filter(([name]) => name === 'createSession').length, 0)
    check('★ 没有探针不是错误，但也没换绑（notice 不该出现）', routed.decision.notice, undefined)
    check('★ 复用走的还是 ensureSession（旧行为）', JSON.stringify(h.calls.filter(([name]) => name === 'ensureSession')), JSON.stringify([['ensureSession', OLD]]))
    check('落盘的绑定仍指着旧会话', h.binding().sessionId, OLD)
  }

  // ---- 2. 探针抛错：一律按 usable，绝不换绑 ------------------------------
  {
    const h = harness({ throws: true })
    const routed = await h.route('你好')
    check('★ 探针抛错时不换绑（坏探针不能弄丢消息）', routed.decision.sessionId, OLD)
    check('★ 抛错时也不建新会话', h.calls.filter(([name]) => name === 'createSession').length, 0)
    check('★ 抛错必须留下日志（不许静默）', h.lines.some((line) => line.includes('探针失败') && line.includes(OLD)), true)
    check('★ 日志里写明"按可用处理"', h.lines.some((line) => line.includes('按可用处理')), true)
    check('抛错的处理方式就是复用旧会话', JSON.stringify(h.calls.filter(([name]) => name === 'ensureSession')), JSON.stringify([['ensureSession', OLD]]))
    check('落盘的绑定仍指着旧会话', h.binding().sessionId, OLD)
  }

  // ---- 3. usable：什么都不做 ---------------------------------------------
  {
    const h = harness({ state: 'usable' })
    const routed = await h.route('你好')
    check('usable 时复用绑定', routed.decision.sessionId, OLD)
    check('usable 时没有 notice', routed.decision.notice, undefined)
    check('usable 时探针确实被问过', JSON.stringify(h.calls.filter(([name]) => name === 'sessionState')), JSON.stringify([['sessionState', OLD]]))
  }

  // ---- 4. archived：立即换绑，而且不受宽限期约束 --------------------------
  {
    // 年龄为 0：如果宽限期被错误地套用到 archived 上，这一条会失败。
    const h = harness({ state: 'archived', ageMs: 0 })
    const routed = await h.route('你好')
    check('★ archived 立即换绑（哪怕绑定是刚建的）', routed.decision.sessionId !== OLD, true)
    check('★ 换绑后用户收到一句话（不许静默换掉对话）', typeof routed.decision.notice === 'string' && routed.decision.notice !== '', true)
    check('★ 那句话说明旧对话是被归档了', routed.decision.notice.includes('已经被归档'), true)
    check('★ 那句话点名旧标题（用户才认得出被落下的是哪个）', routed.decision.notice.includes(OLD_TITLE), true)
    check('★ 落盘的绑定指着新会话（否则下一条又落回归档的会话）', h.binding().sessionId, routed.decision.sessionId)
    check('★ 日志里有 state=archived、旧 id、新 id', h.lines.some((line) => line.includes('state=archived') && line.includes(OLD) && line.includes(routed.decision.sessionId)), true)
    check('★ 换绑走的是 createSession 而不是 ensureSession（旧会话已被放弃）', h.calls.filter(([name]) => name === 'ensureSession').length, 0)
    check('新会话确实被创建过', JSON.stringify(h.calls.filter(([name]) => name === 'createSession').map(([, id]) => id)), JSON.stringify([routed.decision.sessionId]))
    check('created 标记为真（这一条消息开启了新会话）', routed.decision.created, true)
  }

  // ---- 5. ⭐ missing 的宽限期：满 2 分钟才信 ------------------------------
  {
    // 刚建好的绑定 + missing，就是"新会话的首轮还没写下记录"——信它会造成无限新建循环。
    const young = harness({ state: 'missing', ageMs: 0 })
    const youngRouted = await young.route('你好')
    check('★ missing 在宽限期内**不**换绑（这就是无限新建循环的坑）', youngRouted.decision.sessionId, OLD)
    check('★ 宽限期内也不建新会话', young.calls.filter(([name]) => name === 'createSession').length, 0)
    check('★ 宽限期内没有 notice（对话没有搬家）', youngRouted.decision.notice, undefined)
    check('★ 宽限期内必须留下日志（能据此排掉"为什么没换"）', young.lines.some((line) => line.includes('missing') && line.includes(OLD) && line.includes('宽限')), true)

    // 只差一点点：1 分 59 秒，仍然不换。
    const almost = harness({ state: 'missing', ageMs: r.MISSING_BINDING_GRACE_MS - 1000 })
    check('★ 还差一秒也不换绑（边界是"满"两分钟）', (await almost.route('你好')).decision.sessionId, OLD)

    // 满 2 分钟：这次要换。
    const old = harness({ state: 'missing', ageMs: r.MISSING_BINDING_GRACE_MS })
    const oldRouted = await old.route('你好')
    check('★ missing 满宽限期后换绑', oldRouted.decision.sessionId !== OLD, true)
    check('★ 换绑后同样回一句话', typeof oldRouted.decision.notice === 'string' && oldRouted.decision.notice !== '', true)
    check('★ 那句话说的是"在电脑上已经不存在了"（与归档区分开）', oldRouted.decision.notice.includes('在电脑上已经不存在了'), true)
    check('★ 落盘的绑定指着新会话', old.binding().sessionId, oldRouted.decision.sessionId)
    check('★ 日志里有 state=missing', old.lines.some((line) => line.includes('state=missing')), true)
    check('宽限期本身是 2 分钟', r.MISSING_BINDING_GRACE_MS, 2 * 60 * 1000)
  }

  // ---- 6. 换绑之后再来的消息：新会话可用就不必再搬 ------------------------
  {
    const h = harness({ state: 'archived', ageMs: 10 * 60 * 1000 })
    const first = await h.route('第一条')
    const second = await h.route('第二条')
    check('★ 连着两条消息只搬一次家（第二条落在新会话上）', second.decision.sessionId, first.decision.sessionId)
    check('★ 第二条没有重复回那句提示（搬过一次就不再啰嗦）', second.decision.notice, undefined)
    check('★ 探针被问了两次（每次复用都问）', h.calls.filter(([name]) => name === 'sessionState').length, 2)
    check('旧会话只被问过一次（换掉之后不再问它）', h.calls.filter(([name, id]) => name === 'sessionState' && id === OLD).length, 1)

    /*
     * 反向对照：宿主对**刚新建的**会话也答 `archived` 时，路由会继续搬。
     *
     * 这是宿主自相矛盾（它让频道建了一条它自己判定不可用的会话），路由的职责是**照它的答案办**，
     * 而不是自己发明一条"搬过一次就不再信探针"的规则——那条规则会把真正的归档漏掉。
     * 单独钉住这个形状，是为了说明第 6 节上面那两条断言测的是"新会话可用"，
     * **不是**"路由会自我克制"。
     */
    const stubborn = harness({ state: 'archived', ageMs: 10 * 60 * 1000, heal: false })
    const movedOnce = await stubborn.route('甲')
    const movedTwice = await stubborn.route('乙')
    check('★ 宿主对新会话也答 archived 时，路由照它的话继续搬（不自己发明克制规则）', movedTwice.decision.sessionId !== movedOnce.decision.sessionId, true)
  }

  /*
   * ---- 7. ⭐ 反向对照的前提：宽限期这条断言真的有分辨力 --------------------
   *
   * 上面第 5 条只有在这个前提下才有意义：把宽限期拿掉（等价于第一版"只对 missing 换新"的
   * 实现），同一个夹具**必须**换绑。这里用一个"年龄 0"的夹具直接证明那个差别存在，
   * 免得宽限期那条断言其实在测一个无论怎样都成立的恒等式。
   */
  {
    const young = harness({ state: 'missing', ageMs: 0 })
    const probeSays = await young.router.route({ ...CONV, text: '你好' })
    const firstId = probeSays.decision.sessionId
    // 没有宽限期的实现会在这里换绑；有宽限期的实现在这里复用。
    check('★ 年龄 0 的绑定：有宽限期时**不**换（对照第 5 条的年龄满 2 分钟时会换）', firstId, OLD)
    const aged = harness({ state: 'missing', ageMs: r.MISSING_BINDING_GRACE_MS + 1 })
    check('★ 同一个夹具只把年龄推过宽限期，结果就反过来（所以宽限期确实在起作用）', (await aged.route('你好')).decision.sessionId !== OLD, true)
  }

  /*
   * ---- 8. ⭐ 运行时那一层：真网关的探针 + 回话真的发出去了 -----------------
   *
   * 上面 1–7 节测的是路由（假宿主）。这一节把**真的 `QqRuntime`** 跑起来，
   * 让入站消息走完整条链：`#handleInbound` → `#deliverPrompt` → 真网关的 `sessionState`
   * （真的读磁盘）→ 路由换绑 → `#send` 把那句话发出去。
   *
   * 要证明的是"**换绑之后确实回了话**"——只断言 `decision.notice` 存在并不够，
   * 它完全可能被丢在运行时那一层、谁也没发。
   *
   * ⚠️ 仍然是**离线**的：QQBot 的连接与发送都被换成了假的，没有任何网络。
   */
  {
    const { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { QQBot } = await import('@tencent-connect/qqbot-nodejs')
    const { QqRuntime } = await import('../lib/runtime.js')

    const home = mkdtempSync(join(tmpdir(), 'dsh-qq-notice-'))
    const sent = []
    const prompts = []
    const sessions = []
    /** 真的 QQBot 实例挂上的事件处理器，按事件名收在这里。 */
    const botListeners = new Map()
    const realStart = QQBot.prototype.start
    const realSendText = QQBot.prototype.sendText
    const realOn = QQBot.prototype.on
    try {
      /*
       * 假的连接、假的发送、以及**把事件处理器截下来**：只记录，不出网。
       *
       * 三个都打在**原型**上，因为真的 `QQBot` 是 `start()` 内部自己 new 出来的
       * （runtime.js 的 `const bot = new QQBot({...})`），测试拿不到那个构造点。
       * 实例方法会遮蔽原型方法，所以这个替换对那一个实例同样生效。
       */
      QQBot.prototype.start = async function start() {
        return undefined
      }
      QQBot.prototype.sendText = async function sendText(target, text) {
        sent.push({ target, text })
        return {}
      }
      QQBot.prototype.on = function on(event, listener) {
        const list = botListeners.get(event) ?? []
        list.push(listener)
        botListeners.set(event, list)
        return this
      }

      const STALE = 'session-aaaabbbb-aaaabbbb-0000'
      /*
       * 两件事都要给对，否则这条链第一句就抛，而抛出的东西与被测行为**毫无关系**：
       *
       * - `sessionController` 走的是**属性**访问（`this.#ctx.sessionController.create/prompt`），
       *   不是 `ctx.get`。第一次跑这一节就红在这里。
       * - `workspaceRegistry` 走 `safeGet`（即 `ctx.get`），换绑要经
       *   `createSession` → `#adoptSession` → `#workspaceIdFor` → `resolveByPath` / `create`。
       */
      const sessionController = {
        create: async (request) => sessions.push(request),
        prompt: async (request) => prompts.push(request),
        cancel: async () => {},
        rename: async () => {},
      }
      const ctx = {
        sessionController,
        get: (name) => {
          if (name === 'workspaceRegistry') {
            return {
              resolveByPath: async (path) => ({ id: `ws-${path}`, title: '', setTitle: async () => {} }),
              create: async (path) => ({ id: `ws-${path}`, title: '', setTitle: async () => {} }),
            }
          }
          return undefined
        },
      }
      const runtime = new QqRuntime(ctx, {
        home,
        stateFile: join(home, 'state.json'),
        workspace: join(home, 'dsh_qq'),
        credentials: {
          available: true,
          save: async () => ({}),
          load: async (appId) => ({ appId, appSecret: 'secret' }),
          remove: async () => {},
          describe: async () => ({ configured: true }),
        },
      })
      /*
       * 盘上放一条**已经过了宽限期**、而磁盘上根本不存在的绑定——
       * 那就是"会话在电脑上已经不存在了"这条故障路径的等价物。
       */
      await runtime.store.update((next) => {
        next.accounts['111'] = { userOpenid: 'peer', enabled: true, boundAt: Date.now() }
        next.bindings['111:peer'] = {
          conversationId: '111:peer',
          accountId: '111',
          peerId: 'peer',
          sessionId: STALE,
          title: 'QQ aaaabb',
          createdAt: Date.now() - r.MISSING_BINDING_GRACE_MS - 60_000,
          lastUsedAt: Date.now(),
        }
      })

      await runtime.start('111')
      // `start` 里有几件 `#fire` 出去的异步活，先让它们落定。
      await new Promise((resolve) => setTimeout(resolve, 50))
      check('前置：连接已经建立（否则这一节什么都没测）', runtime.connected, true)
      const listeners = botListeners.get('message') ?? []
      check('前置：入站消息的处理器挂上了', listeners.length, 1)

      sent.length = 0
      const messageEvent = { kind: 'c2c', senderId: 'peer', messageId: 'm-1', content: '你好' }
      for (const listener of listeners) await listener({}, messageEvent)
      await new Promise((resolve) => setTimeout(resolve, 100))

      const notice = sent.find(({ text }) => typeof text === 'string' && text.includes('在电脑上已经不存在了'))
      check('★ 运行时确实把那句话发出去了（不是只放在 decision 里）', notice !== undefined, true)
      check('★ 那句话点名了旧标题', String(notice?.text).includes('QQ aaaabb'), true)
      check('★ 那句话说明已经新建并接上', String(notice?.text).includes('我已新建'), true)

      const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))
      const rebound = state.bindings['111:peer']
      check('★ 换绑落盘了（下一条消息不会又落进那条不存在的会话）', rebound.sessionId !== STALE, true)
      check('★ 提示词交给的是**新**会话（用户刚发的内容没有丢）', prompts.length === 1 && prompts[0].sessionId === rebound.sessionId, true)
      check('★ 提交过去的正文就是用户那句话', String(prompts[0]?.content?.[0]?.text).includes('你好'), true)
      check('★ 新会话确实被交给宿主创建过（换绑不是只在本地改了个 id）', sessions.length === 1 && sessions[0].sessionId === rebound.sessionId, true)

      /*
       * 收尾：把这一节的 typing 定时器停掉。
       *
       * `#startTyping` 每 5 秒发一次 `sendTyping`（走 SDK 的 HTTP 层、即 `globalThis.fetch`），
       * 而下面的下载重试用例是**按 `fetch` 被调了几次**断言的。这里不停的话，
       * 一跳 typing 就会混进那个计数器（实测：`持续失败试满 4 次后放弃` 得到 5）。
       */
      await runtime.halt()

      /*
       * ---- 9. ⭐ 每条消息都留下一个空白会话 ----------------------------------
       *
       * 根因（微信插件已用同一份修法发布 0.44.0）：DSH 从 `0.2.0-rc.2` 到 `0.2.1-rc.2`，
       * `sessionController.create` 不再是"创建或采纳"——它**只复用还空着**的会话
       * （没有 `turn/start` 的那些），已经跑过一轮的会话不再被采纳，而是**另铸一个新 id** 返回。
       * 而本插件从前在**每条消息之前**都 create 一下"确保会话活着"、再丢掉返回值、继续用原 id
       * `prompt`：于是聊天看起来正常（`prompt` 自己会 resume），**每条消息却留下一个空白会话**。
       *
       * 这里用**真 `QqRuntime` + 一个会把记录写到磁盘的假宿主**跑完整条入站链，
       * 只数 `create` 被调了几次、`prompt` 落到了哪条会话上、工作区被解析了几遍。
       *
       * ⚠️ 假宿主的 `create` **不写**记录，记录由 `prompt` 写：真 DSH 是在**第一个回合**
       * 写下会话记录的（那正是路由里那条 2 分钟宽限期存在的原因）。不这么钉的话，
       * "第二条消息不再 create"测到的就不是守卫，而是假的存储行为。
       *
       * ⚠️ 仍然**离线**：QQBot 的连接、发送都被原型上的替身截住，没有任何网络。
       */
      {
        const si = await import('../lib/session-index.js')
        const home9 = mkdtempSync(join(tmpdir(), 'dsh-qq-blank-session-'))
        const workspace9 = join(home9, 'dsh_qq')
        const indexDir9 = join(home9, 'storages', 'session_projcache', 'sessions')
        const indexFile9 = (id) => join(indexDir9, `${id}.json`)

        const writeRecord9 = (id, cwd, title = '') => {
          mkdirSync(indexDir9, { recursive: true })
          writeFileSync(
            indexFile9(id),
            JSON.stringify({
              record: {
                identity: { cwd, createdAt: Date.now() },
                rows: title === '' ? {} : { title: { val: title } },
              },
            }),
            'utf8',
          )
        }
        /** 第一个回合才写记录：已经有记录就不覆盖（否则会把外部会话的 cwd 改掉）。 */
        const recordOnFirstTurn9 = (id, cwd) => {
          if (!existsSync(indexFile9(id))) writeRecord9(id, cwd)
        }
        /** 让一条会话在磁盘上完整存在（记录 + 会话目录）：`/switch` 要能列出它。 */
        const seedSession9 = (id, cwd, title) => {
          writeRecord9(id, cwd, title)
          mkdirSync(join(home9, 'sessions', si.encodeWorkspaceDir(cwd), id), { recursive: true })
        }

        const newBag9 = () => ({ created: [], prompted: [], workspace: [] })
        const credentials9 = {
          available: true,
          save: async () => ({}),
          load: async (appId) => ({ appId, appSecret: 'secret' }),
          remove: async () => {},
          describe: async () => ({ configured: true }),
        }
        const uniqueSessions9 = (bag) =>
          JSON.stringify([...new Set(bag.prompted.map((request) => request.sessionId))])
        const bindingOnDisk9 = () =>
          JSON.parse(readFileSync(join(home9, 'state.json'), 'utf8')).bindings['111:peer']

        /**
         * 挂载一台真运行时（同一个 home 再挂一次 = 宿主重启）。
         *
         * 每次都用新的 `bag` 记账，这样"重启后 create 次数为 0"是**这一次挂载**的事实。
         */
        const mount9 = async (bag) => {
          botListeners.clear()
          const knownCwd = new Map()
          const controller9 = {
            create: async (request) => {
              bag.created.push(request)
              knownCwd.set(request.sessionId, workspace9)
            },
            prompt: async (request) => {
              bag.prompted.push(request)
              recordOnFirstTurn9(request.sessionId, knownCwd.get(request.sessionId) ?? workspace9)
            },
            cancel: async () => {},
            rename: async () => {},
          }
          const registry9 = {
            resolveByPath: async (path) => {
              bag.workspace.push(['resolveByPath', path])
              return { id: `ws-${path}`, title: '', setTitle: async () => {} }
            },
            create: async (path) => {
              bag.workspace.push(['create', path])
              return { id: `ws-${path}`, title: '', setTitle: async () => {} }
            },
          }
          const runtime9 = new QqRuntime(
            {
              sessionController: controller9,
              get: (name) => (name === 'workspaceRegistry' ? registry9 : undefined),
            },
            {
              home: home9,
              stateFile: join(home9, 'state.json'),
              workspace: workspace9,
              credentials: credentials9,
            },
          )
          await runtime9.store.update((next) => {
            next.accounts['111'] = { userOpenid: 'peer', enabled: true, boundAt: Date.now() }
          })
          await runtime9.start('111')
          await new Promise((resolve) => setTimeout(resolve, 50))
          const listeners = botListeners.get('message') ?? []
          return {
            runtime: runtime9,
            send: async (messageId, text) => {
              for (const listener of listeners) {
                await listener({}, { kind: 'c2c', senderId: 'peer', messageId, content: text })
              }
              await new Promise((resolve) => setTimeout(resolve, 60))
            },
          }
        }

        try {
          // ---- A. 两条消息只 create 一次，两条 prompt 指向同一条会话 ----------
          const bagA = newBag9()
          const mountA = await mount9(bagA)
          await mountA.send('m-1', '你好')
          const firstSession = bagA.prompted.at(-1)?.sessionId
          await mountA.send('m-2', '再说一句')
          check('★ 两条消息只 create 一次（第二条不再为"确保会话活着"去 create）', bagA.created.length, 1)
          check('★ 被 create 的就是被 prompt 的那条会话', bagA.created[0]?.sessionId, firstSession)
          check('★ 两条消息都落在同一条会话上（消息没有分叉）', uniqueSessions9(bagA), JSON.stringify([firstSession]))
          check(
            '★ 工作区只解析一次（不是每条消息重新解析一遍）',
            JSON.stringify(bagA.workspace),
            JSON.stringify([['resolveByPath', workspace9]]),
          )
          check(
            '★ create 时指名的是工作区 id（会话归进文件夹，不是「未分组」）',
            bagA.created[0]?.workspaceId,
            `ws-${workspace9}`,
          )
          check('★ 落盘的绑定指着那条唯一的会话（没有另绑一条空白会话）', bindingOnDisk9()?.sessionId, firstSession)
          await mountA.runtime.halt()

          // ---- B. 重启后不 create：读回绑定后直接 prompt 原会话 ---------------
          const bagB = newBag9()
          const mountB = await mount9(bagB)
          await mountB.send('m-3', '重启之后还在吗')
          check('★ 重启后读回绑定直接 prompt，create 次数为 0', bagB.created.length, 0)
          check('★ 重启后提示词仍然落在重启前那条会话上', uniqueSessions9(bagB), JSON.stringify([firstSession]))
          check(
            '★ 重启后不为既有会话重新解析工作区（工作区不会漂移）',
            JSON.stringify(bagB.workspace),
            '[]',
          )
          check('★ 重启后绑定没有被换掉', bindingOnDisk9()?.sessionId, firstSession)
          await mountB.runtime.halt()

          // ---- C. 记录被删 → 仍按原 id 重建，只 create 一次，此后不再 create ---
          rmSync(indexFile9(firstSession), { force: true })
          rmSync(join(home9, 'sessions', si.encodeWorkspaceDir(workspace9), firstSession), {
            recursive: true,
            force: true,
          })
          const bagC = newBag9()
          const mountC = await mount9(bagC)
          await mountC.send('m-4', '记录没了以后')
          check('★ 没有记录的会话仍会重建（旧 id 没有记录，才走 create）', bagC.created.length, 1)
          check('★ 重建用的是同一个 id（不会改名，也不会多出一条空白会话）', bagC.created[0]?.sessionId, firstSession)
          await mountC.send('m-5', '再来一条')
          await mountC.send('m-6', '还有一条')
          check('★ 重建之后不再 create（记录又有了，守卫生效）', bagC.created.length, 1)
          check('★ 三条 prompt 全部落在同一个会话上', uniqueSessions9(bagC), JSON.stringify([firstSession]))
          check(
            '★ 重建那一刻只解析一次工作区',
            JSON.stringify(bagC.workspace),
            JSON.stringify([['resolveByPath', workspace9]]),
          )
          await mountC.runtime.halt()

          // ---- D. 切到外部会话：既有会话从不交给 create ----------------------
          const EXTERNAL = 'session-abcdef12-abcdef12-3456-7890'
          seedSession9(EXTERNAL, join(home9, '外部项目'), '外部会话')
          const bagD = newBag9()
          const mountD = await mount9(bagD)
          await mountD.send('m-7', '/switch 外部会话')
          check('★ /switch 到既有会话不 create（既有会话从不交给 create）', bagD.created.length, 0)
          check(
            '★ /switch 确实切过去了（回话点名了那条会话）',
            sent.some(({ text }) => String(text).includes('已切换到「外部会话」')),
            true,
          )
          await mountD.send('m-8', '外部会话里说一句')
          check('★ 切过去之后发消息也不 create', bagD.created.length, 0)
          check('★ 提示词落在外部会话上', uniqueSessions9(bagD), JSON.stringify([EXTERNAL]))
          check('★ 落盘的绑定指着外部会话', bindingOnDisk9()?.sessionId, EXTERNAL)
          check(
            '★ 没有为外部会话解析本频道的工作区（那条分支已经没有理由存在）',
            JSON.stringify(bagD.workspace),
            '[]',
          )
          await mountD.runtime.halt()
        } finally {
          rmSync(home9, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
        }
      }

    } finally {
      QQBot.prototype.start = realStart
      QQBot.prototype.sendText = realSendText
      QQBot.prototype.on = realOn
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  }
}

// ---- 审批与提问的文本解析（"否定优先"是最易写错的一条）--------------------
{
  const ia = await import('../lib/interactions.js')

  check('允许', ia.parseApprovalReply('允许'), 'allowed-once')
  check('拒绝', ia.parseApprovalReply('拒绝'), 'rejected')
  check('★「不允许」判为拒绝（含「允许」子串）', ia.parseApprovalReply('不允许'), 'rejected')
  check('★「不可以」判为拒绝（含「可以」子串）', ia.parseApprovalReply('不可以'), 'rejected')
  check('可以 → 允许', ia.parseApprovalReply('可以'), 'allowed-once')
  check('yes/ok/allow', [ia.parseApprovalReply('yes'), ia.parseApprovalReply('ok'), ia.parseApprovalReply('allow')].join(','), 'allowed-once,allowed-once,allowed-once')
  check('no/n/deny', [ia.parseApprovalReply('no'), ia.parseApprovalReply('n'), ia.parseApprovalReply('deny')].join(','), 'rejected,rejected,rejected')
  check('大小写不敏感', ia.parseApprovalReply('YES'), 'allowed-once')
  check('★ 看不懂返回 undefined（不猜）', ia.parseApprovalReply('今天天气不错'), undefined)
  check('空串 undefined', ia.parseApprovalReply('   '), undefined)

  const approval = ia.presentApproval({ toolName: 'exec', displayReason: 'rm -rf build' })
  check('权限提示含工具名', approval.body.includes('exec'), true)
  check('权限提示含理由', approval.body.includes('rm -rf build'), true)
  check('权限提示给出回复方式', approval.body.includes('回复 允许 或 拒绝'), true)

  const qs = [{ id: 'q1', question: '选哪个方案？', options: [{ label: '方案A' }, { label: '方案B', description: '更快' }] }]
  const presented = ia.presentQuestions(qs)
  check('提问渲染编号选项', presented.body.includes('1. 方案A') && presented.body.includes('2. 方案B'), true)
  check('提问渲染选项描述', presented.body.includes('— 更快'), true)
  check('单选提示', presented.body.includes('回复编号，或直接回复你的答案'), true)

  const multi = ia.presentQuestions([{ id: 'q1', question: '多选', options: [{ label: 'A' }, { label: 'B' }], multiSelect: true }])
  check('多选提示可多个', multi.body.includes('可多个，如 1,3'), true)

  const numeric = ia.parseQuestionReply(qs, '2')
  check('★ 数字回复选中对应选项', JSON.stringify(numeric.answers[0].selected), JSON.stringify(['方案B']))
  check('标签回复也能认', JSON.stringify(ia.parseQuestionReply(qs, '方案A').answers[0].selected), JSON.stringify(['方案A']))
  const freeform = ia.parseQuestionReply(qs, '都不太满意，说说你的想法')
  check('★ 自由文本走 custom，不被拒绝', JSON.stringify(freeform.answers[0].custom), JSON.stringify('都不太满意，说说你的想法'))
  const twoOptions = [{ id: 'q1', question: 'x', options: [{ label: 'A' }, { label: 'B' }] }]
  const threeMulti = [{ id: 'q1', question: 'x', options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }], multiSelect: true }]
  check('★ 全角逗号多选', JSON.stringify(ia.parseQuestionReply(threeMulti, '1，3').answers[0].selected), JSON.stringify(['A', 'C']))
  check('空格分隔多选', JSON.stringify(ia.parseQuestionReply(twoOptions.map((q) => ({ ...q, multiSelect: true })), '1 2').answers[0].selected), JSON.stringify(['A', 'B']))
  check('★ 越界数字不当成选择', JSON.stringify(ia.parseQuestionReply(twoOptions, '5').answers[0]), JSON.stringify({ id: 'q1', selected: [], custom: '5' }))
  check('无选项时整条作为 custom', JSON.stringify(ia.parseQuestionReply([{ id: 'q1', question: '叫什么名字？' }], '鲸鱼娘').answers[0]), JSON.stringify({ id: 'q1', selected: [], custom: '鲸鱼娘' }))
  check('单选只取第一个', JSON.stringify(ia.parseQuestionReply(twoOptions, '1 2').answers[0].selected), JSON.stringify(['A']))
}

// ---- session_control 工具（自然语言会话控制）------------------------------
{
  const st = await import('../lib/session-tool.js')
  const rt = await import('../lib/router.js')

  const def = st.sessionToolDefinition({
    requireConfirmation: true,
    control: async () => ({ ok: true, detail: 'x', sessions: [], otherWorkspaces: 0, otherNames: [] }),
    log: () => {},
  })
  check('★ 工具名带 qq_ 前缀（避免与微信的 session_control 重名）', def.name, 'qq_session_control')
  check('action 枚举完整', JSON.stringify(def.parameters.properties.action.enum), JSON.stringify(['list', 'switch', 'new', 'current', 'cancel', 'model']))
  check('action 必填', JSON.stringify(def.parameters.required), JSON.stringify(['action']))
  check('output 声明 detail/ok', JSON.stringify(def.output.schema.required), JSON.stringify(['detail', 'ok']))
  check('output.schema 含 otherWorkspaces', def.output.schema.properties.otherWorkspaces.type, 'number')
  check('render 返回数组', Array.isArray(def.output.render({ action: 'list' })), true)
  check('★ 确认策略在描述里（开）', def.description.includes('IMPORTANT'), true)
  const off = st.sessionToolDescription(false)
  check('★ 确认策略在描述里（关）', !off.includes('IMPORTANT') && off.includes('confirmation off'), true)
  check('描述要求不要复述结果', def.description.includes('do not repeat that outcome'), true)
  // 模型：列清单与切换同用一个 action，靠有没有 target 区分；只读的那半边不必先确认。
  check('★ target 描述说明 model 可以省略（省略=列出）', def.parameters.properties.target.description.includes('omit it to list the models'), true)
  check('★ 只读的模型列表被列进"不必先确认"的例外', def.description.includes('action "model" with'), true)
  check('★ 描述说明切换对下一步生效、不是对正在跑的那一步', def.description.includes('applies from the next step'), true)
  // 推理等级：与 `/model 等级` 同一件事，所以走同一个 action，只多一个参数。
  check('★ 工具多了 level 参数', def.parameters.properties.level.type, 'string')
  check('★ level 描述说明要与清单印的名字一致', def.parameters.properties.level.description.includes('as the model list prints it'), true)
  check('★ level 描述说明"有 target 就一起改、没有就只改等级"', def.parameters.properties.level.description.includes('the model and the level change together'), true)
  check('★ 描述里说清了模型清单带推理等级', def.description.includes('Each model is listed with its reasoning levels'), true)
  check('level 不是必填', JSON.stringify(def.parameters.required), JSON.stringify(['action']))
  // 清单分两层：agent 必须说得出它刚展示的是"本工作区的会话"还是"工作区本身"。
  check('★ 描述说明清单分两层（list 是会话，all 是会话夹）', def.description.includes('The list has two levels'), true)
  check('★ 描述说明两层都每屏十条、编号跨屏连续', def.description.includes('numbering that runs on across pages'), true)

  check('新建确认文案（有标题）', st.switchConfirmation('new', '测试会话'), '已新建对话「测试会话」，从现在起你的消息发到这里。')
  check('新建确认文案（无标题）', st.switchConfirmation('new', ''), '已新建对话，从现在起你的消息发到这里。')
  check('切换确认文案', st.switchConfirmation('switch', '周报'), '已切换到「周报」。')
  const failure = st.switchFailure('switch', '3', '找不到这个对话。\n第二行')
  check('★ 失败文案只取原因第一行', failure.split('\n')[0], '切换到「3」没有成功。找不到这个对话。')
  check('失败文案给出下一步', failure.includes('/list'), true)
  check('workspaceLabel 取末段', st.workspaceLabel('C:\\Users\\me\\.dsh\\dsh_qq'), 'dsh_qq')
  check('workspaceLabel 处理正斜杠', st.workspaceLabel('/home/me/work'), 'work')

  // ★ 一致性断言：工具版渲染与 router 版渲染必须逐字相同。
  // 时间与短 id 那两段是两份手抄的实现（标题不抄：工具直接用 router 的 `truncateTitle`），
  // 所以必须靠断言钉住。下面的样本里带着**会分叉的那几种标题**：
  // 只比短标题的话，"工具只 trim、router 还压空白并裁到 24 字"这一处差别一直看不出来。
  const longSampleTitle = '这是一句很长的标题'.repeat(4)
  const sample = [
    { sessionId: 'session-aaaaaaaa-1111', title: '修复登录', updatedAt: 1791628347908 },
    { sessionId: 'session-bbbbbbbb-2222', title: '', updatedAt: 1791628347908 },
    { sessionId: 'session-cccccccc-3333', title: longSampleTitle, updatedAt: 1791628347908 },
    { sessionId: 'session-dddddddd-4444', title: '第一行\n第二行', updatedAt: 1791628347908 },
    { sessionId: 'session-eeeeeeee-5555', title: '甲\t\t乙   丙', updatedAt: 1791628347908 },
  ]
  // 时间显式注入，免得两条断言跨过一分钟边界时看到两个"x 分钟前"。
  const NOW = 1_791_628_400_000
  const viaRouter = sample.map((s, i) => rt.renderSessionRow(s, i, 'session-aaaaaaaa-1111', NOW)).join('\n')
  const viaTool = st.renderTable(sample, 'session-aaaaaaaa-1111', NOW)
  check('★ 工具渲染与 /list 渲染逐字一致', viaTool, viaRouter)
  check('空标题渲染为 (无标题)', viaTool.includes('(无标题)'), true)
  check('当前会话被标出', viaTool.includes('← 当前'), true)
  check('★ 一行一条会话（十条要装进一条消息；标题里的换行不许多占一行）', viaTool.split('\n').length, 5)
  check('★ 每一行都以短 id 收尾', viaTool.split('\n').every((line) => /\s[0-9a-f]{6}$/.test(line)), true)
  // 编号取行自己带的那个：会话清单分两层、每屏十条，第二屏从 11 起。
  const offsetRows = sample.map((s, i) => ({ ...s, index: 11 + i }))
  const viaToolOffset = st.renderTable(offsetRows, '', NOW)
  check('★ 工具用的就是用户看到的编号（第二屏从 11 起）', viaToolOffset.startsWith('11. 修复登录') && viaToolOffset.includes('\n12. '), true)
  const viaRouterOffset = offsetRows.map((s, i) => rt.renderSessionRow(s, 10 + i, '', NOW)).join('\n')
  check('★ 带偏移时两者仍然逐字一致', viaToolOffset, viaRouterOffset)
  check('★ 工具版与 router 版的短 id 规则一致（都是 6 位）', [viaTool.includes('aaaaaa'), rt.shortId('session-aaaaaaaa-1111')].join(','), 'true,aaaaaa')
}

// ---- 出站文件与主动推送两个工具 --------------------------------------------
{
  const st = await import('../lib/send-tools.js')

  check('图片扩展名走图片通道', st.mediaKindFor('C:\\a\\b.png'), 'image')
  check('jpg 也走图片通道', st.mediaKindFor('/tmp/x.JPG'), 'image')
  check('视频扩展名走视频通道', st.mediaKindFor('/tmp/x.mp4'), 'video')
  check('其它走文件通道', st.mediaKindFor('/tmp/report.pdf'), 'file')
  check('无扩展名走文件通道', st.mediaKindFor('/tmp/noext'), 'file')
  check('目录名里的点不误判', st.mediaKindFor('/a.b/report'), 'file')

  const sendDef = st.sendToQqToolDefinition({ deliver: async () => 'ok', log: () => {} })
  check('send_to_qq 名字', sendDef.name, 'send_to_qq')
  check('send_to_qq 只要求 path', JSON.stringify(sendDef.parameters.required), JSON.stringify(['path']))
  check('send_to_qq 说明绝对路径', sendDef.description.includes('must be absolute'), true)
  check('send_to_qq output 契约', JSON.stringify(sendDef.output.schema.required), JSON.stringify(['detail']))

  const notifyDef = st.notifyQqToolDefinition({ deliver: async () => 'ok', log: () => {} })
  check('notify_qq 名字', notifyDef.name, 'notify_qq')
  check('notify_qq 只要求 text', JSON.stringify(notifyDef.parameters.required), JSON.stringify(['text']))
  check('★ notify_qq 不接受目标参数（agent 无法瞄错）', Object.keys(notifyDef.parameters.properties).join(','), 'text,path')
  check('notify_qq 说明任意会话可用', notifyDef.description.includes('works from any session'), true)
  check('notify_qq 说明无法选择别的对话', notifyDef.description.includes('no way to choose another'), true)
  check('notify_qq output 契约', JSON.stringify(notifyDef.output.schema.required), JSON.stringify(['detail']))

  // 执行路径：deliver 抛错时工具必须把错误传出去（而不是静默返回空 detail）
  const failing = st.sendToQqToolDefinition({
    deliver: async () => {
      throw new Error('路径必须是绝对路径：x')
    },
    log: () => {},
  })
  let threw = false
  try {
    await failing.execute({ path: 'x' }, {})
  } catch {
    threw = true
  }
  check('★ deliver 抛错时工具也抛（不静默）', threw, true)
}

// ---- 提示词合成：agent 到底看到了什么 --------------------------------------
{
  const p = await import('../lib/prompt.js')

  check('纯文本', p.composePrompt({ content: '你好' }), '你好')
  check('空白内容 → 空串', p.composePrompt({ content: '   ' }), '')
  check('缺内容不抛', p.composePrompt({}), '')

  // 语音：服务端转写优先，不做 SILK 解码
  const voice = p.composePrompt({
    content: '',
    attachments: [{ content_type: 'voice', url: 'https://x/v', asr_refer_text: '今天天气怎么样' }],
  })
  check('★ 语音用服务端转写', voice, '[语音转写] 今天天气怎么样')

  // 普通附件
  const file = p.composePrompt({
    content: '看看这个',
    attachments: [{ content_type: 'file', filename: '报告.pdf', url: 'https://x/f' }],
  })
  check('附件带名称与链接', file, '看看这个\n[附件 报告.pdf] https://x/f')
  check('无文件名的附件有兜底标签', p.composePrompt({ attachments: [{ content_type: 'image/png', url: 'u' }] }), '[附件 image/png] u')

  // 引用：QQ 白送正文
  const quoted = p.composePrompt({
    content: '这句是什么意思',
    refMsgIdx: 'REFIDX_A',
    msgElements: [
      { msg_idx: 'REFIDX_OTHER', content: '无关的另一条' },
      { msg_idx: 'REFIDX_A', content: '被引用的原文' },
    ],
  })
  check('★ 引用正文被注入且在正文之前', quoted, '[引用] 被引用的原文\n这句是什么意思')
  check('★ 逐项核对，不误取第一条', quoted.includes('无关的另一条'), false)

  // 引用了纯媒体：说类型，别静默
  const quotedMedia = p.composePrompt({
    content: '这张图',
    refMsgIdx: 'R1',
    msgElements: [{ msg_idx: 'R1', attachments: [{ content_type: 'image/png' }] }],
  })
  check('引用纯媒体时说明类型', quotedMedia, '[引用] （引用了image/png）\n这张图')

  // 没有 refMsgIdx / 匹配不上 → 不产生空壳引用
  check('无 refMsgIdx 不产生引用', p.composePrompt({ content: 'hi', msgElements: [{ msg_idx: 'R', content: 'x' }] }), 'hi')
  check('★ refMsgIdx 匹配不上时不产生引用', p.composePrompt({ content: 'hi', refMsgIdx: 'R9', msgElements: [{ msg_idx: 'R1', content: 'x' }] }), 'hi')
  check('元素无正文且无附件 → 不产生引用', p.composePrompt({ content: 'hi', refMsgIdx: 'R1', msgElements: [{ msg_idx: 'R1' }] }), 'hi')

  check('quotedText 直接调用', p.quotedText({ refMsgIdx: 'R1', msgElements: [{ msg_idx: 'R1', content: '原文' }] }), '原文')
  check('quotedText 无输入时 undefined', p.quotedText({}), undefined)

  /*
   * ★ 引用与正文拆开：没有这一步，"引用一屏清单再回 /switch 3"合成的文本以 `[引用]` 开头，
   * 路由不认它是指令，整条会落进 agent —— 引用冻结编号这套设计就永远用不上。
   */
  const listText = '【QQ 会话】会话（1/2）\n1. 写周报  e716f0'
  const split = p.splitRouteText({
    content: '/switch 3',
    refMsgIdx: 'R1',
    msgElements: [{ msg_idx: 'R1', content: listText }],
  })
  check('★ 拆出来的正文就是那条指令', split.text, '/switch 3')
  check('★ 引用正文单独交给路由（它靠它认那一屏）', split.quoted, listText)
  check('★ 交给 agent 的合成文本仍然是"引用在前"的原样', split.composed, `[引用] ${listText}\n/switch 3`)
  check('★ 于是"以 / 开头才是指令"这条判定不再被引用破坏', split.text.startsWith('/'), true)
  // 只引用、没写正文：正文是空串，但整条消息不能因此丢掉
  const quotedOnly = p.splitRouteText({ refMsgIdx: 'R1', msgElements: [{ msg_idx: 'R1', content: '被引的原文' }] })
  check('★ 只引用不写正文时正文是空串', quotedOnly.text, '')
  check('★ 但合成文本仍然是那句引用（消息不该消失）', quotedOnly.composed, '[引用] 被引的原文')
  // 没有引用时两者完全一致（旧行为一个字不变）
  const plain = p.splitRouteText({ content: '你好' })
  check('没有引用时拆与不拆同形', JSON.stringify([plain.text, plain.composed, 'quoted' in plain]), JSON.stringify(['你好', '你好', false]))
}

// ---- 会话命名：首条消息只提交一条，标题由创建时显式给出 --------------------
/*
 * 用户报的 bug：新建或切换会话之后的**第一条**消息，agent 收到的是两条先后独立的
 * 用户消息——先「你好」，再整段 `presenceNote`。
 *
 * 成因是"命名那条"（会话的第一条）被**故意**拆成两条提交，为的是不让渠道说明
 * 混进 DSH 从首条消息猜出来的会话标题。所以修复要两件事一起做，这里也两件一起钉：
 *
 * 1. 那一条**只提交一次**，且用户的话与说明在同一条里（用户的话在前）；
 * 2. 标题改为**创建会话时显式交给宿主**，由用户自己的话推导、**不含渠道说明**。
 *
 * ⚠️ 这一节证明的是"提交几次、文本长什么样、给宿主的是什么标题"。
 * 它**不能**证明桌面端把标题显示成什么样——那要有真机与运行中的 DSH。
 */
{
  const p = await import('../lib/prompt.js')
  const r = await import('../lib/router.js')
  const { SETTINGS_DEFAULTS } = await import('../lib/settings.js')

  /** 真实的渠道说明（默认值），不是编的——污染与否取决于它真实的样子。 */
  const NOTE = SETTINGS_DEFAULTS.presenceNote.trim()
  const ATTACH = '[图片] C:\\me\\qq\\a.png (2.0 KB)'

  // ---- 一、交付文本：一条，用户的话在前、说明在最后 ----
  {
    const parts = p.composeDelivery({ promptText: '你好', attachmentLines: [ATTACH], note: NOTE })
    check('★ 会话第一条只提交一次（不是两条）', parts.length, 1)
    check(
      '★ 那一条里同时有用户的话与渠道说明',
      JSON.stringify([parts[0].includes('你好'), parts[0].includes(NOTE)]),
      JSON.stringify([true, true]),
    )
    check('★ 用户的话在最前、渠道说明在最尾', JSON.stringify([parts[0].indexOf('你好') === 0, parts[0].endsWith(NOTE)]), JSON.stringify([true, true]))
    check('★ 附件描述排在两者之间', parts[0], `你好\n\n${ATTACH}\n\n${NOTE}`)
    // 说明为空时不留空行（旧行为一个字不变）
    check('说明为空串时不留下空段', p.composeDelivery({ promptText: '你好', note: '' })[0], '你好')
    check('什么都没有时不出元素', p.composeDelivery({ promptText: '' }).length, 0)

    /*
     * 反向对照：**旧形状**是每条元素各自被提交一次，而命名那条有两个元素
     * （`[用户的话, 渠道说明]`）。下面照旧形状摆一遍，证明"两条"与"一条"在
     * 内容上就是两回事：旧形状的第一条里**没有**说明，说明是独立第二条。
     * 所以任何让 `composeDelivery` 回到两个元素的改动，都会同时打掉上面两条断言。
     */
    const oldShape = ['你好', NOTE]
    check('反向对照：旧形状的第一条里没有渠道说明', oldShape[0].includes(NOTE), false)
    check('反向对照：旧形状的说明是独立第二条', oldShape.length === 1, false)
  }

  // ---- 二、标题推导：语义与宿主那条回退一致，且不含渠道说明 ----
  {
    check('★ 就是用户自己的话', r.deriveSessionTitle('你好'), '你好')
    check('★ 空白折叠成一个空格并 trim', r.deriveSessionTitle('  你好\n\n  世界 \t 嗯 '), '你好 世界 嗯')

    // 词数上限 5（与宿主 `fallbackMaxWords` 同值）
    const eightWords = 'a b c d e f g h'
    check('★ 词数上限 5（出处 cordis.patch.yml:58）', r.deriveSessionTitle(eightWords), 'a b c d e')
    check('反向对照：输入确实有 8 个词（否则上面那条没有鉴别力）', eightWords.split(' ').length, 8)

    // 字节上限 40（与宿主 `fallbackMaxBytes` 同值）
    const long = '一'.repeat(20)
    check('★ 字节上限 40（出处 cordis.patch.yml:59）', Buffer.byteLength(r.deriveSessionTitle(long), 'utf8'), 39)
    check('反向对照：输入确实是 60 字节（真的被截短了）', Buffer.byteLength(long, 'utf8'), 60)

    // 按码点截断：逐 UTF-16 码元截会把 emoji 劈成两半
    const emoji = '😀'.repeat(11)
    const cut = r.deriveSessionTitle(emoji)
    check('★ 截断不切开码点（11 个 emoji 截成 10 个 = 40 字节）', JSON.stringify([Buffer.byteLength(cut, 'utf8'), [...cut].length]), JSON.stringify([40, 10]))

    // 没有可见字符 → 空串（调用方据此**不传**标题，见 `#bind`）
    check('★ 全空白推不出标题', r.deriveSessionTitle('   \n\t '), '')
    check('非字符串不抛', r.deriveSessionTitle(undefined), '')

    /*
     * ★ 标题不被污染，而且这条断言**有鉴别力**。
     *
     * 上面那条只是"没有看到渠道说明"，而这句话在标题恰好很短时也成立。
     * 所以紧接着把同一段渠道说明**真的喂进去**：标题立刻被污染。
     * 这两条一起才说明"不含渠道说明"是被检查到了，而不是恰好没撞上——
     * 也说明 `#bind` 必须收到**用户自己的话**，而不是拼好的提示词。
     */
    const polluted = r.deriveSessionTitle(`你好\n\n${NOTE}`)
    check('★ 由用户的话推出的标题不含渠道说明', r.deriveSessionTitle('你好').includes('渠道'), false)
    check('反向对照：把渠道说明也当输入，标题立刻被污染', polluted.includes('渠道'), true)
    check('反向对照：被污染的标题就是修复前会落到桌面上的那个', polluted.startsWith('你好'), true)
  }

  // ---- 三、路由：创建时给标题；已有会话不改名；`/new <标题>` 照旧 ----
  {
    const CONV = { conversationId: '111:peer', accountId: '111', peerId: 'peer' }
    /** 创建时收到的标题（**只有创建这条路会走到它**）。 */
    const created = []
    /** 采纳时收到的参数（用来证明"采纳不带标题"）。 */
    const ensured = []
    const bindings = {}
    const router = new r.SessionRouter({
      gateway: {
        createSession: async (sessionId, title) => {
          created.push({ sessionId, title })
        },
        ensureSession: async (sessionId, title) => {
          ensured.push({ sessionId, title })
        },
        prompt: async () => {},
        cancel: async () => {},
        listSessions: async () => [],
        listOwnSessions: async () => [],
        listModels: async () => [],
        currentModel: async () => undefined,
        selectModel: async () => {
          throw new Error('这一节不测模型')
        },
      },
      store: {
        load: async () => bindings,
        save: async () => {},
      },
      titlePrefix: 'QQ',
      ownWorkspace: 'C:\\me\\dsh_qq',
      ownWorkspaceLabel: 'QQ 会话',
    })

    const first = await router.route({ ...CONV, text: '你好' })
    check('第一条普通消息创建了会话', first.kind, 'prompt')
    check('★ 创建会话时传了标题（而不是 undefined）', typeof created[0]?.title === 'string' && created[0].title !== '', true)
    check('★ 传的就是由用户的话推导出来的那个标题', created[0]?.title, r.deriveSessionTitle('你好'))
    check('★ 标题里没有渠道说明', (created[0]?.title ?? '').includes('渠道'), false)
    check('★ 创建只发生一次', created.length, 1)

    /*
     * ★ 已有会话的后续消息**不改名**。
     *
     * 直接判据是"给标题的那条路没有再被走到"，而不是"标题看起来没变"——
     * 后者在标题恰好相同时也成立。上面那条 `created.length === 1` 就是它的对照：
     * 计数器确实会动（创建那一步让它从 0 变成 1），所以"没动"是有意义的。
     */
    await router.route({ ...CONV, text: '第二条' })
    await router.route({ ...CONV, text: '第三条' })
    check('★ 后续消息不再给标题（已有会话不被改名）', created.length, 1)
    check('★ 后续消息走的是"确保会话还活着"那条路', ensured.length, 2)
    check('★ 那条路不带标题（采纳永不改名）', ensured[0]?.title, undefined)
    check('反向对照：创建那一步确实让计数器动过', created.length >= 1, true)

    // `/new <标题>`：显式标题照旧生效，且它就是交给宿主的会话标题
    const made = await router.route({ ...CONV, text: '/new 写周报' })
    check('★ /new <标题> 的显式标题照旧生效', created.at(-1)?.title, '写周报')
    check('★ 绑定标签也是那个标题', (await router.current(CONV.conversationId))?.title, '写周报')
    check('★ 确认文案印的也是它', made.text.includes('已新建对话「写周报」'), true)
    check('★ 显式标题没有被"由原话推导"覆盖（原话是 /new 写周报）', created.at(-1)?.title === r.deriveSessionTitle('/new 写周报'), false)

    // `/new` 不带参数：没有可命名的东西 → **不传空串**，让宿主自己从首条消息取
    await router.route({ ...CONV, text: '/new' })
    check('★ /new 不带参数时不传空标题（传 undefined）', created.at(-1)?.title, undefined)
    check('★ 但绑定标签仍有兜底（前缀 + 短 id）', (await router.current(CONV.conversationId))?.title.startsWith('QQ '), true)

    // 只有附件、没有文字：同样没有可命名的用户措辞
    await router.route({ conversationId: '111:pic', accountId: '111', peerId: 'pic', text: '' })
    check('★ 没有文字时也不传空标题（undefined，不是空串）', created.at(-1)?.title, undefined)
  }
}

// ---- 设置页后端：快照、施加、以及工具重注册 --------------------------------
// `requireConfirmation` 只存在于 session_control 的**描述**里，而注册表按值取走描述，
// 所以改它必须重新注册工具。这条路径没有别的测试能覆盖。
{
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { QqRuntime } = await import('../lib/runtime.js')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-settings-'))
  try {
    const registered = []
    const services = {
      // 只提供工具服务与权限预设目录；其余服务缺失应当被容忍（本插件只降级，不失败）。
      tools: {
        register: (definition) => {
          registered.push(definition)
          return () => {
            const at = registered.indexOf(definition)
            if (at >= 0) registered.splice(at, 1)
          }
        },
      },
      permissionPresets: { names: ['workspace-write', 'danger-full-access', 'auto'] },
    }
    const ctx = { get: (name) => services[name] }
    const credentials = {
      available: false,
      save: async () => ({}),
      load: async () => undefined,
      remove: async () => {},
      describe: async () => ({ configured: false }),
    }
    const runtime = new QqRuntime(ctx, {
      home: dir,
      stateFile: join(dir, 'state.json'),
      workspace: join(dir, 'dsh_qq'),
      credentials,
    })

    const initial = runtime.settingsSnapshot()
    check('默认 permissionPreset 与微信一致', initial.permissionPreset, 'danger-full-access')
    check('默认 requireConfirmation 与微信一致', initial.requireConfirmation, true)
    check('默认 allowCrossSessionNotify 与微信一致', initial.allowCrossSessionNotify, true)
    check('★ settleMs 默认与微信一致（1200）', initial.settleMs, 1200)
    check('快照同时给出默认值', initial.settleMsDefault, 1200)

    const names = runtime.permissionPresetsInfo().available
    check('★ 预设目录来自服务而不是硬编码', JSON.stringify(names), JSON.stringify(['workspace-write', 'danger-full-access', 'auto']))
    check('哨兵值标注为 default', runtime.permissionPresetsInfo().sentinel, 'default')

    // 注册三个工具
    runtime.registerTools()
    const toolNames = registered.map((d) => d.name).sort()
    check('★ 注册了三个工具', JSON.stringify(toolNames), JSON.stringify(['notify_qq', 'qq_session_control', 'send_to_qq']))
    const control = registered.find((d) => d.name === 'qq_session_control')
    check('初始描述含确认条款', control.description.includes('IMPORTANT'), true)

    // 关掉确认 → 必须重新注册，且新描述不含确认条款
    runtime.applySettings({ requireConfirmation: false })
    const after = registered.find((d) => d.name === 'qq_session_control')
    check('★ 关掉确认后工具被重新注册', after !== control, true)
    check('★ 新描述不再含确认条款', after.description.includes('IMPORTANT'), false)
    check('重新注册后仍是三个工具（旧的已注销）', registered.length, 3)

    // 其余设置不应触发重注册
    const before = registered.find((d) => d.name === 'qq_session_control')
    runtime.applySettings({ allowCrossSessionNotify: false, settleMs: 500 })
    check('★ 无关设置不触发重注册', registered.find((d) => d.name === 'qq_session_control') === before, true)
    check('settleMs 已更新', runtime.settingsSnapshot().settleMs, 500)
    check('allowCrossSessionNotify 已更新', runtime.settingsSnapshot().allowCrossSessionNotify, false)

    // 切换预设
    runtime.applySettings({ permissionPreset: 'auto' })
    check('预设已切换', runtime.settingsSnapshot().permissionPreset, 'auto')

    // ★ 设置页形状：微信客户端解构的是 `.settings` 与 `.defaults`，两个对象同键
    const page = runtime.settingsForPage()
    check('★ settingsForPage 返回 settings/defaults 两层', JSON.stringify(Object.keys(page).sort()), JSON.stringify(['defaults', 'settings']))
    const pageKeys = Object.keys(page.settings).sort()
    check('★ 两层键集合一致', JSON.stringify(Object.keys(page.defaults).sort()), JSON.stringify(pageKeys))
    // ⚠️ 这里**故意写死九项名字**，不从 schema 派生。
    // 派生的话就成了自己跟自己比（schema 少一项它也跟着少，永远相等），
    // 而这条断言的用途恰恰是：把设置页对客户端承诺的字段集钉住。
    // "schema 与运行时实际持有的字段集一致"由下面那段 schema 驱动的测试负责，两条各司其职。
    check('★ 设置项就是这九项', JSON.stringify(pageKeys), JSON.stringify(['allowCrossSessionNotify', 'autoReplyAttachments', 'maxReplyChars', 'mergeWindowMs', 'permissionPreset', 'presenceNote', 'requireConfirmation', 'settleMs', 'workspacePath']))
    const defaults = page.defaults
    check('默认预设与微信一致', defaults.permissionPreset, 'danger-full-access')
    check('默认确认策略与微信一致', defaults.requireConfirmation, true)
    check('默认跨会话推送与微信一致', defaults.allowCrossSessionNotify, true)
    check('默认静默窗口与微信一致', defaults.settleMs, 1200)
    check('★ 默认合并窗口与微信一致（10 秒）', defaults.mergeWindowMs, 10000)
    check('★ 默认自动回应附件与微信一致', defaults.autoReplyAttachments, true)
    check('★ 默认回复字数上限与微信一致（4000）', defaults.maxReplyChars, 4000)
    // 这段说明的**每一句都对应一种真实发生过的答非所问**，所以逐句钉住，而不是只比长度。
    //
    // ⚠️ 取值为 undefined 时用空串兜住（`?? ''`）是有意的：设置项被漏掉时这几条要**报 FAIL**，
    // 不能在这里抛 `Cannot read properties of undefined`。理由是位置——本段在 schema 驱动的
    // 往返测试**之前**，一抛整个脚本就结束了，后面那些专门用来点名"缺了哪一项"的断言
    // 一条都跑不到（第一版就是这样：删掉 `presenceNote` 只看到一句 TypeError）。
    // 一条测试的失败必须看得懂缺的是什么，否则它只证明了"坏了"。
    check('★ presenceNote 说明对方在手机', (defaults.presenceNote ?? '').includes('在手机上'), true)
    check('★ presenceNote 说明看不到屏幕与文件系统', (defaults.presenceNote ?? '').includes('看不到这台电脑的屏幕和文件系统'), true)
    check('★ presenceNote 要求直接发送而不是让用户去看路径', (defaults.presenceNote ?? '').includes('不要让他去'), true)
    check('★ presenceNote 要求回复简短', (defaults.presenceNote ?? '').includes('回复尽量简短'), true)
    check('presenceNote 标注的渠道是 QQ', (defaults.presenceNote ?? '').includes('[渠道：QQ]'), true)

    // ★ 扫码状态词表必须与设置页客户端契约一致（它认 phase 与 qrDataUrl）
    const bind = runtime.bindSnapshot()
    check('★ 扫码状态用 phase 而不是 status', 'phase' in bind && !('status' in bind), true)
    check('初始 phase 是 idle', bind.phase, 'idle')
    const { QqBindSession } = await import('../lib/login.js')
    const session = new QqBindSession({})
    check('新建会话 phase 是 idle', session.snapshot().phase, 'idle')
    check('取消后仍是 idle', (session.cancel(), session.snapshot().phase), 'idle')

    // ★ 中间态必须是 running + step，不能是自定义 phase。
    // 微信的设置页只在 `phase === 'running'` 时轮询扫码状态；若 start() 返回 'starting'，
    // 轮询永不启动、二维码永不出现（表现为「点了开始扫码什么都没发生」）。
    const started = await session.start()
    check('★ start() 后 phase 是 running（不是 starting）', started.phase, 'running')
    check('★ 中间态用 step 表达', typeof started.step, 'string')
    check('★ running 是唯一的进行中 phase', ['idle', 'running', 'succeeded', 'already-bound', 'failed'].includes(started.phase), true)
    session.cancel()

    // 设置持久化往返
    const settingsFile = join(dir, 'persist.json')
    const makeRuntime = () =>
      new QqRuntime(ctx, {
        home: dir,
        stateFile: settingsFile,
        workspace: join(dir, 'ws-persist'),
        credentials,
      })
    const writer = makeRuntime()
    writer.applySettings({ permissionPreset: 'auto', requireConfirmation: false, settleMs: 700, allowCrossSessionNotify: false })
    // 写盘是 fire-and-forget，等一拍
    await new Promise((resolve) => setTimeout(resolve, 120))
    const reader = makeRuntime()
    await reader.hydrateSettings()
    const restored = reader.settingsSnapshot()
    check('★ 权限预设被持久化', restored.permissionPreset, 'auto')
    check('★ requireConfirmation 被持久化', restored.requireConfirmation, false)
    check('★ allowCrossSessionNotify 被持久化', restored.allowCrossSessionNotify, false)
    check('★ settleMs 被持久化', restored.settleMs, 700)

    /*
     * ============================================================================
     * ★★★ 设置项的 schema 驱动往返 + 键集一致性（本次修复的核心测试）★★★
     * ============================================================================
     *
     * ## 它挡的是哪一个故障
     *
     * 上面那四条只往返了**九个设置里的四个**（`permissionPreset`、
     * `requireConfirmation`、`allowCrossSessionNotify`、`settleMs`），
     * 另外五个（`presenceNote` / `mergeWindowMs` / `autoReplyAttachments` /
     * `maxReplyChars` / `workspacePath`）从来没有被"写进去再读回来"验证过。
     *
     * 而本插件原来把设置名抄了**三遍**（`state.js` 的加载白名单、
     * `runtime.js` `#persistSettings()` 的落盘清单、设置页快照）。三份手抄名单
     * 不会一起改：加一项设置时漏掉 `state.js` 那一份，加载时它被丢弃，
     * 而**每次写盘都会重新加载并重新规范化**，于是下一次写盘把这份丢失持久化了。
     * 页面上的表现就是"重启后设置忘了"。微信插件踩过同一条（提交 `5cbe7d2`），
     * 那边的修法是"映射类型下每项一个校验器 + 一个把每个默认值都点名的往返测试"。
     *
     * ## QQ 没有编译器，所以下面两条断言就是那个"编译错误"的等价物
     *
     * 1. **每条往返断言由 `SETTINGS_SCHEMA` 派生**：往 schema 里加一项，
     *    断言数自动 +1（不用改测试），而**删掉** schema 里的一项会让
     *    "写进去的值读回来变成默认值"当场变红。
     *    这是它比上面四条硬的地方——上面四条写死了字段名，测试自己也会过时。
     * 2. **键集一致性**：`SETTINGS_SCHEMA` 的键集、'运行时实际持有'的键集、
     *    以及**真正落到盘上的**键集，三者必须完全相同。
     *    '运行时实际持有'取自 `runtime.settingsSchema().heldKeys`——它是照着运行时的
     *    `#settings` 对象**现场取出来的键**，不是第二份手抄名单。
     *    真要是两份名单，那就等于把这个 bug 换个地方藏起来。
     *    落盘键集则是从**盘上的 JSON**读出来的，也就是运行时真正写下去的东西。
     */
    const { SETTINGS_KEYS, SETTINGS_DEFAULTS, SETTINGS_SCHEMA } = await import('../lib/settings.js')
    // 自己的读写：上面那两个 `readStateSync` / `writeFileSync` 在本块之后才声明
    // （`const` 的暂时性死区），用它们会直接抛 ReferenceError。
    const { readFileSync: readRoundTripFile, writeFileSync: writeRoundTripFile } = await import('node:fs')
    const roundTripFile = join(dir, 'roundtrip-schema.json')
    const makeRoundTripRuntime = () =>
      new QqRuntime(ctx, {
        home: dir,
        stateFile: roundTripFile,
        workspace: join(dir, 'ws-roundtrip'),
        credentials,
      })

    /**
     * 为一项设置造一个**合法、非默认、且 trim 后不变**的值。
     *
     * 关于 trim：`workspacePath` 在运行时里是 trim 过的，带首尾空格的值读回来
     * 会短一截——那不是持久化的 bug 而是它的既有语义，所以这里不给它空格，
     * 免得断言测的是 trim 而不是往返。
     */
    const roundTripValue = (key) => {
      const fallback = SETTINGS_DEFAULTS[key]
      if (typeof fallback === 'boolean') return !fallback
      if (typeof fallback === 'number') return fallback + 37
      return key === 'permissionPreset' ? 'auto' : `往返-${key}`
    }
    const roundTripPatch = Object.fromEntries(SETTINGS_KEYS.map((key) => [key, roundTripValue(key)]))

    /*
     * 整段包在 try 里：这一段的用途是**在设置项被漏掉时变红**，所以它自己绝不能崩。
     * 一个抛异常的测试会以退出码 1 结束，但不会有任何一行带字段名的 FAIL——
     * 缺的那一项叫什么就得靠人去猜（第一版就是这样：删掉 presenceNote 之后，
     * 先抛的是更下面那条 `defaults.presenceNote.includes`，本段根本没跑到）。
     */
    let roundTripDefaultsRead = undefined
    let roundTripWriter = undefined
    try {
      roundTripWriter = makeRoundTripRuntime()
      roundTripWriter.applySettings(roundTripPatch)
      // 写盘是 fire-and-forget，等一拍
      await new Promise((resolve) => setTimeout(resolve, 120))

      const storedSettings = JSON.parse(readRoundTripFile(roundTripFile, 'utf8')).settings ?? {}
      /*
       * ★★ 这一条是"编译错误"的等价物，四条来源全在：
       *
       *   schema 的键集 / 运行时**此刻实际持有**的键集 / **落盘**的键集。
       *
       * 前两者的关系要说清楚，否则容易以为它在自证：`#settings` 是照
       * `{ ...SETTINGS_DEFAULTS }` 建出来的，所以 schema 少一项时两边会**一起**少，
       * 这一条看不出问题（那不是它的职责——schema 少一项由上面"设置项就是这九项"
       * 与各条硬编码断言去抓）。它抓的是**反方向**：有人在 `runtime.js` 里新加一个
       * 设置字段（`this.#settings.xxx = …`）却没加进 schema。
       * 那正是这个 bug 最可能的再现方式——而它极隐蔽：`#persistSettings()` 由 schema
       * 驱动，于是**那个字段写不出去**，用户重启后设置就没了。
       * 这里 `heldKeys` 会多出来，当场变红。反向对照实测过：见提交说明的突变实验 B。
       */
      check(
        '★★ 键集一致：schema = 运行时实际持有 = 落盘（同一个集合）',
        JSON.stringify([
          [...SETTINGS_KEYS].sort(),
          [...roundTripWriter.settingsSchema().heldKeys].sort(),
          Object.keys(storedSettings).sort(),
        ]),
        JSON.stringify([[...SETTINGS_KEYS].sort(), [...SETTINGS_KEYS].sort(), [...SETTINGS_KEYS].sort()]),
      )
      /*
       * 鉴别力前置：每一项都得**真的**写成了非默认值。
       *
       * 少了它，`roundTripValue` 万一哪天返回了默认值，"写进去再读回来相等"
       * 就会因为两边都是默认值而恒真——一条永远通过的往返断言比没有更糟。
       * 这里放在键集断言之后：schema 少了一项时，上一条先报出"缺了哪个"，
       * 而不是让这一条以"值不相等"的面目抢答。
       */
      check(
        '★ 前置：每一项都真的写成了非默认值（否则往返断言测不到东西）',
        JSON.stringify(Object.keys(storedSettings).filter((key) => storedSettings[key] === SETTINGS_DEFAULTS[key])),
        JSON.stringify([]),
      )

      /*
       * ★★★ 真正的往返：**换个实例从同一份文件读回来，值必须与写进去的一致** ★★★
       *
       * 这一条是**非默认值**的往返，和下面那条"默认值点名"是两件不同的事，
       * 少任何一条都会留下一个盲区：
       *
       * - 只比"读回来 = 默认值"（第一版就少了这一条）：盘上的值还在，但加载归一
       *   **把它丢掉了**，于是读回来是默认值——而"默认值"正是它**应该**有的样子，
       *   断言恒真。实测出来的：把 `state.js` 的加载归一换回**迁移前那份手抄的
       *   八项白名单**（漏 `presenceNote`），只比默认值的版本**全绿通过**，
       *   而这一条立刻报出 `presenceNote` 丢了。这正是微信插件那个 bug 的形状。
       * - 反过来，只比"读回来 = 写进去的"而不点名默认值，就看不出"缺项该回落默认"。
       */
      const keptReader = makeRoundTripRuntime()
      await keptReader.hydrateSettings()
      const kept = {}
      for (const key of SETTINGS_KEYS) {
        const value = keptReader.settingsSnapshot()[key]
        // `workspacePath` 在运行时里是 trim 过的（既有语义），往返值刻意不带空格，
        // 所以这里两者本就相等；仍写出来是为了让"只有它会变"这件事留在代码里。
        kept[key] = key === 'workspacePath' ? String(value).trim() : value
      }
      const lost = SETTINGS_KEYS.filter((key) => JSON.stringify(kept[key]) !== JSON.stringify(roundTripPatch[key]))
      check(
        '★★ 往返：每一项读回来的值都等于写进去的值（丢掉哪一项就点出哪一项）',
        JSON.stringify(lost),
        JSON.stringify([]),
      )

      /*
       * 每个默认值都点名：把状态文件清空（没有 settings 块）再让一个**全新实例**读回来，
       * 逐项必须等于 schema 的默认值。缺项回落默认值这条路径只有它能覆盖。
       *
       * 这就是微信那个"a round-trip test that names every default"：
       * 循环走 `SETTINGS_KEYS`，所以加一项设置自动多一条断言。
       */
      writeRoundTripFile(roundTripFile, `${JSON.stringify({ version: 1 })}\n`, 'utf8')
      const defaultsReader = makeRoundTripRuntime()
      await defaultsReader.hydrateSettings()
      roundTripDefaultsRead = defaultsReader.settingsSnapshot()
    } catch (error) {
      check(
        '★★ schema 往返回合本身不该抛异常（抛了就看不到后面每项点名）',
        error instanceof Error ? error.message : String(error),
        '（无异常）',
      )
    }

    const readDefaults = roundTripDefaultsRead ?? {}
    const wrongDefaults = SETTINGS_KEYS.filter((key) => readDefaults[key] !== SETTINGS_DEFAULTS[key])
    check(
      `★ schema 驱动：${SETTINGS_KEYS.length} 个默认值逐个点名（缺项回落默认值，不多不少）`,
      JSON.stringify(wrongDefaults),
      JSON.stringify([]),
    )
    check(
      '★ 每项都带自己的校验器（纯 JS 里用断言代替编译错误）',
      SETTINGS_KEYS.filter((key) => typeof SETTINGS_SCHEMA[key]?.normalize === 'function').length,
      SETTINGS_KEYS.length,
    )

    // 默认值本身与运行时对外报的默认值必须同源（页面读的是 `settingsForPage().defaults`）
    const pageDefaults = roundTripWriter.settingsForPage().defaults
    check(
      '★ 设置页报的默认值与 schema 的默认值同源',
      JSON.stringify(pageDefaults),
      JSON.stringify(SETTINGS_DEFAULTS),
    )

    /*
     * ---- ★★ 权限预设 setter 必须落盘（用户报的"设置不会保存"）★★ ----
     *
     * 这里钉的是一个**已经发生过**的故障：设置页切预设走的是独立路由
     * `POST /permission-preset`，那条路只调用 `setPermissionPreset()`。
     * 它当时只改内存 + 打日志、从不写盘，于是界面显示成功、状态文件里还是旧值，
     * **重启就回退**。根因与排查过程见 `runtime.js` 里那段注释。
     *
     * ## 为什么这几条断言抓得住它
     *
     * 盘上先放一个**不同的**旧值，然后：
     *
     * - 正确路径（`setPermissionPreset('x')`）之后，**换一个实例从同一份文件读回**必须得到新值；
     * - 故障路径（`setPermissionPreset('x', { persist:false })`）之后，同样的"读回"必须得到旧值。
     *
     * `{ persist:false }` 与"把 `if (persist)` 那一行删掉"产生**完全相同的可观测状态**
     * （内存变了、盘上没变），所以这两条合起来就是一个自动化的反向对照：
     * 少了落盘那一句，第一条断言必然失败。不是"读了代码觉得对"，是同一把尺子量两次。
     *
     * 写入次数单独用 `StateStore.update` 计数（它是原型方法，实例上覆盖即可）——
     * "写了没有"与"写了几次"是两件事，后者正是 `applySettings` 里 `persist:false` 要守的。
     */
    const { readFileSync: readStateSync } = await import('node:fs')
    const presetFile = join(dir, 'preset-persist.json')
    const makePresetRuntime = () =>
      new QqRuntime(ctx, {
        home: dir,
        stateFile: presetFile,
        workspace: join(dir, 'ws-preset'),
        credentials,
      })
    const readPresetOnDisk = () => JSON.parse(readStateSync(presetFile, 'utf8')).settings.permissionPreset

    const presetRuntime = makePresetRuntime()
    // 先在盘上放一个与将要设置的值**不同**的旧值：新旧相同的话断言没有鉴别力。
    await presetRuntime.store.update((next) => {
      next.settings = { permissionPreset: 'workspace-write' }
    })
    let presetWrites = 0
    const realUpdate = presetRuntime.store.update.bind(presetRuntime.store)
    presetRuntime.store.update = async (mutate) => {
      presetWrites += 1
      return await realUpdate(mutate)
    }
    check('前置：盘上是旧预设', readPresetOnDisk(), 'workspace-write')

    // ① setter 默认落盘
    presetWrites = 0
    presetRuntime.setPermissionPreset('danger-full-access')
    await new Promise((resolve) => setTimeout(resolve, 120))
    check('★ setPermissionPreset 之后状态存储被写过（恰好一次）', presetWrites, 1)
    check('★ 写入的 settings.permissionPreset 就是新值', readPresetOnDisk(), 'danger-full-access')
    const afterRestart = makePresetRuntime()
    await afterRestart.hydrateSettings()
    check('★ 重启后读回的是新预设（用户报的"回退"不再发生）', afterRestart.settingsSnapshot().permissionPreset, 'danger-full-access')

    // ② persist:false 必须真的不写 —— 这是 ① 的反向对照
    presetWrites = 0
    presetRuntime.setPermissionPreset('workspace-write', { persist: false })
    await new Promise((resolve) => setTimeout(resolve, 120))
    check('★ persist:false 不写盘（0 次）', presetWrites, 0)
    check('★ persist:false 不改盘上的值', readPresetOnDisk(), 'danger-full-access')
    check('★ 内存里已经改了（证明"没写盘"不是因为压根没生效）', presetRuntime.settingsSnapshot().permissionPreset, 'workspace-write')
    const afterNoPersist = makePresetRuntime()
    await afterNoPersist.hydrateSettings()
    check(
      '★★ 反向对照：没有落盘时重启读到的是旧值（= 故障现象）',
      afterNoPersist.settingsSnapshot().permissionPreset,
      'danger-full-access',
    )

    // ③ applySettings 恰好写一次盘：零次意味着设置丢了，两次意味着同一次变更写了两遍
    presetWrites = 0
    presetRuntime.applySettings({ permissionPreset: 'auto' })
    await new Promise((resolve) => setTimeout(resolve, 120))
    check('★ applySettings 恰好写一次盘（不是 0 次也不是 2 次）', presetWrites, 1)
    check('★ applySettings 落盘的值正确', readPresetOnDisk(), 'auto')
    check('★ applySettings 之后 setter 的内存值也一致', presetRuntime.settingsSnapshot().permissionPreset, 'auto')

    /*
     * ---- 模型的读/列/写（假宿主服务；不打真实 DSH）----
     *
     * 这三条路各自对应宿主的一个接口，都在 `runtime.js` 的注释里写了出处。
     * 这里用假服务钉住**接线**：provider 分组有没有被展平、当前模型优先读哪个来源、
     * 切换时传下去的 provider+model 对不对。
     *
     * ⚠️ 它**不能**证明"切完模型真的换了模型"——那要真实 DSH，只能由用户实测。
     * 这一节能证明的只有"调用形状与 DSH 暴露的接口一致"。
     */
    const modelSelects = []
    const sessionsById = new Map()
    const projections = new Map()
    // 宿主服务在 Cordis 里两条路都通（`ctx.get('x')` 与 `ctx.x`），假上下文也照给，
    // 否则测的就不是运行时真正会走的那条路。
    const modelServices = {
      sessions: { get: (id) => sessionsById.get(id) },
      sessionProjections: {
        stateOf: (session, key) => (key === 'modelSelection' ? projections.get(session) : undefined),
      },
      sessionController: {
        modelCatalog: async () => ({
          default: { provider: 'deepseek-account', model: 'deepseek-chat' },
          routableProviders: ['deepseek-account'],
          groups: [
            {
              id: 'deepseek-account',
              name: 'DeepSeek',
              models: [
                { id: 'deepseek-chat', name: 'DeepSeek Chat' },
                {
                  id: 'deepseek-reasoner',
                  name: 'DeepSeek Reasoner',
                  // 与 `dsh-llm-deepseek` 发布的一模一样：id 是小写，名字是首字母大写。
                  reasoning: {
                    efforts: [
                      { id: 'off', name: 'Off' },
                      { id: 'low', name: 'Low' },
                      { id: 'high', name: 'High' },
                      { id: 'max', name: 'Max' },
                    ],
                    defaultEffort: 'high',
                  },
                },
                { id: 'deepseek-broken', name: 'DeepSeek Broken' },
              ],
            },
          ],
          failures: [{ id: 'dead-provider', name: 'Dead', message: '凭据没配好' }],
        }),
        selectModel: async (request) => {
          modelSelects.push(request)
          // 一个"接口在、实际不可用"的模型：失败**必须**被说出来（POSTMORTEM 006 的教训）。
          if (request.model === 'deepseek-broken') {
            throw new Error('Select an available model before sending a message.')
          }
          // 宿主会把等级归一化后回传（`commands.js` 的 `resolveCallConfig`），这里照做。
          return {
            selected: {
              provider: request.provider,
              model: request.model,
              ...(request.reasoningEffort === undefined
                ? {}
                : { reasoningEffort: request.reasoningEffort }),
            },
          }
        },
      },
    }
    const modelCtx = { get: (name) => modelServices[name], ...modelServices }
    const modelRuntime = new QqRuntime(modelCtx, {
      home: dir,
      stateFile: join(dir, 'model-state.json'),
      workspace: join(dir, 'ws-model'),
      credentials,
    })

    const catalogRows = await modelRuntime.listModels()
    check(
      '★ 宿主按 provider 分组的目录被展平成一行一个模型',
      JSON.stringify(catalogRows.map((row) => `${row.provider}/${row.model}`)),
      JSON.stringify(['deepseek-account/deepseek-chat', 'deepseek-account/deepseek-reasoner', 'deepseek-account/deepseek-broken']),
    )
    check('展平时保留了显示名与 provider 名', `${catalogRows[0].name}|${catalogRows[0].providerName}`, 'DeepSeek Chat|DeepSeek')
    /*
     * 等级的来源是目录里那个 `reasoning`（`buildModelCatalog` 从
     * `resolveModelInfo` 里取的 `efforts` / `defaultEffort`）。
     * 它必须被展平带出来，否则 `/model` 的清单里就没有"这个模型能想多深"。
     */
    check('★ 目录里的 reasoning 被展平成 levels', JSON.stringify(catalogRows[1].levels), JSON.stringify([
      { id: 'off', name: 'Off' },
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
      { id: 'max', name: 'Max' },
    ]))
    check('★ 默认等级也被带出来（清单用它标"（当前）"）', catalogRows[1].defaultLevel, 'high')
    check('★ 没有 reasoning 的模型不带 levels（不是空数组）', JSON.stringify(['levels' in catalogRows[0], 'levels' in catalogRows[2]]), JSON.stringify([false, false]))

    // 当前模型有两个来源：会话投影优先，请求头兜底
    const headerOnly = { requestHeader: () => ({ config: { provider: 'deepseek-account', model: 'deepseek-chat' } }) }
    sessionsById.set('session-header', headerOnly)
    projections.set(headerOnly, { lastUsed: null, pending: null })
    const pendingOnly = { requestHeader: () => ({ config: { provider: 'old-p', model: 'old-m' } }) }
    sessionsById.set('session-pending', pendingOnly)
    projections.set(pendingOnly, { lastUsed: null, pending: { provider: 'new-p', model: 'new-m', reasoningEffort: 'high' } })
    sessionsById.set('session-bare', { requestHeader: () => undefined })

    check(
      '★ 投影为空时回落到会话请求头里的模型',
      JSON.stringify(modelRuntime.currentModel('session-header')),
      JSON.stringify({ provider: 'deepseek-account', model: 'deepseek-chat' }),
    )
    check(
      '★ 待生效的选择优先于请求头（切完还没跑下一步时也能显示新模型）',
      JSON.stringify(modelRuntime.currentModel('session-pending')),
      JSON.stringify({ provider: 'new-p', model: 'new-m', reasoningEffort: 'high' }),
    )
    check('会话没有任何模型记录时 undefined（用部署默认）', modelRuntime.currentModel('session-bare'), undefined)
    check('未知会话 undefined', modelRuntime.currentModel('session-unknown'), undefined)
    check('空 sessionId 不查宿主', modelRuntime.currentModel(''), undefined)

    const selected = await modelRuntime.selectModel('session-header', 'deepseek-account', 'deepseek-reasoner')
    check(
      '★ selectModel 传下去的是 sessionId + provider + model（宿主契约就是这样）',
      JSON.stringify(modelSelects),
      JSON.stringify([{ sessionId: 'session-header', provider: 'deepseek-account', model: 'deepseek-reasoner' }]),
    )
    check('selectModel 回的是宿主归一化后的选择', selected.model, 'deepseek-reasoner')

    // ---- 工具侧：agent 用自然语言走的是同一个路由（一份实现、两个入口）----
    await modelRuntime.store.update((next) => {
      next.bindings['111:peer'] = {
        conversationId: '111:peer',
        accountId: '111',
        peerId: 'peer',
        sessionId: 'session-header',
        title: 'QQ 会话',
        createdAt: 1,
        lastUsedAt: Date.now(),
      }
    })
    modelSelects.length = 0
    const toolList = await modelRuntime.controlSession('session-header', 'model', undefined)
    check('★ 工具 model（无目标）不切换', modelSelects.length, 0)
    check('★ 工具 model（无目标）成功', toolList.ok, true)
    check('★ 工具 model 不返回会话表（免得 agent 拿到无关清单去复述）', JSON.stringify(toolList.sessions), JSON.stringify([]))
    check('★ 工具 model 告诉 agent 不要重复清单', toolList.detail.includes('不要重复'), true)

    const toolSwitch = await modelRuntime.controlSession('session-header', 'model', '2')
    check(
      '★ 工具 model <编号> 与 /model <编号> 打的是同一个目标，且带上模型自己的默认等级',
      JSON.stringify(modelSelects.at(-1)),
      JSON.stringify({
        sessionId: 'session-header',
        provider: 'deepseek-account',
        model: 'deepseek-reasoner',
        reasoningEffort: 'high',
      }),
    )
    check('工具 model 切换成功', toolSwitch.ok, true)
    check('★ 工具 model 告诉 agent 不要重复切换结果', toolSwitch.detail.includes('不要重复'), true)

    // 反向对照：换到一个**没有等级**的模型时不带这个参数
    modelSelects.length = 0
    await modelRuntime.controlSession('session-header', 'model', '1')
    check('★ 反向对照：没有等级的模型不传 reasoningEffort', JSON.stringify(modelSelects.at(-1)), JSON.stringify({ sessionId: 'session-header', provider: 'deepseek-account', model: 'deepseek-chat' }))

    /*
     * 等级那半边：与 `/model 等级 …` 是同一句话，只是从 agent 嘴里说出来。
     * 先把这个会话"正在用"的模型换成带等级的那个——"只改等级"改的就是它的等级。
     */
    projections.set(headerOnly, {
      lastUsed: null,
      pending: { provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    })

    // 等级那半边：与 `/model 等级 …` 是同一句话，只是从 agent 嘴里说出来
    modelSelects.length = 0
    const toolLevel = await modelRuntime.controlSession('session-header', 'model', '2', 'low')
    check(
      '★ 工具 model + level = `/model 2 等级 low`',
      JSON.stringify(modelSelects.at(-1)),
      JSON.stringify({ sessionId: 'session-header', provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'low' }),
    )
    check('工具换等级成功', toolLevel.ok, true)
    check('★ 工具报告"不要重复"（这句话用户已经直接收到了）', toolLevel.detail.includes('不要重复'), true)

    modelSelects.length = 0
    const toolLevelOnly = await modelRuntime.controlSession('session-header', 'model', undefined, 'high')
    check(
      '★ 只给 level（没有 target）= 只改当前模型的等级',
      JSON.stringify(modelSelects.at(-1)),
      JSON.stringify({ sessionId: 'session-header', provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' }),
    )
    check('只改等级的工具结果也是成功', toolLevelOnly.ok, true)

    modelSelects.length = 0
    const toolLevelBad = await modelRuntime.controlSession('session-header', 'model', undefined, '高')
    check('★ 认不出的等级：工具报 ok:false（失败不静默）', toolLevelBad.ok, false)
    check('★ 认不出的等级一个都没切', modelSelects.length, 0)
    check('★ 认不出的等级文案里给出合法取值', toolLevelBad.detail.includes('Off、Low、High、Max'), true)

    const toolModelMissing = await modelRuntime.controlSession('session-header', 'model', '不存在的模型')
    check('★ 工具 model 找不到目标时 ok:false（agent 据此闭嘴）', toolModelMissing.ok, false)
    check('★ 找不到的一次都没切', modelSelects.length, 0)

    const toolModelRefused = await modelRuntime.controlSession('session-header', 'model', '3')
    check('★ 宿主拒绝时工具也报 ok:false（失败不静默）', toolModelRefused.ok, false)
    check('★ 失败原因被带回来', toolModelRefused.detail.includes('没有成功'), true)

    const toolUnbound = await modelRuntime.controlSession('session-not-bound', 'model', undefined)
    check('★ 未绑定对话的会话不能操作模型', toolUnbound.ok, false)

    /*
     * ---- 工具侧要来的清单：真的从**存储**里读一遍 ----
     *
     * 上面那些清单都是假宿主的。这一节把会话**真写进磁盘**（索引条目 + 会话目录），
     * 让 `session-index` → 网关 → 路由 → 工具的整条线跑一次：
     * agent 拿到的那份表必须与用户看到的编号一致（会话清单现在分两层、每屏十条）。
     */
    {
      const { mkdirSync: mkdirSeed, writeFileSync: writeSeed, utimesSync } = await import('node:fs')
      const si = await import('../lib/session-index.js')
      /**
       * 造一条"存储里真的有"的会话；`at` 决定排序。
       *
       * ⚠️ `at` 写进**记录里的** `sessionListMetadata.lastPromptAt`，那是清单真正读的时间。
       * 文件的 mtime 一并按 `at` 打上，好让这一节的语义与旧版一致；但**判据是记录**——
       * 改回 mtime 的清单在这里就会读不到时间。
       */
      const seedSession = (id, cwd, title, at) => {
        const sessionDir = join(dir, 'sessions', si.encodeWorkspaceDir(cwd), id)
        mkdirSeed(sessionDir, { recursive: true })
        const log = join(sessionDir, 'log.jsonl')
        writeSeed(log, '{}\n', 'utf8')
        utimesSync(log, new Date(at), new Date(at))
        const indexDir = join(dir, 'storages', 'session_projcache', 'sessions')
        mkdirSeed(indexDir, { recursive: true })
        writeSeed(
          join(indexDir, `${id}.json`),
          JSON.stringify({
            record: {
              rows: { title: { val: title }, sessionListMetadata: { val: { lastPromptAt: at } } },
              identity: { cwd, createdAt: at },
            },
          }),
          'utf8',
        )
      }
      const SELF_WS = join(dir, 'ws-model')
      const OTHER_WS = join(dir, '项目甲')
      seedSession('session-111111-aaaa', SELF_WS, '修登录', 5_000)
      seedSession('session-222222-bbbb', SELF_WS, '写周报', 4_000)
      seedSession('session-333333-cccc', OTHER_WS, '别人家的对话', 3_000)

      const stored = await modelRuntime.controlSession('session-header', 'list')
      check('★ 工具 list 从存储里读到了本工作区的会话', stored.sessions.length, 2)
      check('★ agent 拿到的编号就是用户看到的编号（从 1 起）', JSON.stringify(stored.sessions.map((row) => row.index)), JSON.stringify([1, 2]))
      check('★ agent 拿到的行带标题', stored.sessions[0].title, '修登录')
      check('★ agent 拿到的行带行尾那个 6 位 id 可用的 id', stored.sessions[0].sessionId, 'session-111111-aaaa')
      check('★ 其它工作区只报数量与名字（不塞进本工作区的清单）', JSON.stringify([stored.otherWorkspaces, stored.otherNames]), JSON.stringify([1, ['项目甲']]))
      check('★ 工具 list 告诉 agent 不要复述这份清单', stored.detail.includes('不要重复'), true)

      const storedAll = await modelRuntime.controlSession('session-header', 'list', 'all')
      check('★ 工具 list all 走的是**会话夹**那一层（夹子不是会话）', JSON.stringify(storedAll.sessions), JSON.stringify([]))
      check('工具 list all 仍然成功', storedAll.ok, true)
      check('★ list all 不再报"其余在别处"（全都在这儿了）', JSON.stringify([storedAll.otherWorkspaces, storedAll.otherNames]), JSON.stringify([0, []]))
    }

    // 缺服务时的降级：列清单回落为空、切换抛出（好让路由回一句失败而不是静默）
    const noModelCtx = { get: () => undefined }
    const noModelRuntime = new QqRuntime(noModelCtx, {
      home: dir,
      stateFile: join(dir, 'model-bare.json'),
      workspace: join(dir, 'ws-model-bare'),
      credentials,
    })
    check('★ 没有模型目录接口时返回空清单而不是抛', JSON.stringify(await noModelRuntime.listModels()), JSON.stringify([]))
    let selectThrew = false
    try {
      await noModelRuntime.selectModel('s', 'p', 'm')
    } catch {
      selectThrew = true
    }
    check('★ 没有切换接口时抛出（调用方据此回一句失败）', selectThrew, true)

    // 老状态文件（没有 settings 块）必须仍然可读，且回落默认值
    const legacyFile = join(dir, 'legacy.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(legacyFile, JSON.stringify({ version: 1, accounts: {}, bindings: {}, autoStart: true }), 'utf8')
    const legacy = new QqRuntime(ctx, { home: dir, stateFile: legacyFile, workspace: join(dir, 'ws-legacy'), credentials })
    await legacy.hydrateSettings()
    check('★ 老状态文件回落默认预设', legacy.settingsSnapshot().permissionPreset, 'danger-full-access')
    check('★ 老状态文件回落默认 settleMs', legacy.settingsSnapshot().settleMs, 1200)

    // ---- 数值设置的上下限与取整（细节：上限是防打错，不是格式规则）----
    runtime.applySettings({ mergeWindowMs: 10_000, settleMs: 1200, maxReplyChars: 4000 })
    runtime.applySettings({ mergeWindowMs: 36_000_000 })
    check('★ 超过上限的窗口被丢弃（保持原值）', runtime.settingsSnapshot().mergeWindowMs, 10_000)
    runtime.applySettings({ mergeWindowMs: 5000.7 })
    check('★ 合法值被取整', runtime.settingsSnapshot().mergeWindowMs, 5001)
    runtime.applySettings({ maxReplyChars: 999_999_999 })
    check('★ 超过字数上限被丢弃（保持原值）', runtime.settingsSnapshot().maxReplyChars, 4000)
    runtime.applySettings({ maxReplyChars: 0 })
    check('★ maxReplyChars=0（不限制）是合法值，不被上限逻辑拦掉', runtime.settingsSnapshot().maxReplyChars, 0)
    runtime.applySettings({ settleMs: -1 })
    check('★ 负数被丢弃（保持原值）', runtime.settingsSnapshot().settleMs, 1200)
    runtime.applySettings({ settleMs: 1.4 })
    check('★ 小数被取整而不是原样存下', runtime.settingsSnapshot().settleMs, 1)
    runtime.applySettings({ settleMs: Number.NaN })
    check('★ NaN 被丢弃', runtime.settingsSnapshot().settleMs, 1)
    runtime.applySettings({ settleMs: '500' })
    check('★ 字符串被丢弃（不改类型）', runtime.settingsSnapshot().settleMs, 1)
    // 上限本身是合法的
    runtime.applySettings({ settleMs: 3_600_000 })
    check('恰好等于上限是合法的', runtime.settingsSnapshot().settleMs, 3_600_000)

    // ---- allowCrossSessionNotify 关闭时是 fail-closed ----
    // 这条是审查时发现的死设置：它以前只存在于设置面板的读写管线里，没有任何强制点。
    runtime.applySettings({ allowCrossSessionNotify: false })
    const stateFileForNotify = join(dir, 'notify-state.json')
    const { writeFileSync: writeState } = await import('node:fs')
    writeState(
      stateFileForNotify,
      JSON.stringify({
        version: 1,
        accounts: { '111': { appId: '111', enabled: true } },
        bindings: { '111:E56C': { conversationId: '111:E56C', accountId: '111', peerId: 'E56C', sessionId: 'session-bound', title: 'qq' } },
        settings: { allowCrossSessionNotify: false },
        autoStart: true,
      }),
      'utf8',
    )
    const notifier = new QqRuntime(ctx, {
      home: dir,
      stateFile: stateFileForNotify,
      workspace: join(dir, 'ws-notify'),
      credentials,
    })
    await notifier.hydrateSettings()
    check('★ 关闭跨会话推送被持久化读回', notifier.settingsSnapshot().allowCrossSessionNotify, false)
    // 调用者不是绑定的那个会话 → 必须**拒绝**，而不是退回"推给当前绑定的"
    let rejected = false
    try {
      await notifier.notifyFromTool({ text: '你好' }, { agent: { session: { id: 'session-other' } } })
    } catch (error) {
      rejected = error instanceof Error && error.message.includes('允许任意会话主动推送')
    }
    check('★ 关闭时未绑定会话的推送被拒绝（fail-closed）', rejected, true)
    // 调用者就是绑定的那个会话 → 允许，只是发不出去（无 bot）所以进队列
    const queued = await notifier.notifyFromTool({ text: '你好' }, { agent: { session: { id: 'session-bound' } } })
    check('★ 关闭时绑定会话仍可推送', queued.includes('排队'), true)
    const queuedState = JSON.parse((await import('node:fs')).readFileSync(stateFileForNotify, 'utf8'))
    check('★ 入队确实落到了状态文件', (queuedState.pendingNotifications ?? []).length, 1)
    check('入队条目记的是本对话', queuedState.pendingNotifications[0].conversationId, '111:E56C')

    // ---- 会话文件夹路径：坏路径只能"没生效"，绝不能"起不来" ----
    // 这是设置页里唯一一个可以让插件启动失败的地方，所以运行时这一层必须兜住。
    const originalWorkspace = (await runtime.status()).workspace
    let wsThrew = false
    try {
      runtime.applySettings({ workspacePath: 'relative-not-absolute' })
    } catch {
      wsThrew = true
    }
    check('★ 坏路径不让 applySettings 抛', wsThrew, false)
    check('★ 坏路径不生效（仍用原工作区）', (await runtime.status()).workspace, originalWorkspace)
    check('★ 设置页仍显示用户填的原文（好让用户能改）', runtime.settingsSnapshot().workspacePath, 'relative-not-absolute')
    // 合法路径立即生效
    const customWorkspace = join(dir, 'ws-custom')
    runtime.applySettings({ workspacePath: customWorkspace })
    check('★ 合法路径立即生效', (await runtime.status()).workspace, customWorkspace)
    // 空串回到默认
    runtime.applySettings({ workspacePath: '' })
    const backToDefault = (await runtime.status()).workspace
    check('★ 空串回到默认位置（以 dsh_qq 结尾）', backToDefault.endsWith('dsh_qq'), true)
    check('★ 回到默认后工作区缓存被清（id 会重新解析）', backToDefault !== customWorkspace, true)

    // 缺服务时的降级：不应该抛
    const bare = new QqRuntime({ get: () => undefined }, {
      home: dir,
      stateFile: join(dir, 's2.json'),
      workspace: join(dir, 'ws2'),
      credentials,
    })
    check('★ 无任何服务时不抛', bare.settingsSnapshot().permissionPreset, 'danger-full-access')
    check('★ 无权限预设服务时 available 为空且有说明', JSON.stringify([bare.permissionPresetsInfo().available, typeof bare.permissionPresetsInfo().note]), JSON.stringify([[], 'string']))
    const dispose = bare.registerTools()
    check('★ 无工具服务时返回可调用的清理函数', typeof dispose, 'function')
    dispose()
    bare.disposeTools()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- 入站媒体：分类、选 URL、描述 ------------------------------------------
{
  const m = await import('../lib/media.js')

  // 分类：content_type 优先，缺失时退回文件名后缀
  check('image/png → 图片', m.attachmentKind({ content_type: 'image/png' }), 'image')
  check('video/mp4 → 视频', m.attachmentKind({ content_type: 'video/mp4' }), 'video')
  check('audio/wav → 语音', m.attachmentKind({ content_type: 'audio/wav' }), 'voice')
  check('voice → 语音', m.attachmentKind({ content_type: 'voice' }), 'voice')
  check('★ content_type 缺失时用后缀兜底', m.attachmentKind({ filename: '照片.JPG' }), 'image')
  check('★ 无类型无后缀 → 文件', m.attachmentKind({}), 'file')
  check('file → 文件', m.attachmentKind({ content_type: 'file' }), 'file')

  // 选 URL：语音优先服务端转好的 WAV
  check('★ 语音优先 voice_wav_url（不用 SILK）', m.downloadUrlFor({ voice_wav_url: 'wav://a', url: 'silk://b' }), 'wav://a')
  check('没有 voice_wav_url 时退回 url', m.downloadUrlFor({ url: 'x://c' }), 'x://c')
  check('都没有时 undefined', m.downloadUrlFor({}), undefined)

  // 描述：语音多给转写，决定 agent 要不要碰文件
  const described = m.describeMedia({ path: 'C:\\m\\a.png', bytes: 2048, kind: 'image' })
  check('描述含类别与路径', described.startsWith('[图片] C:\\m\\a.png'), true)
  check('描述含可读大小', described.includes('2.0 KB'), true)
  check('小于 1KB 用 B', m.describeMedia({ path: 'p', bytes: 512, kind: 'file' }).includes('512 B'), true)

  const voiceDescribed = m.describeMedia({ path: 'C:\\m\\v.wav', bytes: 100, kind: 'voice', transcript: '今天天气怎么样' })
  check('★ 语音描述带服务端转写', voiceDescribed.includes('服务端转写：今天天气怎么样'), true)
  // QQ 服务端直接给 WAV，所以微信那句"仍是原始 SILK"的免责说明不该出现
  check('★ 不含 SILK 免责（QQ 不需要）', voiceDescribed.includes('SILK'), false)

  // 下载失败必须留痕，不能让用户的图无声消失
  check('★ 下载失败有说明而不是沉默', m.describeMissing({ filename: 'a.png' }, 0), '[附件 a.png]（未能下载到本地，agent 无法读取）')
  check('无文件名时用序号兜底', m.describeMissing({}, 2).includes('附件3'), true)

  // 媒体目录按需创建
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-media-'))
  try {
    // 参数是**工作区路径本身**（不是 home + 目录名）——路径可自定义后媒体必须跟着走
    const workspace = join(dir, 'dsh_qq')
    const made = m.mediaDir(workspace)
    check('★ 媒体目录被创建', existsSync(made), true)
    check('媒体目录在工作区之下', made.startsWith(workspace), true)
    check('媒体目录名与微信同形（中文）', made.endsWith(m.MEDIA_DIR_NAME), true)
    const custom = join(dir, '我的QQ会话')
    check('★ 自定义工作区时媒体落在自定义目录下', m.mediaDir(custom).startsWith(custom), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- 长回复降级决策 --------------------------------------------------------
{
  const r = await import('../lib/reply-limit.js')

  const short = r.planReply('你好', 4000)
  check('短回复原样发送', JSON.stringify(short), JSON.stringify({ kind: 'send', text: '你好' }))
  check('恰好等于上限时原样发送', r.planReply('a'.repeat(4000), 4000).kind, 'send')

  // ★ <= 0 是"不限制"，不是"全部截断"——这条最易写反
  const unlimited = r.planReply('a'.repeat(9000), 0)
  check('★ limit=0 表示不限制（不是截断）', unlimited.kind, 'send')
  check('★ limit=0 时文本完整保留', unlimited.text.length, 9000)
  const negative = r.planReply('a'.repeat(9000), -1)
  check('负数也当不限制', negative.text.length, 9000)

  const long = r.planReply('a'.repeat(4001), 4000)
  check('超限时走文件', long.kind, 'file')
  check('超限时保留完整正文', long.text.length, 4001)
  check('★ caption 报出真实字数', long.caption, '回复较长（4001 字），已作为文件发送。')

  // 文件名：带时间戳、扩展名是 .md
  const name = r.longReplyFileName(new Date('2026-10-10T12:34:56.789Z'))
  check('文件名带时间戳且不含冒号点', name.includes('2026-10-10T12-34-56-789Z'), true)
  check('文件扩展名是 .md', name.endsWith('.md'), true)
  check('文件名词头是 回复-', name.startsWith('回复-'), true)
  // 两次调用不能撞名（同目录里会互相覆盖）
  check('★ 不同时刻文件名不同', r.longReplyFileName(new Date(1)) !== r.longReplyFileName(new Date(2)), true)
}

// ---- 待发消息队列 ----------------------------------------------------------
// 「发不出去」和「丢掉」是两回事。这一节钉住队列的边界行为。
{
  const p = await import('../lib/pending.js')

  const state = {}
  const dropped = p.queuePendingNotification(state, { conversationId: 'c1', text: '干完了' }, 1000)
  check('入队返回丢弃数 0', dropped, 0)
  check('队列里有 1 条', state.pendingNotifications.length, 1)
  check('条目带 id', typeof state.pendingNotifications[0].id, 'string')
  check('条目记下 queuedAt', state.pendingNotifications[0].queuedAt, 1000)
  check('只有文字时不带 path 键', 'path' in state.pendingNotifications[0], false)

  p.queuePendingNotification(state, { conversationId: 'c1', text: '', path: 'C:\\a.png' }, 1001)
  check('带文件时记录 path', state.pendingNotifications[1].path, 'C:\\a.png')

  // ★ 队列上限：丢最旧的
  const tiny = { pendingNotifications: [] }
  for (let i = 0; i < p.PENDING_QUEUE_LIMIT + 3; i += 1) {
    p.queuePendingNotification(tiny, { conversationId: 'c1', text: `m${String(i)}` }, 2000 + i)
  }
  check('★ 队列被截到上限', tiny.pendingNotifications.length, p.PENDING_QUEUE_LIMIT)
  check('★ 丢的是最旧的（最早那条已不在）', tiny.pendingNotifications.some((e) => e.text === 'm0'), false)
  check('★ 最新的那条还在', tiny.pendingNotifications.at(-1).text, `m${String(p.PENDING_QUEUE_LIMIT + 2)}`)

  // 过期
  const old = {}
  p.queuePendingNotification(old, { conversationId: 'c1', text: '很旧' }, 0)
  p.queuePendingNotification(old, { conversationId: 'c1', text: '很新' }, 10_000)
  const expired = p.expirePendingNotifications(old, 10_000, 5000)
  check('★ 过期只丢超龄的', expired.length, 1)
  check('★ 未超龄的被保留', old.pendingNotifications.length, 1)
  check('保留的是新的那条', old.pendingNotifications[0].text, '很新')
  check('★ 全部过期时删掉整个字段', (() => { const s = {}; p.queuePendingNotification(s, { conversationId: 'c', text: 'x' }, 0); p.expirePendingNotifications(s, 10_000_000, 1000); return 'pendingNotifications' in s })(), false)

  // 按对话筛选、保持顺序
  const mixed = {}
  p.queuePendingNotification(mixed, { conversationId: 'c1', text: 'a' }, 1)
  p.queuePendingNotification(mixed, { conversationId: 'c2', text: 'b' }, 2)
  p.queuePendingNotification(mixed, { conversationId: 'c1', text: 'c' }, 3)
  check('★ 只取本对话的，且保持先后顺序', p.pendingFor(mixed, 'c1').map((e) => e.text).join(''), 'ac')
  check('别的对话取到自己的', p.pendingFor(mixed, 'c2').map((e) => e.text).join(''), 'b')
  check('没有条目时返回空数组', p.pendingFor({}, 'c1').length, 0)

  // 移除
  const id = p.pendingFor(mixed, 'c1')[0].id
  check('移除成功', p.dropPending(mixed, id), true)
  check('移除后只剩一条 c1', p.pendingFor(mixed, 'c1').length, 1)
  check('移除不存在的 id 返回 false', p.dropPending(mixed, 'nope'), false)

  // 归一化：坏条目丢掉而不是整体拒绝
  const norm = p.normalizePending([
    { id: 'a', conversationId: 'c', text: 'ok', queuedAt: 1 },
    { id: '', conversationId: 'c', text: 'x', queuedAt: 1 },
    { id: 'b', conversationId: '', text: 'x', queuedAt: 1 },
    { id: 'c', conversationId: 'c', text: 'x', queuedAt: 'nope' },
    null,
    'string',
  ])
  check('★ 坏条目被逐条丢弃，好的留下', JSON.stringify(norm.map((e) => e.id)), JSON.stringify(['a']))
  check('非数组输入返回空', p.normalizePending('nope').length, 0)
  check('缺 text 时补空串', p.normalizePending([{ id: 'z', conversationId: 'c', queuedAt: 5 }])[0].text, '')
  // 下载重试：只重试"可能是瞬时"的失败，持久失败不浪费时间
  {
    const m = await import('../lib/media.js')
    const { mkdtempSync, rmSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-dl-'))
    const realFetch = globalThis.fetch
    try {
      // ① 404（链接过期）→ 不该重试
      let calls = 0
      globalThis.fetch = async () => {
        calls += 1
        return { ok: false, status: 404, headers: new Map() }
      }
      const notFound = await m.downloadAttachment({
        attachment: { url: 'https://x/expired.png', content_type: 'image/png' },
        dir,
        index: 0,
      })
      check('★ 404 不重试（链接过期，重试无意义）', calls, 1)

      // ② 500 两次后成功 → 应该重试并最终拿到文件
      calls = 0
      globalThis.fetch = async () => {
        calls += 1
        if (calls < 3) return { ok: false, status: 500, headers: new Map() }
        return {
          ok: true,
          status: 200,
          headers: new Map([['content-length', '5']]),
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5]).buffer,
        }
      }
      const recovered = await m.downloadAttachment({
        attachment: { url: 'https://x/ok.png', content_type: 'image/png', asr_refer_text: '' },
        dir,
        index: 1,
      })
      check('★ 5xx 会重试', calls, 3)
      check('★ 重试后成功并落盘', recovered !== undefined && existsSync(recovered.path), true)
      check('重试成功后字节数正确', recovered.bytes, 5)

      // ③ 一直 5xx → 4 次后放弃，返回 undefined（而不是抛）
      calls = 0
      globalThis.fetch = async () => {
        calls += 1
        return { ok: false, status: 503, headers: new Map() }
      }
      const gaveUp = await m.downloadAttachment({
        attachment: { url: 'https://x/down.png', content_type: 'image/png' },
        dir,
        index: 2,
      })
      check('★ 持续失败试满 4 次后放弃', calls, 4)
      check('★ 放弃时返回 undefined 而不是抛', gaveUp, undefined)

      // ④ 网络异常（fetch 抛）也要重试
      calls = 0
      globalThis.fetch = async () => {
        calls += 1
        if (calls < 2) throw new Error('ECONNRESET')
        return {
          ok: true,
          status: 200,
          headers: new Map(),
          arrayBuffer: async () => new Uint8Array([9]).buffer,
        }
      }
      const afterThrow = await m.downloadAttachment({
        attachment: { url: 'https://x/flaky.png', content_type: 'image/png' },
        dir,
        index: 3,
      })
      check('★ 网络异常会重试', calls, 2)
      check('网络异常后成功', afterThrow !== undefined, true)

      // ⑤ 没有 URL 时直接跳过，不该发起任何请求
      calls = 0
      globalThis.fetch = async () => {
        calls += 1
        throw new Error('不该被调用')
      }
      const noUrl = await m.downloadAttachment({ attachment: { content_type: 'image/png' }, dir, index: 4 })
      check('无 URL 时不发请求', calls, 0)
      check('无 URL 时返回 undefined', noUrl, undefined)
    } finally {
      globalThis.fetch = realFetch
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

// ---- 会话文件夹路径校验（坏路径只能"没生效"，不能"起不来"）----------------
{
  const { mkdtempSync, rmSync, existsSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const p = await import('../lib/paths.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-ws-'))
  try {
    const fallback = join(dir, p.WORKSPACE_DIR_NAME)

    check('空串 → 默认位置，不算回落', JSON.stringify(p.resolveWorkspaceDir(dir, '')), JSON.stringify({ path: fallback, fellBack: false }))
    check('未定义 → 默认位置', p.resolveWorkspaceDir(dir, undefined).path, fallback)
    check('只有空白 → 默认位置', p.resolveWorkspaceDir(dir, '   ').path, fallback)

    // ★ 相对路径必须被拒：它会相对于进程 cwd 解析，和用户以为的位置不是一回事
    const relative = p.resolveWorkspaceDir(dir, 'my-qq-folder')
    check('★ 相对路径被拒并回落', relative.fellBack, true)
    check('★ 相对路径回落时不抛（值仍然可用）', relative.path, fallback)
    check('★ 拒的理由说清是绝对路径问题', String(relative.reason).includes('不是绝对路径'), true)

    // 合法的绝对路径
    const custom = join(dir, '我的QQ会话')
    const accepted = p.resolveWorkspaceDir(dir, custom)
    check('★ 合法绝对路径被接受', accepted.path, custom)
    check('★ 被接受时不标记回落', accepted.fellBack, false)
    check('★ 目录真的被建出来了', existsSync(custom), true)

    /*
     * 不可用的**绝对**路径。
     *
     * ⚠️ 这里原来写的是 `'Z:\\不存在的盘\\QQ'`（注释说是"Windows 上不存在的盘符"）。
     * 那个字面量在 Linux 上 `path.isAbsolute()` 是 **false**，于是这条断言在 Linux 上
     * 走的是"不是绝对路径"那条分支——名字里那个"绝对"从来没被验过。
     * 也就是说它在本机绿、在 Linux 也绿，而绿的**不是同一件事**：一条恒绿的检查。
     *
     * 本机双平台实测（见工具探针）：那个字面量 Windows 上抛 `ENOENT`、Linux 上抛 `EACCES`；
     * 而"拿一个普通文件当路径分量"两边都抛 `ENOTDIR`，且 `isAbsolute` 两边都为真。
     * 所以夹具换成后者：同一个契约（绝对但不可用 → 回落、不抛），两种平台下都真的走到那一步。
     */
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a directory', 'utf8')
    const bad = p.resolveWorkspaceDir(dir, join(blocker, 'QQ'))
    check('★ 不可用的绝对路径被拒并回落', bad.fellBack, true)
    check('★ 不可用时值仍然可用（不抛）', bad.path, fallback)
    check('回落时给出理由', typeof bad.reason, 'string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/*
 * ---- ★ 首次运行的三个缺陷：契约是"永不抛"，而且失败必须可见 ----------------
 *
 * 这三条来自一次外部审计（`_qq-audit/` 里有可逐个重跑的探针，每条都有实测输出）。
 * 它们的共同点不是"会崩"，而是**崩在没有任何记录的地方**：
 *
 *   ① `configureLog` 的 mkdir 在 `apply` 的 try **之外** → 抛出去连一行都留不下
 *   ② `mediaDir` 无保护 → 抛在 `#handleInbound` 的 catch 里 → 整条入站消息连同正文一起消失
 *   ③ `resolveWorkspaceDir` 只验用户填的路径、**不验回落目标** → 返回一个不存在的路径
 *
 * 每一条都配一个"把保护拿掉就必须红"的反向对照（真的把 try/catch 或 mkdir 去掉跑过），
 * 所以这里钉的是行为，不是注释。
 *
 * ⚠️ 可达性如实写在 `lib/log.js` / `lib/paths.js` / `lib/media.js` 的注释里：
 * ① 需要 `$DSH_HOME` 不可创建（那种情况下 DSH 自己大概也起不来），价值是防御纵深；
 * ③ 的两行 mkdir 在 shipped 配置下不可达（`cordis.patch.yml` 只设了 `autoStart`）。
 * 它们不是"新用户一定会撞上"的必现缺陷。
 */
{
  const { mkdirSync: mkdirFix, mkdtempSync, existsSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const log = await import('../lib/log.js')
  const m = await import('../lib/media.js')
  const p = await import('../lib/paths.js')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-firstrun-'))
  try {
    // ---- ① 日志目录建不出来：不抛，而且仍然留下一行可见输出 ----
    {
      // `$DSH_HOME` 的位置上是一个普通文件 → `$DSH_HOME/qq` 建不出来（ENOTDIR）。
      const brokenHome = join(dir, 'log-home-is-a-file')
      writeFileSync(brokenHome, 'this is a file, not a directory', 'utf8')
      const lines = []
      const realLog = console.log
      console.log = (...args) => {
        lines.push(args.map((value) => String(value)).join(' '))
      }
      let threw = false
      try {
        log.configureLog(brokenHome)
        // `bootLog` 无论写不写盘都会 console.log 一份 —— 这正是"至少一行可见输出"的来源。
        log.bootLog('故障下的这一行必须看得见')
      } catch {
        threw = true
      }
      console.log = realLog
      check('★ ① 日志目录建不出来时 configureLog 不抛（它在 apply 的 try 之外）', threw, false)
      check(
        '★ ① 同一故障下 bootLog 仍然留下至少一行可见输出（从前是 0 行）',
        lines.filter((line) => line.includes('故障下的这一行必须看得见')).length,
        1,
      )
    }

    // ---- ② 媒体目录建不出来：不抛，返回的路径交给下载那一步去失败 ----
    {
      const ws = join(dir, 'ws-media-occupied')
      mkdirFix(ws, { recursive: true })
      writeFileSync(join(ws, m.MEDIA_DIR_NAME), 'a file where the media directory should be', 'utf8')
      let threw = false
      let made
      try {
        made = m.mediaDir(ws)
      } catch {
        threw = true
      }
      check('★ ② 媒体目录建不出来时 mediaDir 不抛（抛了整条入站消息会连同正文一起消失）', threw, false)
      check(
        '★ ② 仍然返回那个路径（下载那一步会失败并退化成 describeMissing）',
        made,
        join(ws, m.MEDIA_DIR_NAME),
      )
    }

    // ---- ③ resolvePaths：默认位置也要建（`settings.workspacePath` 的默认值是空串）----
    {
      const home = join(dir, 'paths-home')
      mkdirFix(home, { recursive: true })
      const custom = join(dir, 'paths-custom')
      /*
       * `resolveHome` 会读 `process.env.DSH_HOME`。这里必须接管它——否则这一节会拿
       * 真实的 home 去 mkdir（那就是"测试去动用户的目录"，比它要验的缺陷更糟）。
       */
      const savedHome = process.env.DSH_HOME
      process.env.DSH_HOME = home
      let resolved
      try {
        resolved = p.resolvePaths({ get: () => undefined }, { workspace: custom })
      } finally {
        if (savedHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = savedHome
      }
      check('★ ③ config.workspace 生效时，默认位置也被建出来', existsSync(join(home, p.WORKSPACE_DIR_NAME)), true)
      check('★ ③ 而 workspace 仍然是 config.workspace 指的那个（没有改变语义）', resolved.workspace, custom)
    }

    // ---- ③ resolveWorkspaceDir：回落目标必须真的可用，否则带 reason 返回 ----
    {
      const home = join(dir, 'fallback-home')
      mkdirFix(home, { recursive: true })
      // 相对路径必然被拒并回落 —— 审计实测这里从前返回的是一个**不存在**的路径。
      const relative = p.resolveWorkspaceDir(home, 'my-qq-folder')
      check('★ ③ 回落目标现在真的存在（从前返回一个不存在的路径）', existsSync(relative.path), true)

      // 回落目标**自己**也不可用：那个位置上放一个普通文件。
      const blocked = join(dir, 'fallback-blocked')
      mkdirFix(blocked, { recursive: true })
      writeFileSync(join(blocked, p.WORKSPACE_DIR_NAME), 'a file where the fallback should be', 'utf8')
      let threw = false
      let rejected
      let defaulted
      try {
        rejected = p.resolveWorkspaceDir(blocked, 'my-qq-folder')
        defaulted = p.resolveWorkspaceDir(blocked, '')
      } catch {
        threw = true
      }
      check('★ ③ 回落目标也不可用时仍然不抛（契约没被改弱）', threw, false)
      check('★ ③ 并把"回落目标也不可用"写进 reason', String(rejected?.reason).includes('回落目标'), true)
      check('★ ③ 也仍然保留"不是绝对路径"这个首要原因', String(rejected?.reason).includes('不是绝对路径'), true)
      check('★ ③ 默认位置不可用时同样不抛、fellBack 仍是 false', defaulted?.fellBack, false)
      check('★ ③ 并把原因带在 reason 里（调用方据此记进错误环）', String(defaulted?.reason).includes('回落目标'), true)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- StateStore 真实磁盘往返 ★ ---------------------------------------------
// 这一节是为了一个已经踩过的坑而加的：`readFile` 曾从 `node:fs`（回调版）导入，
// 于是每次读都是空状态、每次写只写回自己那一半，accounts 与 bindings 互相覆盖。
// 纯函数测试抓不到它——必须真的落盘再读回来。
{
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-state-'))
  const file = join(dir, 'state.json')
  try {
    const { StateStore } = state
    const errors = []
    const store = new StateStore(file, { onError: (m) => errors.push(m) })

    check('新文件读出来是空状态', Object.keys((await store.read()).accounts).length, 0)
    check('新文件不产生错误上报', errors.length, 0)

    // 模拟真实写入序列：先写 accounts，再写 bindings —— 第二次不能抹掉第一次。
    await store.update((next) => {
      next.accounts['1905760478'] = { appId: '1905760478', userOpenid: 'u1', enabled: true }
    })
    await store.update((next) => {
      next.bindings['1905760478:u1'] = {
        conversationId: '1905760478:u1',
        accountId: '1905760478',
        peerId: 'u1',
        sessionId: 's-1',
        title: 'QQ s-1',
        createdAt: 1,
        lastUsedAt: 1,
      }
    })

    const after = await store.read()
    check('★ 第二次写入没有抹掉 accounts', Object.keys(after.accounts).length, 1)
    check('★ 第二次写入保留了 bindings', Object.keys(after.bindings).length, 1)
    check('两个字段都在同一份文件里', JSON.stringify(Object.keys(after).sort()), JSON.stringify(['accounts', 'autoStart', 'bindings', 'browsing', 'pendingNotifications', 'sessionLists', 'settings', 'version']))

    // 换一个实例读同一个文件，确认真的落盘了（而不是内存里的假象）。
    const reopened = await new StateStore(file).read()
    check('★ 新实例能读回 accounts', Object.keys(reopened.accounts).length, 1)
    check('★ 新实例能读回 bindings', Object.keys(reopened.bindings).length, 1)

    // 并发写必须串行，不能互相覆盖。
    await Promise.all([
      store.update((next) => {
        next.accounts['a'] = { appId: 'a', enabled: true }
      }),
      store.update((next) => {
        next.accounts['b'] = { appId: 'b', enabled: true }
      }),
    ])
    const concurrent = await store.read()
    check('★ 并发写不丢数据', Object.keys(concurrent.accounts).length, 3)

    /*
     * 浏览位置与编号清单也必须真的落盘：前者是「查看其余」唯一的记录，
     * 后者是"引用一屏清单再回编号"唯一的记录。两者丢了都只表现为"编号指到了别处"，
     * 而那是最难从症状倒推到原因的一种失败。
     */
    await store.update((next) => {
      next.browsing['111:peer'] = { level: 'sessions', workspace: '', page: 2, at: 1 }
      next.sessionLists['111:peer'] = [
        { text: '【QQ 会话】会话（1/2）\n1. 写周报', sessions: [{ sessionId: 's-1', title: '周报' }], first: 11, at: 1 },
      ]
    })
    const routeState = await new StateStore(file).read()
    check('★ 浏览位置落盘并能读回', JSON.stringify(routeState.browsing['111:peer']), JSON.stringify({ level: 'sessions', workspace: '', page: 2, at: 1 }))
    check('★ 编号清单落盘并能读回（连起始编号一起）', JSON.stringify(routeState.sessionLists['111:peer']), JSON.stringify([{ text: '【QQ 会话】会话（1/2）\n1. 写周报', sessions: [{ sessionId: 's-1', title: '周报' }], first: 11, at: 1 }]))

    // 坏值必须被丢在门外：这两样东西决定"用户回的那个数字指到哪一行"
    await store.update((next) => {
      next.browsing['bad-level'] = { level: '不存在的层', workspace: '', page: 1, at: 1 }
      next.browsing['bad-page'] = { level: 'sessions', workspace: '', page: 'x', at: 1 }
      next.sessionLists['bad-row'] = [{ text: 'x', sessions: [{ sessionId: '' }], first: 1, at: 1 }]
    })
    const filtered = await new StateStore(file).read()
    check('★ 坏的浏览位置被丢掉（层名只认 folders/sessions）', 'bad-level' in filtered.browsing, false)
    check('★ 坏的浏览位置被丢掉（页号必须是数字）', 'bad-page' in filtered.browsing, false)
    check('★ 好的那条还在', '111:peer' in filtered.browsing, true)
    check('★ 一行 id 都没有的编号清单被丢掉', 'bad-row' in filtered.sessionLists, false)

    // 损坏文件：应留档并从空状态继续，且上报。
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, '{ 这不是 JSON', 'utf8')
    const corruptStore = new StateStore(file, { onError: (m) => errors.push(m) })
    check('损坏文件回退为空状态', Object.keys((await corruptStore.read()).accounts).length, 0)
    check('损坏文件会上报', errors.some((m) => m.includes('损坏')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/*
 * ---- ★ rename 的"文件被占用"重试（state.js）--------------------------------
 *
 * 为什么这一节必须存在：微信插件的同类代码在 Windows 上**实测 2000 次里失败 790 次**
 * （"有进程正读着该文件时 rename 会 EPERM"），而它那条**至今没修**，缺的正是这一节——
 * 它没有反向验证。
 *
 * ⚠️ 我们**没有真机**：无法验证"真机上 Windows 是否真的会 EPERM"。
 * 所以这里测的**不是操作系统的行为**（本项目"别赌 errno"的纪律），而是**我们代码的契约**：
 * 注入一个必然失败的 `rename`，断言重试发生了、上限之后失败看得见、不可重试的错误一次就放弃。
 * 真机那一条只能由用户实测。
 */
{
  const { mkdtempSync, rmSync, writeFileSync: writeReal, existsSync, readFileSync } = await import('node:fs')
  const { renameSync: renameReal } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { StateStore, RETRYABLE_RENAME_CODES, WRITE_RETRY_BACKOFF_MS } = state

  /** 一个"文件被占用"的错误：只带 `code`，不靠操作系统的 message 文案。 */
  const occupied = (code) => {
    const error = new Error(`${code}: operation not permitted, rename '<tmp>' -> '<state>'`)
    error.code = code
    return error
  }
  /** 本进程会用的临时文件名（`#write` 的约定）。 */
  const tempPath = (file) => `${file}.${process.pid}.tmp`

  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-rename-'))
  try {
    // ---- 0. 契约：可重试的只有"文件被占用"那一类；退避有上限且不固定 ----
    check('★ 可重试的错误码就是 Windows 的"文件被占用"那一类', JSON.stringify([...RETRYABLE_RENAME_CODES].sort()), JSON.stringify(['EACCES', 'EBUSY', 'EPERM']))
    check('★ ENOSPC（磁盘满）不在可重试集合里', RETRYABLE_RENAME_CODES.has('ENOSPC'), false)
    check('★ 退避总时长有上限（短、可控；这是同步路径）', WRITE_RETRY_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0) <= 200, true)
    check('★ 退避是递增的（不是固定睡眠）', WRITE_RETRY_BACKOFF_MS.every((ms, at) => at === 0 || ms > WRITE_RETRY_BACKOFF_MS[at - 1]), true)
    /*
     * ★ 这一条是**突变实验的挡板**：把 `WRITE_RETRY_BACKOFF_MS` 改成 `[]`（等于不重试）
     * 它必须变红。没有它，"把重试关掉"这件事可以由一个常量悄悄完成，而所有断言照样全绿
     * ——微信那条没修的缺陷，本质就是"没有任何东西在盯着重试还在不在"。
     */
    check('★ 生产配置至少重试 3 次（关掉重试必须让测试变红）', WRITE_RETRY_BACKOFF_MS.length >= 3, true)

    // ---- 1. 前两次 EPERM、第三次成功：重试确实发生，且写成不是错误 ----
    {
      const file = join(dir, 'a.json')
      const errors = []
      const retries = []
      let calls = 0
      const store = new StateStore(file, {
        onError: (m) => errors.push(m),
        onRetry: (m) => retries.push(m),
        rename: (from, to) => {
          calls += 1
          if (calls <= 2) throw occupied('EPERM')
          renameReal(from, to)
        },
      })
      let thrown
      try {
        await store.update((next) => {
          next.accounts['a'] = { appId: 'a', enabled: true }
        })
      } catch (error) {
        thrown = error
      }
      check('★ 重试之后这次写盘是成功的（不该抛给调用方）', thrown === undefined, true)
      check('★ 第一次 EPERM 之后确实又试了（rename 调用次数 > 1）', calls > 1, true)
      check('★ 试到成功为止：失败 2 次 → 一共调用 3 次', calls, 3)
      check('★ 靠重试写成的那一次留下了证据（否则没人知道真机上会不会遇到）', retries.length, 1)
      check('★ 证据里点名了尝试次数与错误码', (retries[0] ?? '').includes('attempts=3') && (retries[0] ?? '').includes('EPERM'), true)
      check('★ 重试成功**不算错误**（错误环里不该出现它——不喊狼来了）', errors.length, 0)
      check('★ 状态真的落盘了（重试不是只在内存里成功）', Object.keys((await new StateStore(file).read()).accounts).join(','), 'a')
      check('★ 写成之后没有留下 .tmp', existsSync(tempPath(file)), false)
    }

    // ---- 2. 一直 EPERM：重试到上限，失败必须可见，临时文件必须清掉 ----
    {
      const file = join(dir, 'b.json')
      // 盘上先有一份**好的**状态：一次失败的写入绝不能把它弄坏。
      writeReal(file, JSON.stringify({ version: 1, accounts: { keep: { appId: 'keep', enabled: true } }, autoStart: false }), 'utf8')
      const errors = []
      const retries = []
      let calls = 0
      const store = new StateStore(file, {
        onError: (m) => errors.push(m),
        onRetry: (m) => retries.push(m),
        rename: () => {
          calls += 1
          throw occupied('EPERM')
        },
      })
      let thrown
      try {
        await store.update((next) => {
          delete next.accounts.keep
        })
      } catch (error) {
        thrown = error
      }
      check('★ 一直失败时试到上限就不再试（次数 = 退避表长度 + 1）', calls, WRITE_RETRY_BACKOFF_MS.length + 1)
      check('★ 超过上限后是**抛出**的（调用方能知道，不是静默丢状态）', thrown !== undefined, true)
      check('★ 抛出的还是原来那个 errno（可据此定位）', thrown?.code, 'EPERM')
      check('★ 放弃时上报了（onError）', errors.length, 1)
      check('★ 上报里点名了状态文件', (errors[0] ?? '').includes('b.json'), true)
      check('★ 上报里点名了尝试次数', (errors[0] ?? '').includes(String(WRITE_RETRY_BACKOFF_MS.length + 1)), true)
      check('★ 上报说明这份改动没有落盘', (errors[0] ?? '').includes('没有落盘'), true)
      check('★ 放弃后临时文件被清掉（不留垃圾，也不掩盖问题）', existsSync(tempPath(file)), false)
      check('★ 放弃**也没有**"重试成功"的记录（它没成功）', retries.length, 0)
      check('★ 盘上原有的状态没有被破坏（半截写入是这里最不能犯的错）', JSON.stringify(Object.keys(JSON.parse(readFileSync(file, 'utf8')).accounts)), JSON.stringify(['keep']))
    }

    // ---- 3. 不可重试的错误：一次就放弃，但同样看得见 ----
    {
      const file = join(dir, 'c.json')
      const errors = []
      const retries = []
      let calls = 0
      const store = new StateStore(file, {
        onError: (m) => errors.push(m),
        onRetry: (m) => retries.push(m),
        rename: () => {
          calls += 1
          throw occupied('ENOSPC')
        },
      })
      let thrown
      try {
        await store.update(() => {})
      } catch (error) {
        thrown = error
      }
      check('★ ENOSPC 只试一次（磁盘满重试无用，别把坏消息推迟）', calls, 1)
      check('★ 也不会有"重试成功"的记录', retries.length, 0)
      check('★ 一次就失败同样可见（不是静默）', errors.length, 1)
      check('★ 上报里说明了"不可重试"', (errors[0] ?? '').includes('不可重试'), true)
      check('★ 该错误仍然抛给调用方', thrown?.code, 'ENOSPC')
      check('★ 没有留下 .tmp', existsSync(tempPath(file)), false)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

/*
 * ---- ★ 静默路径必须留下痕迹（runtime.js）-----------------------------------
 *
 * 用户最看重的一条：**"最要紧的是让这种失败可见——静默吞消息且不留日志，是这次真正致命的地方。"**
 * 这一节把补上日志的每一处各测一条，并且**每一条都配一个"不该记"的负向断言**——
 * 否则"到处都记一行"也能让正向断言全绿，而那种日志会把有用的行淹掉（本项目已经吃过一次亏）。
 *
 * 观测方式：`bootLog` 无论有没有日志文件都会 `console.log` 一份，所以把 `console.log`
 * 在这几行里换掉就能看到**用户会在 boot.log 里看到的东西**。
 */
{
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { QqRuntime } = await import('../lib/runtime.js')

  const dir = mkdtempSync(join(tmpdir(), 'dsh-qq-silence-'))
  /**
   * 开始截下 `bootLog` 的输出（它一定 `console.log` 一份）。
   *
   * 返回数组是**活的**：异步路径要看的就是"这一行什么时候出现"，所以调用方拿到它、
   * 把它交给 `waitUntil`，最后再断言。
   */
  const startCapture = () => {
    const lines = []
    const original = console.log
    console.log = (...args) => {
      lines.push(args.map((value) => String(value)).join(' '))
    }
    return { lines, stop: () => { console.log = original } }
  }
  /**
   * 等一个断言成立。**等的是"那个效果出现了"，不是固定时长**——
   * 微信 CI 那次就是"睡固定 80ms 再断言"，而那段在慢机器上要 217–306ms。
   */
  const waitUntil = async (predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (predicate()) return true
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
  const runtimeOptions = (file) => ({
    home: dir,
    stateFile: file,
    workspace: join(dir, 'dsh_qq'),
    credentials: {
      available: false,
      save: async () => ({}),
      load: async () => undefined,
      remove: async () => {},
      describe: async () => ({ configured: false }),
    },
  })

  /** 一个带可见正文的助手流帧。`sessionId` 省略 = 宿主没给会话 id。 */
  const frame = (sessionId, text) => ({
    ...(sessionId === undefined ? {} : { agent: { session: { id: sessionId } } }),
    frame: { chunk: { type: 'text-delta', text } },
  })

  try {
    const runtime = new QqRuntime({ get: () => undefined }, runtimeOptions(join(dir, 'stream.json')))
    const ORPHAN = 'session-deadbeef-0000-4000-8000-000000000000'

    // ---- 1. 助手流找不到绑定会话：整轮回答丢了，但留下一行 ----
    {
      check('前置：确实没有绑定（否则这一节什么都没测）', Object.keys((await runtime.store.read()).bindings).length, 0)
      const { lines, stop } = startCapture()
      try {
        runtime.onAssistantFrame(frame(ORPHAN, '这一轮的回答'))
        // 帧处理是 `#fire` 出去的异步活：等**那一行出现**，不等时长。
        await waitUntil(() => lines.some((line) => line.includes('没有 QQ 对话绑定到')))
      } finally {
        stop()
      }
      const orphan = lines.filter((line) => line.includes('没有 QQ 对话绑定到'))
      check('★ 助手流找不到绑定会话时日志里有一行（丢了不再是零痕迹）', orphan.length, 1)
      check('★ 那一行点名了会话 id', (orphan[0] ?? '').includes(ORPHAN), true)
      check('★ 那一行说明了"回答不会送达"', (orphan[0] ?? '').includes('不会送达'), true)
    }

    // ---- 2a. 没有会话 id 的**元数据帧**：不记（负向，防止观测手段变成障碍） ----
    {
      const { lines, stop } = startCapture()
      try {
        runtime.onAssistantFrame({ frame: { chunk: { type: 'usage' } } })
        runtime.onAssistantFrame({ frame: { chunk: { type: 'block-start', index: 0 } } })
      } finally {
        stop()
      }
      check('★ 没有正文的元数据帧不记（否则有用的行会被淹掉）', lines.filter((line) => line.includes('没有会话 id')).length, 0)
    }

    // ---- 2b. 没有会话 id 但**确实带着要送的东西**：正文与回合结束各记一行 ----
    {
      const { lines, stop } = startCapture()
      try {
        runtime.onAssistantFrame(frame(undefined, '无处投递的正文'))
        runtime.onAssistantFrame({ frame: { type: 'end' } })
      } finally {
        stop()
      }
      const withoutSession = lines.filter((line) => line.includes('没有会话 id'))
      check('★ 带正文的帧记一行（这正是"机器人整个不再回复"的样子）', withoutSession.some((line) => line.includes('7 字正文无处投递')), true)
      check('★ 没有会话 id 的"回合结束"帧也记（它本该触发发送）', withoutSession.some((line) => line.includes('回合结束帧')), true)
      check('★ 两种形态各记一次（不是"全局只记第一条"）', withoutSession.length, 2)
    }

    // ---- 3. 入站消息没有任何可投递内容：用户的消息丢了，但日志里留下一行 ----
    {
      const { QQBot } = await import('@tencent-connect/qqbot-nodejs')
      const listeners = new Map()
      const realStart = QQBot.prototype.start
      const realOn = QQBot.prototype.on
      const realSendText = QQBot.prototype.sendText
      try {
        QQBot.prototype.start = async function start() {
          return undefined
        }
        QQBot.prototype.sendText = async function sendText() {
          return {}
        }
        QQBot.prototype.on = function on(event, listener) {
          const list = listeners.get(event) ?? []
          list.push(listener)
          listeners.set(event, list)
          return this
        }
        const connected = new QqRuntime(
          { get: () => undefined },
          {
            ...runtimeOptions(join(dir, 'inbound.json')),
            credentials: {
              available: true,
              save: async () => ({}),
              load: async (appId) => ({ appId, appSecret: 'secret', userOpenid: 'peer', boundAt: 'x' }),
              remove: async () => {},
              describe: async () => ({ configured: true }),
            },
          },
        )
        await connected.start('111')
        const handler = (listeners.get('message') ?? [])[0]
        check('前置：入站处理器挂上了（否则这一节什么都没测）', typeof handler, 'function')
        const { lines, stop } = startCapture()
        try {
          await handler({}, { kind: 'c2c', senderId: 'peer', messageId: 'm-empty', content: '', msgType: 3 })
        } finally {
          stop()
        }
        const dropped = lines.filter((line) => line.includes('没有可投递内容'))
        check('★ 空内容的入站消息留下了一行（从前是裸 return，连"收到过"都查不出来）', dropped.length, 1)
        check('★ 那一行点名了对话与消息 id', (dropped[0] ?? '').includes('111:peer') && (dropped[0] ?? '').includes('m-empty'), true)
        check('★ 也点名了消息类型（"协议里没映射到的形态"唯一的线索）', (dropped[0] ?? '').includes('msgType=3'), true)
        /*
         * ★ 负向：**不进错误环**。
         *
         * 这不是随手选的：`scripts/verify-send-path.mjs` 那 60 项拿"空内容的入站消息"当脚手架
         * （它设计上什么都不碰），把它记成错误会让那些守着的断言变红。这一条把那个约定
         * **写下来**——将来有人想把它升级成 `#recordError` 时，会先在这里看到理由。
         */
        check('★ 但它不算错误（错误环留给真正失败的操作）', (await connected.status()).errors.filter((line) => line.includes('没有可投递内容')).length, 0)
      } finally {
        QQBot.prototype.start = realStart
        QQBot.prototype.on = realOn
        QQBot.prototype.sendText = realSendText
      }
    }

    /*
     * ---- 4. 设置存档：**旧值和新值都写** -----------------------------------
     *
     * 设置页"改了没生效"的两种形态在状态文件里长得一模一样（文件只记"现在存的是什么"）：
     * 请求根本没发出来，vs 发出来了、主机没收下。只有旧值和新值放在一起才分得开，
     * 而**只有主机同时知道这两个值**——所以这一节钉住三件事：旧值在、新值在，
     * 以及被丢弃的字段会把请求里的原始值一并写出来。
     */
    {
      const settingsRuntime = new QqRuntime({ get: () => undefined }, runtimeOptions(join(dir, 'settings-log.json')))

      // ---- 4a. 正常存档：旧值与新值在同一行 ----
      {
        const { lines, stop } = startCapture()
        try {
          settingsRuntime.applySettings({ settleMs: 999 })
        } finally {
          stop()
        }
        const saved = lines.filter((line) => line.includes('设置已存档'))
        check('★ 一次存档留下恰好一行', saved.length, 1)
        check('★ 旧值在', (saved[0] ?? '').includes('settleMs 1200 ->'), true)
        check('★ 新值也在（只有一边就分不出"没发出来"和"发了没收下"）', (saved[0] ?? '').includes('-> 999'), true)
        show('设置已存档那一行', saved[0])
      }

      // ---- 4b. 值没变也照样记：这正是"发了没收下"留下的形状 ----
      {
        const { lines, stop } = startCapture()
        try {
          settingsRuntime.applySettings({ settleMs: 999 })
        } finally {
          stop()
        }
        const saved = lines.filter((line) => line.includes('设置已存档'))
        check('★ 与原来同值时也记一行（否则"发了没收下"没有任何痕迹）', saved.length, 1)
        check('★ 那一行两侧同值', (saved[0] ?? '').includes('settleMs 999 -> 999'), true)
      }

      // ---- 4c. 被丢弃的字段：旧值、新值、请求里的原始值，三样都在 ----
      {
        const { lines, stop } = startCapture()
        try {
          settingsRuntime.applySettings({ mergeWindowMs: 36_000_000 })
        } finally {
          stop()
        }
        const saved = lines.filter((line) => line.includes('设置已存档'))
        check('★ 越界字段仍记一行（主机丢弃了它，而用户该看得见）', saved.length, 1)
        check('★ 两侧都是旧值（丢弃 = 保持原值，不是回落默认值）', (saved[0] ?? '').includes('mergeWindowMs 10000 -> 10000'), true)
        check('★ 并点名请求里的原始值（否则还得猜是越界、类型不对，还是压根没发）', (saved[0] ?? '').includes('36000000'), true)
        check('★ 也写明是被丢弃、保持原值', (saved[0] ?? '').includes('被丢弃'), true)
        show('被丢弃那一行', saved[0])
      }

      // ---- 4d. 负向：请求里没有可用字段时，不能假装存了一次 ----
      {
        const { lines, stop } = startCapture()
        try {
          settingsRuntime.applySettings({ 未知字段: 1 })
        } finally {
          stop()
        }
        const saved = lines.filter((line) => line.includes('设置已存档'))
        check('★ 没有可用字段时仍记一行（与"请求根本没到"分得开）', saved.length, 1)
        check('★ 那一行说清什么也没改', (saved[0] ?? '').includes('什么也没改'), true)
        check('★ 不该凭空写出一对旧新值', (saved[0] ?? '').includes(' -> '), false)
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}

// ---- 用户手册不会漂移：设置名与指令名都以代码为准 --------------------------
//
// 一份写给用户的手册，最坏的失败不是写得难看，而是**教了一个不存在的操作**：用户照着做，
// 做不到，而且不知道该信谁。所以这里把手册与代码对齐，**两个方向都查**。
//
// 1. **每一项设置都要被写到。** `lib/settings.js` 的 `SETTINGS_SCHEMA` 是设置名的唯一来源；
//    在那里加一项而忘了写进手册，这条就红。（反过来说，手册里的设置名用反引号写，
//    正是这条检查认的形式。）
// 2. **指令名双向一致。** 手册里出现的指令必须是 `router.js` 真的认的那几条之一——否则手册
//    在教一个不存在的操作；而 `router.js` 认的每一条也必须在手册里出现过——否则加了指令不说。
//
// 提取规则是有意的：只认"行首、空白、反引号、左括号、顿号、逗号之后"的 `/小写字母`。
// 于是 URL 里那些 `q.qq.com/qqbot/...`、`https://github.com/...` 不会被误当成指令
// （它们的 `/` 前面是字母或另一个 `/`），而 `/switch3`、`/switch:3` 都会归到 `switch`。
{
  const { readFileSync } = await import('node:fs')
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  let handbook
  try {
    handbook = readFileSync(join(root, 'docs', 'HANDBOOK-USER.md'), 'utf8')
  } catch {
    handbook = undefined
  }
  check('★ 用户手册存在且不为空', typeof handbook === 'string' && handbook.length > 1000, true)
  if (handbook === undefined) {
    show('手册路径', join(root, 'docs', 'HANDBOOK-USER.md'))
  } else {
    const { SETTINGS_KEYS } = await import('../lib/settings.js')
    const undocumentedSettings = SETTINGS_KEYS.filter((key) => !handbook.includes(`\`${key}\``))
    check(
      '★ 手册写到了每一项设置（SETTINGS_SCHEMA 是唯一来源）',
      undocumentedSettings.length === 0,
      true,
    )
    if (undocumentedSettings.length > 0) show('手册里没有的设置名', undocumentedSettings.join(' '))

    const routerSource = readFileSync(join(root, 'lib', 'router.js'), 'utf8')
    const accepted = new Set()
    for (const block of routerSource.matchAll(
      /const COMMANDS_(?:BARE|WITH_ARG|OPTIONAL_ARG) = \[([^\]]*)\]/g,
    )) {
      for (const quoted of block[1].matchAll(/'(\/[a-z]+)'/g)) accepted.add(quoted[1].slice(1))
    }
    check('前置：从 router.js 读到了指令表', accepted.size >= 5, true)
    show('代码认的指令', [...accepted].sort().join(' '))

    const mentioned = new Set()
    for (const match of handbook.matchAll(/(^|[\s`(（、,，])\/([a-z]+)/gm)) mentioned.add(match[2])
    show('手册里提到的指令', [...mentioned].sort().join(' '))

    const phantom = [...mentioned].filter((word) => !accepted.has(word))
    check('★ 手册里的指令都在代码里（不教不存在的操作）', phantom.length === 0, true)
    if (phantom.length > 0) show('手册里有、代码里没有的指令', phantom.join(' '))

    const unmentioned = [...accepted].filter((word) => !mentioned.has(word))
    check('★ 代码里的指令都写进了手册（加了指令不说，这里就红）', unmentioned.length === 0, true)
    if (unmentioned.length > 0) show('代码里有、手册里没有的指令', unmentioned.join(' '))
  }
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
process.exit(failures === 0 ? 0 : 1)
