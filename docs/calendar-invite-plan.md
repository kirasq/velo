# Velo 会议邀请（邮件 → 日历）能力改造方案

> 目标：让 Velo 收到带 `.ics` / `text/calendar; method=REQUEST` 的会议邮件时，能**提取 → 解析 → 显示邀请卡片 → 一键接受（写本地日历 / 可选回写 CalDAV）**。
>
> 调研日期：2026-08-25｜基于 velo-src 当前代码（v0.4.32）

---

## 1. 现状结论（先纠偏）

本方案**不是从零做日历**。代码调研发现 Velo 已经具备：

- **CalDAV 同步前端基础设施**：`tsdav`（package.json）+ `src/services/calendar/caldavProvider.ts` + `calendar_events` / `calendars` 数据表 + `src/components/accounts/AddCalDavAccount.tsx` + `src/components/calendar/CalendarPage.tsx` 全套视图。
- **账户模型已为多协议预留**：`accounts` 表 v19 已有 `caldav_url / caldav_username / caldav_password / caldav_principal_url / caldav_home_url / calendar_provider` 字段。
- **ICS 基础解析器**：`src/services/calendar/icalHelper.ts` 的 `parseVEvent()` 已从 iCal 文本解析 `uid/summary/description/location/dtstart/dtend/status/organizer/attendees`。

**真正缺失的是一条端到端链路**：「邮件 → 抽取 `text/calendar` 部件 → 解析 → 显示邀请卡片 → RSVP 回写」。其中**最硬的工程堵点在 Rust 端**——见 §4 P0。

> 因此用户之前在 Apple Mail 看到 “Calendar is not configured”，本质是 Velo 侧**日历账户尚未添加**（对应 `cn.coremail.qingsund-a.mobileconfig` 里的 CalDAV 段），而非代码缺功能。AddCalDavAccount 已能处理该配置。

---

## 2. 目标范围（MVP 定义）

**MVP（本次必做）**
- IMAP 邮件中的会议邀请能被抓取、解析、在会话顶部显示卡片。
- 卡片提供「接受 / 暂定 / 拒绝」三按钮。
- 接受后事件写入本地 `calendar_events`，日历页可见；点击可跳转 `CalendarPage`。
- 覆盖 `text/calendar; method=REQUEST`（新增/更新邀请）与 `method=CANCEL`（取消）。

**P2（增强）**
- 「拒绝 / 暂定」生成 `method=REPLY` 邮件，经 SMTP 回复发件人（RSVP 回写）。
- `parseVEvent` 补全 `METHOD / RRULE / SEQUENCE / RECURRENCE-ID`，正确处理邀请的更新与取消。
- Gmail 账户路径同样打通（当前 Gmail 邮件邀请未被提取）。

**不做（本次）**
- 不把 CalDAV 同步下沉到 Rust 后端（当前前端 `tsdav` 直连可行，CSP `connect-src` 已放行）。
- 不做完整的 CalDAV 双向编辑（新建/改/删事件已是既有能力，不在本方案范围）。

---

## 3. 端到端链路

```
IMAP 邮件 (含 text/calendar; method=REQUEST 内嵌部件)
   │
   ▼  [Rust] src-tauri/src/imap/client.rs 附件循环 (当前漏抓)
   │        → 改为遍历 message.parts，把 text/calendar / application/ics
   │          作为「日历邀请附件」暴露，复用 build_imap_section_map 的 part_id
   ▼
前端 imapSync.ts 写库：attachments 表新增该部件
   │           (mime_type='text/calendar', 新增 is_calendar_invite 标志)
   ▼
[新增] src/services/calendar/inviteExtractor.ts
   │        → 取 text/calendar 原文 → icalHelper.parseVEvent() → 结构化邀请对象
   ▼
[新增] src/components/email/MeetingInviteCard.tsx
   │        → 会话顶部渲染：主题/时间/地点/组织者/与会者 + 接受/暂定/拒绝
   ▼
按钮点击 →
   ├─ 接受：upsert 进 calendar_events (source='email_invite', message_id 关联)
   │         → 跳转 CalendarPage
   └─ [P2] 拒绝/暂定：inviteService.respondToInvite()
            → 生成 method=REPLY 的 ITIP 邮件 → smtp_send_email 回复发件人
```

---

## 4. 分阶段改造

### P0 — 打通 Rust 端抓取 `text/calendar` 部件（最关键，必须先做）

**文件**：`src-tauri/src/imap/client.rs`（附件循环约 1669–1708 行）

**问题**：当前附件集合来自 `message.attachments()`，而 `mail-parser` 的 `attachments()` 只返回非 `text/*` 或显式 `Content-Disposition: attachment` 的部件。会议邀请几乎总是以 **`text/calendar; method=REQUEST` 内嵌部件**（无 attachment disposition）发送，因此被漏掉，前端拿不到、也无法用 `imap_fetch_attachment` 取内容。

**改法**：
1. 将附件枚举从 `message.attachments()` 改为**遍历 `message.parts`**，对所有 MIME part 判断：
   - `mime_type ∈ { 'text/calendar', 'application/ics', 'application/vnd.icalendar' }`
   - 或 `Content-Disposition: attachment` 且文件名以 `.ics` 结尾
2. 命中上述条件的部件，构造 `ImapAttachment` 时：
   - 复用 `build_imap_section_map` 已生成的 section 路径作为 `part_id`（确保 `imap_fetch_attachment` 能按 `part_id` 取原文）；
   - 新增字段 `is_calendar_invite: bool`（在 `src-tauri/src/imap/types.rs` 的 `ImapAttachment` 结构体加一列，并同步 `imapSync.ts` 的接口与 `tauriCommands.ts` 的 `ImapAttachment` 接口）；
   - 仍保留 `content_id` / `content_location` / `is_inline` 等既有字段，避免影响内联图逻辑（v0.4.31/32 已修）。
3. 对应 `src/services/db/migrations.ts` 的 `attachments` 表新增 `is_calendar_invite` 列（新增迁移版本，如 v26）。

**验证点**：用一封真实会议邮件（Foxmail/Apple Mail 导出 `.eml`），后端能返回带 `is_calendar_invite=true` 的附件，`imap_fetch_attachment` 能取到 ICS 原文。

---

### P1 — 前端解析 + 卡片 + 落库

#### 1.1 邀请提取服务（新增）
**文件**：`src/services/calendar/inviteExtractor.ts`
- 输入：`ImapMessage` / Gmail 消息 + 其 `text/calendar` 附件原文；
- 调用既有 `icalHelper.parseVEvent()` 产出结构化对象；
- 输出：`CalendarInvite { uid, method, summary, description, location, start, end, isAllDay, organizer, attendees[], icalRaw, messageId, threadId }`；
- 对 `method=CANCEL` 标记为取消，对重复 `uid` 以 `SEQUENCE` 取最新（P2 补全 SEQUENCE 解析）。

#### 1.2 邀请卡片组件（新增）
**文件**：`src/components/email/MeetingInviteCard.tsx`
- 渲染位置：会话（`ThreadView` / `ReadingPane`）顶部，或在 `AttachmentList` 中把 `text/calendar` 附件渲染成邀请卡片（二选一，建议顶部更醒目）；
- 展示：主题、起止时间（本地时区格式化）、地点、组织者、与会者列表；
- 操作按钮：接受 / 暂定 / 拒绝；
- 三种状态视觉区分（已接受显示为已加入日历）。

#### 1.3 数据模型（新增/扩展）
**文件**：`src/services/db/migrations.ts`（新增 v26）+ `src/services/db/calendarEvents.ts`

建议新增专用表 `calendar_invites`（避免污染既有 `calendar_events` 的唯一键语义）：

```sql
CREATE TABLE calendar_invites (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  message_id TEXT,
  thread_id TEXT,
  uid TEXT NOT NULL,          -- iCal UID（业务主键）
  method TEXT,                -- REQUEST / REPLY / CANCEL
  summary TEXT,
  description TEXT,
  location TEXT,
  start_time TEXT,
  end_time TEXT,
  is_all_day INTEGER DEFAULT 0,
  organizer_email TEXT,
  attendees_json TEXT,
  ical_data TEXT,
  rsvp_status TEXT DEFAULT 'needs-action',  -- accepted/tentative/declined/needs-action
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(account_id, uid, method)
);
```

接受邀请时：①upsert `calendar_invites`（`rsvp_status='accepted'`）；②复用 `CalendarPage.upsertCalendarEventFromProvider`（`CalendarPage.tsx:375`）把事件写入 `calendar_events`（`source='email_invite'`，带 `message_id` 关联）。

---

### P2 — RSVP 回写 + 解析增强

#### 2.1 RSVP 能力（新增方法）
**文件**：`src/services/calendar/types.ts`（`CalendarProvider` 接口 54–68 行）+ `caldavProvider.ts` / 新增 `inviteService.ts`
- 新增 `respondToInvite(uid, attendeeEmail, response)`；
- 实现：基于原始 ICS 生成 `text/calendar; method=REPLY` 的 ITIP 回复（复用并扩展 `icalHelper.generateVEvent`），经既有 `smtp_send_email` 命令（`commands.rs:295`，前端封装 `smtpSendEmail` `tauriCommands.ts:328`）回复发件人；
- 无需新增 Rust 命令。

#### 2.2 `parseVEvent` 补全
**文件**：`src/services/calendar/icalHelper.ts`（56–143 行）
- 补全 `METHOD`、`RRULE`、`SEQUENCE`、`RECURRENCE-ID` 解析，支持邀请的「更新」（同 uid 高 SEQUENCE 覆盖）与「取消」（method=CANCEL 标记删除）。

#### 2.3 Gmail 路径
**文件**：`src/services/gmail/client.ts` / `messageParser.ts`
- 同 P0 思路，从 Gmail 附件 / `payload.parts` 提取 `text/calendar` 部件，接入 `inviteExtractor`。

---

### P3（可选）— CalDAV 同步下沉后端
当前 `tsdav` 前端直连 CalDAV 服务器，CSP `connect-src` 已放行，短期无碍。若后续要统一后台同步 / 离线，可在 `src-tauri/src/commands.rs` + `Cargo.toml` 引入 `tsdav` 等效 Rust 库新增 CalDAV 命令。**非本次必须**。

---

## 5. 关键技术决策

| 决策点 | 建议 | 理由 |
|---|---|---|
| 邀请落库 | 新增 `calendar_invites` 表，而非扩展 `calendar_events` | 既有 `calendar_events` 唯一键 `(account_id, google_event_id)` 语义错位；邀请需 `method/message_id/rsvp_status` 等专属字段，独立表更清晰 |
| 抓取层 | Rust 遍历 `message.parts` 暴露 text/calendar | 前端无法绕过 `mail-parser` 的 attachments() 过滤；必须后端先暴露 part_id |
| RSVP 回写 | 生成 method=REPLY 邮件走 SMTP | ITIP 标准做法；复用既有 smtp_send_email，零新增命令 |
| CalDAV 同步 | 保持前端 tsdav 直连 | 已就绪，CSP 放行；下沉后端收益低、成本高 |
| 邀请更新/取消 | 以 uid + SEQUENCE 去重覆盖 | 标准 iCalendar 语义，避免重复/陈旧事件 |

---

## 6. 验证计划

1. **单元/集成**：用 `.eml` 样本（REQUEST / CANCEL / 带 RRULE）喂 `inviteExtractor` + `parseVEvent`，断言解析字段正确。
2. **Rust 抓取**：构造含内嵌 `text/calendar` 的测试邮件，验证 `imap_fetch_attachment` 能按 part_id 取原文且 `is_calendar_invite=true`。
3. **UI**：在 ThreadView 注入模拟邀请数据，验证 `MeetingInviteCard` 渲染与三按钮交互闭环。
4. **端到端**：用真实 isoftstone Coremail 账户（CalDAV `imail.isoftstone.com:443`）收一封会议邀请，验证「显示 → 接受 → 日历页出现 → 可跳转」。
5. **回归**：确认内联图（cid / Content-Location / 远程图床）逻辑未被 P0 改动破坏（v0.4.31/32 已修，P0 只增不改既有分支）。

---

## 7. 风险与注意

- **Rust 改动侵入性**：P0 改 `client.rs` 附件循环，需严格保留内联图既有路径（`content_id` / `content_location` / `is_inline`），避免回归 v0.4.31/32 修复的内联图问题。
- **邮件服务器内网限制**：isoftstone IMAP 收/发服务器为内网 IP `10.10.15.21`（明文 143/25），外网需 VPN；CalDAV `imail.isoftstone.com:443` 公网可用。测试端到端需在内网或 VPN 环境。
- **时区**：`dtstart/dtend` 可能带 `TZID` 或 `Z`，卡片展示必须本地化，避免时间错位。
- **重复邀请**：同一会议多次更新，必须以 `uid + SEQUENCE` 去重，否则日历页事件堆积。

---

## 8. 切入点速查（按优先级）

| 优先级 | 缺口 | 切入点 |
|---|---|---|
| P0 | Rust 漏抓 text/calendar | `src-tauri/src/imap/client.rs:1669-1708` + `types.rs` + 前端接口 |
| P0 | 邮件内无邀请解析/显示 | 新增 `inviteExtractor.ts` + `MeetingInviteCard.tsx` |
| P1 | 邀请无落库模型 | `migrations.ts` 新增 v26 + `calendarEvents.ts` |
| P1 | 无 RSVP | `types.ts:54-68` + `caldavProvider.ts` / `inviteService.ts` |
| P2 | parseVEvent 缺字段 | `icalHelper.ts:56-143` |
| P2 | Gmail 同样漏 | `src/services/gmail/*` |

---

*备注：本方案聚焦「邮件会议邀请解析显示」链路。CalDAV 日历同步能力已存在于代码中，用户只需在 Velo 设置中添加 CalDAV 账户（对应企业 mobileconfig 的 CalDAV 段）即可启用，无需代码改动。*
