# dsh-qq-plugin

[![CI](https://github.com/xcisxc29/dsh-qq-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/xcisxc29/dsh-qq-plugin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-qq-plugin.svg)](https://www.npmjs.com/package/dsh-qq-plugin)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

Drive the DeepSeek Harness agent on this computer from your phone, in QQ.

It goes through **Tencent's official QQ bot platform** (`api.bot.qq.com`, bound by scanning a QR
code), so there is **no public IP to expose, no reverse proxy, and no third-party protocol client**
in the middle. Bind once, and it keeps working.

**Runs on the current DSH desktop app** — developed and tested against DSH `0.2.0-rc.2`.

This is the QQ counterpart of [dsh-wechat-plugin](https://github.com/xcisxc29/dsh-wechat). It is
feature-aligned with it, with a few deliberate departures where the QQ protocol makes the WeChat
machinery unnecessary — see [Differences from the WeChat version](#differences-from-the-wechat-version).

[中文说明](README.zh.md)

<img src="docs/images/cover-chat.jpg" width="320" alt="A QQ chat: the message 「把我电脑上桌面那张 DSH 自画像发过来」 (send me that DSH self-portrait from my desktop), then the file arrives in the chat as an image, followed by 「已发送 ✅ 桌面上的「DSH 自画像.png」（29 KB，PNG）」 (sent — DSH 自画像.png on the desktop, 29 KB, PNG)">

> **Ask for a file in one sentence and it lands on your phone.** Say *"send me that DSH self-portrait
> from my desktop"* in QQ and the agent finds the file on the computer, sends it back, and confirms
> with *"sent — DSH 自画像.png on the desktop (29 KB, PNG)"*. The **＋** at the right of the composer
> is the attachment entry: images, videos, voice and files all go in that way
> (see [Media in both directions](#media-in-both-directions-images-video-voice-files)).

## Features

- **Text both ways.** A QQ message becomes a DSH prompt, and the reply comes back to QQ.
- **Images, files and voice in; images, videos and files out.** Attachments are saved into the
  session workspace and handed to the agent; the agent sends files back with `send_to_qq`.
  **A reply that runs long is turned into a `.md` file** and sent to your phone instead of being cut.
- **One QQ chat, many DSH conversations.** `/new`, `/list`, `/switch`, `/current`, `/cancel` — or
  just say "switch to the other one". The list has **session folders** and **sessions** as two levels.
- **Pick the model and the reasoning level from your phone too.** `/model` lists the models with
  each one's reasoning levels; `/model 2` and `/model 等级 high` switch them, effective from the
  **next** step.
- **Answer permission prompts and questions from your phone.** Approvals are answered with
  「允许」/「拒绝」 (allow/deny) or a numbered option; the agent's multiple-choice questions arrive in
  QQ with numbered options and a digit answers them — being away from the desk does not stall the task.
- **Proactive push.** `notify_qq` lets any session on this machine message you — that is what makes
  "tell me when it is done" work. It works in practice: a ten-message burst was delivered in full,
  and the last six of those went out as proactive pushes. (Tencent's rules for unsolicited sends can
  change and **the plugin assumes no quota**; anything undelivered is queued and flushed the next
  time you speak.)
- **Scheduled tasks.** Run through the DSH host's own `schedule_create` / `schedule_list` /
  `schedule_delete` / `schedule_update` — just say "wake me at 23:12". The plugin does not
  reimplement what DSH already has; it is only the channel.
- **Settings page** under **Settings → QQ** — nine settings, a native folder picker, and diagnostics.

## Install

**For the DSH desktop app** on a machine that stays on. It needs DSH's workspace, tool and UI
services — the standard desktop composition.

| | |
|---|---|
| DSH desktop | `@deepseek-ai/dsh-desktop` `0.2.0-rc.2` or newer |
| Phone | mobile QQ, to scan one QR code |
| QQ bot | **nothing to register in advance.** The bot application is created by that scan; you do not need an AppID/AppSecret beforehand |
| Tencent's rules | an **uncertified** bot is usable only by its administrator — that is, only by you, which is exactly what a personal remote control wants |

Open the **plugin** entry in the sidebar and choose **添加插件** (add plugin). The field takes a
package name, a Git URL, a tarball, or a local path.

> ### The name to install is `dsh-qq-plugin`
>
> The repository and the package share one name, so there is nothing to reconcile — but the
> `-plugin` suffix is easy to drop by accident. **Copy `dsh-qq-plugin` rather than typing it.** The
> install command has to match the package name exactly.

From a terminal, that is one line (`--profile web` works just as well if that is the profile you use):

```bash
dsh plugin --profile desktop add dsh-qq-plugin
```

<details open>
<summary><b>From npm</b> — nothing to configure</summary>

```
dsh-qq-plugin
```

Add a version if you need one: `dsh-qq-plugin@1.0.5`.
</details>

<details>
<summary><b>From a local checkout</b> — there is no build step to wait for</summary>

```
C:\path\to\dsh-qq
```

Point it at the directory that holds `package.json` — the folder is `dsh-qq`, the package it
declares is `dsh-qq-plugin`.
</details>

<details>
<summary><b>From a tarball</b></summary>

```bash
npm pack
# → dsh-qq-plugin-1.0.5.tgz
```

Paste the absolute path to that `.tgz` into **添加插件**.
</details>

<details>
<summary>Install from a terminal instead</summary>

The app drives `pnpm` underneath, so the same thing headlessly:

```bash
dsh plugin --profile desktop add dsh-qq-plugin
dsh plugin --profile desktop add C:\path\to\dsh-qq
```

You then have to enable the bundle yourself — which is what **立即启用** does for you — in
`~/.dsh/profiles/desktop/package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-qq-plugin"
      ]
    }
  }
}
```
</details>

Wait for the install to finish, click **立即启用** (enable now), and restart DSH.

### Getting started

After restarting DSH, open **Settings → QQ** and click **开始扫码** (start the QR bind). Scan the
code with mobile QQ and confirm on the phone.

**The scan is the whole registration.** The bot application is created by that scan, so you
**do not need to register anything on Tencent's open platform first and you do not need an
AppID/AppSecret in advance** — nor a public IP or a reverse proxy.

The credentials land straight in **DSH's credential store** — the plugin's own state file records
only the AppID, never the AppSecret. The channel connects by itself once bound: send any message to
the bot in QQ and you should get a reply.

<img src="docs/images/locked-screen-work.jpg" width="320" alt="A QQ chat on a phone: at 22:38 the agent reports that the 13-poem autumn anthology is ready and sends a docx and a pdf; at 22:43 the user asks 「告诉我，我现在电脑时间」 (tell me the computer's current time) and the agent answers 2026-10-13 22:43:28 Tuesday, then asks whether to set a reminder or a scheduled task">

That is what it looks like **in real use, after installing it**: the agent put together a 13-poem
anthology on the computer and sent both the `docx` and the `pdf` straight to the phone; in the same
conversation, *"tell me the computer's current time"* came back as `2026-10-13 22:43:28 Tuesday`,
along with an offer to set a reminder.

**The computer was locked at that moment** — the phone says 22:43 and so does the lock screen:

<img src="docs/images/locked-screen-desktop.jpg" width="720" alt="The computer's lock screen at the same 22:43: across the screen there is only the clock 22:43 and the date 10月13日，星期二, with no taskbar and no windows visible — a city-at-night photo behind them">

Locking the screen does not stop the agent, so it keeps working after you walk away while the
conversation on your phone carries on. The reverse is also true: **locking is exactly what you
should do when you leave** (see [Security](#security)).

## Usage

Just send a message and it reaches the agent:

```
你好
```

What follows is grouped by capability, and each group carries a **real screenshot** showing what it
looks like and what it proves.

### Conversation management, from your phone

One QQ chat sits in front of any number of DSH conversations. `/list` opens this **workspace's**
conversations, ten per screen:

<img src="docs/images/session-list.jpg" width="320" alt="Replying /list in QQ: the agent answers with an 【QQ 会话】会话 (1/1) list of ten rows, every row ending in a six-character id, row 1 marked with ← 当前 (current), and a footer saying there are another 89 conversations in other session folders, plus 「回复编号或行尾 6 位 id 切换。引用这条消息再回编号，可以避免编号过期。」">

One shot, four things proved: **ten rows per screen**, a **six-character id at the end of every row**
(`7cee80`, `4b55e1`…), the current conversation marked **← 当前**, and that footer line. The list also
tells you there are **89 more conversations in the other session folders**.

`/list all` is **the level above — the session folders** (across projects and workspaces), each with
its conversation count; reply with a number or a name to enter one, and what you get is that
folder's conversation list (the screenshot replies `1`, so it enters 「QQ 会话」):

<img src="docs/images/session-folders.jpg" width="320" alt="Replying /list all in QQ: the agent answers with a 会话夹 (1/1) list — QQ 会话 11 个会话, workplace 62, dsh_wechat 21, texttry 1, dsh_orb 1, browser-sessions 3 — footer 「回复编号或名字进入。」; the user then replies 1 and the agent sends the 【QQ 会话】 conversation list">

**Entering a folder only moves where you are browsing, not which conversation you are bound to** —
to actually switch you still pick a conversation inside it.

**A bare digit *is* `/switch <digit>`**: with the list on screen there is no need to type `/switch`,
just reply `2` — and it **tells you which one you landed on**, short id included, so you can check it
against the row you meant:

<img src="docs/images/switch-session.jpg" width="320" alt="With the conversation list on screen the user replies with a bare 2, and the agent answers 「已切换到「你好」。4b55e1」 (switched to 「你好」, 4b55e1)">

★ **Quoting freezes the numbering**: long-press **the list message** and quote it before replying
with a number, and the number is read as **that screen** printed it. Sessions running while you read
cannot make you land on the wrong one — the numbering is frozen inside that message. The list footer
says so itself: 「引用这条消息再回编号，可以避免编号过期。」

**Plain language works too.** Here the user sends 「查看所有会话」 (show all conversations) — not a
command:

<img src="docs/images/natural-language.jpg" width="320" alt="Having earlier replied 2 to switch, the user now sends the plain-language 「查看所有会话」; instead of an error the agent sends the session-folder list plus 「已列出，请看上面的会话列表。回复对应编号即可切换，回复「查看其余」看下一页。」">

The agent judges **intent** rather than matching fixed rules: it recognised "list conversations",
listed the session folders, and told you that a number switches and 「查看其余」 turns the page.
A switch also reports whether it succeeded or failed.

Type these to control which DSH conversation you are talking to:

| Command | What it does |
|---|---|
| `/new [title]` | Start a fresh conversation. Anything after it becomes the title: `/new 修复登录` starts a conversation called 「修复登录」 |
| `/list` | Go straight to this workspace's conversations (ten per screen) |
| `/list all` | List the **session folders** (workspaces) on this machine, one per line with its conversation count; reply with a number or a name to enter |
| `/switch 3` | Move to the 3rd row **of that screen** |
| `/switch e716f0` | Move by the **short id at the end of the row** — unrelated to numbering, and it never expires |
| Reply 「查看其余」 | Walk down ten rows (both levels, all the way to the end). Numbering runs on across screens (1–10, then 11–20) |
| Reply `3`, a name, or a trailing id | No need to type `/switch` while the list is on screen |
| Quote a list message → `/switch 3` | Numbered by **that screen**; the numbering is frozen inside that message |
| `/model` | Which models there are, and each one's **reasoning levels**, with the one in use marked |
| `/model 2` | Switch to the 2nd one; a model name works too |
| `/model 等级 high` | Change the reasoning level of the current model (the level names are the ones the list prints) |
| `/model 2 等级 high` | Change the model and the level together |
| `/current` | Which conversation you are in |
| `/cancel` | Stop the task that is running |
| `/help` | This list |

**Spaces are optional**: `/switch3`, `/switch 3` and `/switch:3` all work — these commands get typed
on a phone keyboard, where a dropped space is normal. A word that merely *starts* with a command is
not one, so `/news` is not `/new`.

**Numbering expires**: sessions run while you are reading the list, so by the time you reply "3" the
3rd row may be someone else. Every row therefore ends with a short id of **at most 6 characters** —
reply with that, or **quote that screen's list message** and the number is read as that message
printed it.

**The list has two levels, ten rows per screen**: `/list` opens this workspace's conversations;
`/list all` lists the **session folders** (workspaces), which you enter by number or name. Both
levels walk down ten rows with 「查看其余」, and **numbering runs on across screens**. When you reach
the end it says so instead of inviting you to keep going. **Entering a folder only moves where you
are browsing, not which conversation you are bound to** — to actually switch you still pick a
conversation inside it.

### Models and reasoning levels

`/model` lists which models there are (marked 「（当前）」/「（默认）」 — current / default) and each
one's reasoning levels. `/model <name|number>` switches model; `/model 等级 high` changes only the
reasoning level; `/model 2 等级 high` changes both. **A switch takes effect from the next step.**

> **Reasoning levels come from the host adapter.** The bundled DeepSeek adapter publishes
> `off` / `low` / `high` / `max` (printed as `Off` / `Low` / `High` / `Max`), and those are the names
> `/model 等级` accepts, case-insensitively. There is no separate Chinese spelling — the level names
> are the ones the list prints, exactly as the WeChat channel does it.

**Plain language works here too** — "switch to the other one", "what conversations do I have", "stop".
The agent judges the intent rather than matching fixed rules, and a switch tells you whether it
succeeded or failed.

### Media in both directions: images, video, voice, files

**In:** send the agent an **image / video / voice message / file** from your phone. **Voice is
transcribed server-side** and you never see that step. Document attachments (Word, Excel) are
readable too.

Here is a photo of a dog sent in, with a single question — "what is this":

<img src="docs/images/read-image.jpg" width="320" alt="The user sends a photo of a small dog into the QQ chat and asks only 「这是什么」 (what is this); the agent answers 「一只小狗的照片 🐶」 and lists the white long coat with a tuft of black on the head and ears looking like a border-collie mix, the big eyes staring at the lens with a very innocent expression, the pale tiled floor with a yellow-bodied orange-beaked duck toy, and notes that the photo is sideways because the phone was held the wrong way round">

What is worth noticing is not that it recognised a dog but the two details **only someone who really
looked at the image could give**: the yellow-bodied orange-beaked duck toy, the person's legs at the
left edge of the frame, and its unprompted remark that **the photo is sideways** (the phone was held
the wrong way round).

Now a PDF sent in, again with a single question — "what is this":

<img src="docs/images/receive-file.jpg" width="320" alt="The user sends 「视觉组预训练文档.pdf」 (387.89KB) into the QQ chat and asks 「这是什么？」; the agent answers that it is a vision-group pre-training / recruitment task document from the Zhuyan team dated September 2026, five pages, exported from MarkText, and summarises it under three headings: environment setup, AI plus engineering discipline, and four traditional OpenCV tasks">

**Document attachments are read too**: it says this is a five-page recruitment task document,
exported from MarkText, and summarises it as "Part 1 environment setup / Part 2 using AI plus
engineering discipline / Part 3 traditional OpenCV, four tasks".

**Out:** the agent sends files from this computer to your phone with `send_to_qq` — **images arrive
as photos, videos as playable clips**, everything else as a file attachment:

<img src="docs/images/send-image.jpg" width="320" alt="The user says 「把我电脑上桌面那张 DSH 自画像发过来」 in QQ; the agent first replies with the filename 「桌面上的 DSH 自画像.png」, then the image itself appears in the chat, and finally it confirms 「已发送 ✅ 桌面上的「DSH 自画像.png」（29 KB，PNG）。」">

This is the story the cover image at the top of the page tells, and it is a complete **pickup**:
say which file you mean, the agent finds it on the computer and sends it back, and it **confirms with
the filename and size** so you can see at a glance whether it sent the one you meant.

★ **A reply that runs long is turned into a `.md` file** and sent to your phone (4000 characters by
default, adjustable; `0` = no limit):

<img src="docs/images/long-reply-file.jpg" width="320" alt="The user says 「把这个 QQ 插件项目 read me 完整读一遍，写一份详细的中文导读」; the agent replies 「dsh-qq-plugin README 中文导读（完整版）」 with a 20.33KB .md attachment and adds that it read the whole 377-line README and sent the guide as a **.md file** because it is easier to read on a phone than a long message">

Something that would not fit on one phone screen is far more usable as a file — **not truncated**,
and not split into a dozen messages that flood the chat. The threshold is the settings page's
"单条回复字数上限" (per-reply character limit).

**Voice**: hold to talk on the phone and the agent receives text (**transcribed server-side**, with
nothing extra for you to do):

<img src="docs/images/voice-message.jpg" width="320" alt="A three-second voice bubble in the QQ chat, immediately followed by the agent giving tonight's and tomorrow's Beijing weather: tonight clear 8°C, sunset 17:39; tomorrow cloudy with a high of 21°C, sunrise 6:22, plus a warning that the temperature has dropped sharply and the cold index is very high, and a note about Indonesian haze and PSI levels">

Under that 3-second voice bubble in the screenshot is a complete weather answer — **the middle step,
turning speech into text, is invisible on your phone**, and does not need to be visible.

### Interaction

These three have **no screenshots** — they are a question and an answer inside the same conversation,
so a picture of one would look much like the ones above; prose says it better. This is what arrives
on your phone:

- **Permission approvals**: when the agent wants to touch your files, a pending request appears in
  QQ saying what it intends to do. Reply **「允许」** (allow), **「拒绝」** (deny), or a **numbered
  option** — all three answer it, and the task carries on. (For such a prompt to appear at all, the
  permission preset has to be one of the two that can show prompts — see [Settings](#settings).)
- **Either/or and multiple-choice questions**: the agent's question arrives **with numbered options**,
  and a single digit answers it.
- **Quoting as context**: long-press and quote one of its answers before speaking — for example
  "**expand the second point** in this one" — and it knows which answer "this one" is and which point
  "the second" is.

### Proactivity: tell me when it is done

★★ **`notify_qq`**: **any session** on this machine can push a message to you — that is what "tell me
when it is done" is built on. On the left is the **desktop** session doing the work; on the right is
what arrives on **mobile QQ**:

<img src="docs/images/push-desktop.png" width="720" alt="The DSH desktop app: the user asked 「从网上找几篇写秋天的诗歌，写完发我 qq」 (find a few autumn poems online and send them to my QQ when done); the session shows 「已完成，用时 3 分 24 秒」 (done, took 3m24s), the answer explains it searched public web pages, checked each poem and compiled them into a file which it sent to QQ as DOCX and PDF, and below is a table of the 13 poems with number, work and author">

<img src="docs/images/push-qq.jpg" width="320" alt="The same result on mobile QQ: first 「秋天的诗给你整理好了：13 首（唐宋诗词·元曲·清词·济慈《秋颂》），每首附一句品读，来源逐首核对过。文件：秋日诗歌选.docx」, then the docx and pdf attachments, with a line in between explaining that a PDF version was added so it can be opened directly on the phone, with source links on the last page">

**Note that the two sides are not the same session**: the work was done by that desktop session, and
the message arrived in the QQ conversation you are bound to. That is exactly why
`allowCrossSessionNotify` is on by default — without it, the session doing the work could not report
its own result.

**It works in practice**: a ten-message burst was delivered in full, and **the last six of those went
out as proactive pushes**. (Tencent's rules for unsolicited sends can change and **the plugin assumes
no quota**; anything undelivered is queued and flushed the next time you speak.)

**Scheduled tasks** run through the DSH host's own `schedule_create / schedule_list /
schedule_delete / schedule_update` — the plugin does not reimplement what DSH already has, it is only
the channel. Plain language is enough:

<img src="docs/images/schedule-1.jpg" width="720" alt="In the QQ chat the user says 「我去眯一会儿，23:12 叫我」 (I'm going to doze off, wake me at 23:12); the agent answers 「好，定好了 ⏰ **23:12** 喊你（后台定时已启动）。眯着吧，到点我发 QQ 消息叫你 😴」 (done, set for 23:12, the timer is running in the background; doze off, I'll message you on QQ when it is time)">

When the time comes it really does push one over (this is a **proactive push**, not you asking):

<img src="docs/images/schedule-2.jpg" width="720" alt="A QQ notification on the phone's lock screen: the app icon next to the name Deepseek, reading 「⏰ 23:12 到点了，该起了！」 (it is 23:12, time to get up), with 23:12 in the status bar">

"Remind me every morning at 9 what I have to do today", "send me the current time every hour",
"show me which scheduled tasks I have" all belong here. *Showing* them is `schedule_list`, and so are
deleting and changing them.

### Reliability

- **A session that is archived or disappears is re-bound automatically**, with a line telling you so
  rather than the message being swallowed: the old conversation was archived → a new one is created
  to carry on, and you are notified.
- State writes on Windows have **retries and backoff** (for the "file is in use" kind of EPERM).
- Inbound messages with empty content or an unknown frame type **leave a log line** instead of leaving
  no trace at all.

### Tools the agent can use

| Tool | What it does |
|---|---|
| `send_to_qq` | Send a file from this machine to **the conversation that asked**. Images arrive as photos, videos as playable clips, everything else as a file attachment |
| `notify_qq` | Push to your current QQ conversation from **any session**. This is what "tell me when it is done" is built on, and it works in practice (a ten-message burst arrived in full; the last six were proactive pushes) |
| `qq_session_control` | Look at, switch, create or interrupt conversations; list (or switch) models and their reasoning levels |

> The `qq_` / `_qq` in those names is deliberate: **tool names are unique across the whole host
> scope**, and the WeChat plugin already occupies `session_control`. Two plugins claiming the same
> name means whichever registers second fails silently.

**Those three come from the plugin.** Scheduling is not among them because it does not need the
plugin to implement anything: it runs through the DSH host's own `schedule_create` /
`schedule_list` / `schedule_delete` / `schedule_update`, and the plugin's part is only to carry the
result over the QQ channel.

### Settings

**Settings → QQ**, in six groups, in the order the page renders them:

- **帮助 (Help)** — the one button on the page that opens the user handbook
  (`docs/HANDBOOK-USER.md`, the file that lists every command and every setting)
- **连接 (Connection)** — channel on/off, the QR bind, the bound account, unbind
- **权限 (Permissions)** — the permission preset for QQ conversations (only `auto` and
  «Follow the DSH setting, same as the desktop» can still show approval prompts)
- **行为设置 (Behaviour)** — the table below
- **指令 (Commands)** — the slash-command reference the page prints (`/help`, `/new`, `/list`,
  `/switch`, `/current`, `/cancel`, `/model`)
- **诊断 (Diagnostics)** — log tail, workspace path, conversation count, pending interactions

This is the page in full (the ones below are the same page section by section):

<img src="docs/images/settings.png" width="620" alt="The 「QQ 遥控」 settings page in full: under the heading it says 「用手机 QQ 遥控这台电脑。扫码绑定一次，之后一直有效。」; top right has 「打开配置文件」 and a close button; the page runs through 「帮助」 (a 使用手册 card with an 打开使用手册 button), 「连接」 (通道状态 toggle, 已绑定账号 1905760478 ← E56C740FF85C1B60D50920D33D5181F3 · 2026-10-10T10:46:05.061Z with an 已连接 tag and a 断开连接 button, then a 扫码绑定 card with a 重新扫码 button) and 「权限」 (QQ 对话的权限预设)">

These are the top two cards — and the first thing you see **after installing it** — 帮助 (Help) and
连接 (Connection):

<img src="docs/images/settings-a.png" width="620" alt="The top of the QQ 遥控 settings page: under 「帮助」 a 使用手册 card with an 打开使用手册 button; under 「连接」 a 通道状态 toggle, 已绑定账号 showing 1905760478 ← E56C740FF85C1B60D50920D33D5181F3 with 2026-10-10T10:46:05.061Z, an 已连接 green tag and a 断开连接 button, and a 扫码绑定 card with a 重新扫码 button">

**The QR bind** is in the lower half of that shot: click 重新扫码, scan with mobile QQ and confirm on
the phone. **You do not have to register on Tencent's open platform first**, and you do not need an
AppID/AppSecret — the bot application is created by that scan. The 已绑定账号 row is what it looks
like once bound (AppID ← an irreversible fingerprint · bind time), and 已连接 beside it is the
channel's state right now.

The middle two groups are **permissions** and the **command reference**:

<img src="docs/images/settings-e.png" width="620" alt="The 「权限」 and 「行为」 groups of the settings page: the 「QQ 对话的权限预设」 dropdown is set to 「完全访问：不询问，直接执行」; below it 「行为设置」 has a 「允许其他会话推送到 QQ」 toggle, a 「会话操作先确认」 toggle, 「附件合并窗口（毫秒）」 set to 10000, and a 「等不到文字就自动处理附件」 toggle">

**The permission preset has three Chinese options**, with the default selected in the shot:

| Option | Meaning |
|---|---|
| `完全访问：不询问，直接执行` — full access, do not ask | The default. The agent does not ask you — and an ask would go to QQ, where the task then waits for your answer |
| `自动审核：电脑上判断` — automatic review, judged on the computer | Let the policy on the computer decide; prompts are possible |
| `跟随 DSH 设置：和桌面端一样` — follow the DSH setting, same as the desktop | Exactly what the desktop does; prompts are possible |

Only the last two **can still send a permission prompt to QQ**. To see for yourself that an approval
can flow back to a phone, set this to one of the presets that can prompt — a pending request then
arrives in QQ, and **「允许」/「拒绝」 or a numbered option** answers it.

<img src="docs/images/settings-b.png" width="620" alt="The 「指令」 group of the settings page: a 「斜杠指令」 table listing /help, /new [标题], /list, /switch <编号>, /model [名字], /current, /cancel with their descriptions, footer 「分隔符可用「:」或直接省略，例如 /switch1。」; below it a 「说大白话也可以」 paragraph saying that plain 「换个对话」「看下有哪些对话」「停一下」 all work">

That group is `/help` as the page prints it, and **the user handbook is what every command and
setting is measured against**. The line underneath — that plain language works too — is also true:
DSH first says what it is about to do and waits for you to agree; turn off 「会话操作先确认」 above to
skip that step.

Lower on the page, the behaviour settings and the session folder:

<img src="docs/images/settings-d.png" width="620" alt="The lower half of the settings page: 「单条回复字数上限」 set to 4000 with the note 「超过就作为 .md 文件发送，不截断。填 0 表示不限制。」; 「回复聚合静默窗口（毫秒）」 set to 1200; 「渠道上下文说明」 is a text box reading 「[渠道：QQ] 你在和 QQ 上的用户对话…」; 「会话文件夹路径」 has an input with a 「选择…」 button beside it and 「当前生效：C:\Users\XCISXC\.dsh\dsh_qq」; at the bottom 「保存设置」 and 「恢复默认」">

**The session folder** setting has a **native folder picker** — the 选择… button. The box holds the
text **you typed** and 当前生效 to its right is the path **actually in use**; keeping the two apart is
deliberate, so that when a path is wrong you can see what you wrote and change it while still knowing
which folder is really being used.

Last is the **diagnostics** block, your first clue when something goes wrong:

<img src="docs/images/settings-c.png" width="620" alt="The 「诊断」 group of the settings page: 日志文件 C:\Users\XCISXC\.dsh\qq\boot.log, 会话工作目录 C:\Users\XCISXC\.dsh\dsh_qq, 对话数 1, 待回答交互 0, 被动回复限流 4 次／1 小时; below, 「日志末尾」 is a scrollable log box with lines such as sdk info [qqbot:api] <<< Status: 200 OK and TraceId, ending with send_to_qq: path=…DSH 自画像.png -> 文本已发送；已发送图片 DSH 自画像.png">

Diagnostics gives you **the log path plus the tail of the log**, so most problems you can **see for
yourself** — whether a send failed, whether you were rate-limited, whether an attachment never
landed. The last line in the shot happens to be a successful `send_to_qq`.

Adding those cards up, there are nine settings in total:

| Setting | Default | What it does |
|---|---|---|
| `permissionPreset` | `danger-full-access` | Permission preset for QQ conversations. A permission prompt that arrives on a phone stalls the task until you answer it, so the default keeps the gate open — see [Security](#security) |
| `requireConfirmation` | on | Whether the agent asks you once before it performs a conversation operation |
| `allowCrossSessionNotify` | on | Turn it off and `notify_qq` may only push to the caller's own conversation (the stricter posture) |
| `mergeWindowMs` | 10000 | How long an attachment-only message waits for you to add an instruction. **0 = do not wait** |
| `autoReplyAttachments` | on | Whether the attachments are handed to the agent when no instruction arrives inside that window. Off does **not** mean "ignore the attachments" — it means "wait for the user to say something" |
| `maxReplyChars` | 4000 | Above this, the reply is sent as a `.md` file. **0 = no limit** |
| `settleMs` | 1200 | How long the stream must go quiet before the reply is sent |
| `presenceNote` | a short Chinese note | Sent to the agent with every message: you are on a phone, you cannot see this computer's screen, and if it wants you to look at something it should just send it |
| `workspacePath` | empty = `$DSH_HOME\dsh_qq` | The conversation folder. **Must be an absolute path**; a bad value only means "did not take effect", never "the plugin will not start" |

Settings are **persisted** and survive a restart. An older state file (one with no `settings`
block) still reads fine.

Every setting is defined in exactly one place — `lib/settings.js`'s `SETTINGS_SCHEMA`, one
validator plus one `default` per entry. Loading, saving, the settings page and the round-trip test
are all derived from it, so adding a setting is one line there and nothing else can drift out of
step. Plain JavaScript has no compiler to catch a forgotten setting, so
`scripts/verify.mjs` asserts that the schema's key set, the key set the runtime actually holds, and
the key set written to disk are the same set — that assertion is the compiler we do not have.

Next to `workspacePath`, the **currently in effect** line shows the path actually in use, while the
box holds the text you typed. Keeping the two apart is deliberate: when a path is wrong you can see
what you wrote and change it, while still knowing which folder is really being used.

> ⚠️ **Changing the path does not move existing conversations.** They stay in the old folder; only
> conversations created afterwards use the new path. That is the only safe behaviour — the host
> compares `cwd` when it adopts an existing conversation, and a mismatch raises
> `ApiSessionCwdConflict`, after which that conversation can never be picked up again.

### Where files land

| What | Path |
|---|---|
| Conversation workspace (shown in the desktop app as 「QQ 会话」) | `$DSH_HOME\dsh_qq` (changeable with `workspacePath`) |
| Inbound media and long replies as `.md` | `<conversation workspace>\媒体` |
| Plugin state and log | `$DSH_HOME\qq\state.json`, `$DSH_HOME\qq\boot.log` |

### If something does not work

| Symptom | Where to look first |
|---|---|
| No QQ block in the settings page | The client plugin did not load. Look at the **renderer console** section of `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log` |
| The whole app will not start | Same file. The fatal error itself says very little; the real cause is in the renderer console |
| The bot does not reply | `boot.log` for `入站`; the `errors` array of `GET /.dsh-qq-plugin/status` |
| Images or voice do nothing | `boot.log` for `附件下载失败` or `附件已停靠` |
| "It will not send" | `boot.log` for `待发已入队` — proactive-push rules can change and the plugin assumes no quota; anything undelivered is flushed the next time you speak |

The debugging HTTP endpoints all live under `/.dsh-qq-plugin/`: `status`, `log`, `settings`,
`permission-presets`, `accounts`, `login`, `start`, `stop` and a few more.

### Differences from the WeChat version

Feature-aligned, but a few things differ **on purpose**, because the QQ protocol hands us something
the WeChat one does not:

| | |
|---|---|
| Quoted messages | QQ's `msg_elements` **carry the quoted text directly**, so WeChat's `quoteHistory` cache is not needed |
| Voice | The QQ service returns `voice_wav_url` plus `asr_refer_text`, so there is **no SILK decoding** step and none of its caveats |
| Send queue | WeChat has to queue because iLink forbids unsolicited sends; QQ allows proactive push, and the queue exists to **re-send anything that was not delivered** (network, platform rejection, changed rules) rather than to cover one specific failure |
| Tool names | See above — global uniqueness across the host scope |
| Installation | There is no build step and no `allowBuilds` prompt: the plugin is plain JavaScript, so a Git install packs and runs it as-is |

## Security

**Only you can reach it.** The channel talks to Tencent's official QQ bot service and nothing else —
no third-party service, no self-hosted relay in the middle. The bot is a **separate application**
whose administrator is your QQ account, and it was created by your own scan; an uncertified bot is
limited to its administrator. It is not a QQ contact you can hand out: nothing searches for it and
nobody can add it. There is no "someone else could message it" surface, which is why no allowlist
exists: the platform's own rules already are one.

**The AppSecret is a long-lived key, and it is treated as one.** It is written to DSH's credential
store as a `grant` record rather than into the plugin's plaintext state file, which keeps only the
AppID. Rotating it means binding again from the settings page.

Three things are still true and worth knowing:

**Conversations from QQ run with full permissions by default** — the agent does not ask before it
acts. That is deliberate: a permission prompt is delivered to QQ and the task then waits there, so
on a phone every command would stall until you answered a conversation you had walked away from. Set
**Permission preset for QQ conversations** to `auto` (or to the profile's own policy) in the settings
page if you want the same guardrails you have at the desk.

**The agent runs as you.** It can execute commands and read and write files, with your user's
permissions — that is what it is for, and it means anything you can do on this machine, it can do.
So: skim what you asked for before walking away, and **lock the screen** when you leave. Locking does
not stop the agent, and it keeps anyone passing by out of your desktop.

**Any session on this machine can push to your QQ by default.** That is what makes "tell me when it
is done" work: the session doing the work is usually not the one your QQ conversation is bound to,
and without this it could not report its own result. Turn off **allowCrossSessionNotify** to restore
the stricter rule, where only the bound session may send.

## Documentation

| | |
|---|---|
| [docs/HANDBOOK-USER.md](docs/HANDBOOK-USER.md) | The user handbook — what the page's one help button opens, and the file that lists every command and every setting (Chinese) |
| [docs/POSTMORTEM.md](docs/POSTMORTEM.md) | Every real failure met while building this — each one cost something, and each one is why a checker exists (Chinese) |
| [docs/SETTINGS-CONTRACT.md](docs/SETTINGS-CONTRACT.md) | The host/client route contract behind the settings page, read off the actual call sites (Chinese) |
| [docs/RELEASING.md](docs/RELEASING.md) | How a version gets published: the tag, OIDC, and the one-time Trusted Publisher setup (Chinese) |
| [docs/STEP3-能力调研与实现规格.md](docs/STEP3-能力调研与实现规格.md) | QQ interactive-message and streaming research. **Status: paused, not implemented** — no buttons and no streaming exist in this code today; the measurements are real and are kept for whenever that work resumes (Chinese) |

## Development

Plain JavaScript, no build step, no transpiler. CI runs Node 24; the manifest declares no `engines`
range, because the plugin only has to run inside the DSH host that is already there.

```bash
npm ci

node scripts/verify.mjs          # host side
node scripts/verify-client.mjs   # client registration shape (not a visual check)
node scripts/verify-send-path.mjs  # the send path, against a fake SDK
```

**822** host checks, **108** client checks, **60** send-path checks.

Those three numbers are **read out of the runs above, not typed by hand**: `tools/check-doc-counts.mjs`
compares them against what the scripts actually print, and the CI job fails naming the file if any of
them disagrees. Change a test and the number here, or the gate stops the build.

### Standing checkers

Four checkers live in `tools/`. Each one corresponds to a real incident, so run them before
committing:

```bash
node tools/check-unbound.mjs .          # used but never imported
node tools/check-unused-imports.mjs .   # imported but never used
node tools/check-doc-counts.mjs --run   # the documented counts, and the repository name in publish.yml
node tools/check-cross-plugin.mjs <profileDir>   # shared resources across plugins
```

`check-doc-counts.mjs` reads the three numbers out of the **actual output** of the three suites and
compares them against this file, `README.zh.md` and `docs/RELEASING.md`, naming the file, the number
written and the number measured when they disagree. In CI it reads the output the three test steps
captured, so it costs a second rather than a second full run. `--run` is the local form: it runs the
suites once itself.

It carries a second job, for the same reason: the four Trusted Publisher fields in
`publish.yml`'s header are typed by hand and a typo in them shows up as **a 403 at publish time and
as nothing else**, so the checker compares that block against `package.json` (organization and
repository), the workflow's own filename and its `name:`, and both READMEs' CI badges. The
repository it names was once `dsh-qq` while every other copy said `dsh-qq-plugin` — that is the
failure this half exists to catch.

`check-cross-plugin.mjs` is a **local check and does not run in CI**: it reads a real DSH profile —
the `dsh.profile.bundles` list and the plugins installed under that profile's `node_modules` — and a
CI runner has neither. It checks the two things every plugin shares: the client plugin **top-level
scope** (the shell concatenates every enabled `client.js` into one script, so a top-level `const` in
one plugin collides with another's) and **host tool names**, which are globally unique.

**Each checker carries a reverse control**: it has to catch the failure it was written for, or it is
declared untrustworthy and exits non-zero. A checker that always prints "pass" is worse than no
checker at all — it makes people believe something was verified.

Two probes under `smoke/` (`step3-probe.mjs` and `step4-probe.mjs`) talk to Tencent's live service
and need real bot credentials; the other two (`step4-surface.mjs` and `check-sdk-surface.mjs`) are
offline surface checks that need neither credentials nor a network. None of the four is **in CI** —
the two probes because credentials do not belong in a public repository's CI, the two surface
checks because they are one-off research probes that print observations rather than assert
pass/fail.

## Licence

MIT — see [LICENSE](LICENSE).
