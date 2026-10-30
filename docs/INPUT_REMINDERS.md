# 输入提醒 / Input reminders

Codex 发出需要选择或填写的结构化异步问题时，Monkex 在对应任务卡旁显示「需要你回复」提示，并在树或看板正上方使用独立悬浮气泡显示任务名与待答问题数。气泡使用浅叶绿圆润轮廓、深绿文字、连续小尾巴与香蕉黄「查看」文字按钮，整条气泡均可点击；小尾巴指向树，靠近屏幕顶部时自动放到下方，屏幕边缘会限制浮窗位置。树的悬停和拖拽继续保持原有行为。

- 点击气泡或右侧「查看」直接回到 Codex 原对话回答，无需先展开看板。打开失败时按钮显示「重试」。打开前重新核对同一回合的待答问题；已回答或已换回合的旧目标停止跳转。Monkex 保持只读观察，不提供代答、审批或自动继续操作；这次跳转保留未读结果和收蕉数。
- 气泡出现时轻弹一次，日常刷新保持静止；悬停时颜色轻微反馈，整条点击区域保持位置与尺寸。系统开启“减少动态”时关闭这些动效。
- 气泡宽度随当前可见任务的标题和状态文字调整，范围为 152–196px；短标题收紧中间留白，长标题保持最大展示空间。翻页后按当前页重新计算，普通刷新保持相同宽度。
- 每页最多三条紧凑提醒，新增任务稳定追加；多个问题合并到同一任务气泡，避免刷新时跳位。成功打开对话后自动收起这一条悬浮气泡；当前运行期间，同一回合、同一道问题的重复快照保持收起。待答目标变更、待答数量增加或新回合出现时再次提醒。跳转失败保留气泡供重试，断线或过期时暂时禁用跳转。
- 收起气泡只记录本机进程内的导航状态，最多保留 256 个问题标识，不写入账号或磁盘。任务卡仍显示真实待回复状态，直到收到匹配回答；重新启动 Monkex 会重新观察尚未回答的问题。
- 气泡跟随已观察到的提问与对应回复。工具返回“问题已发送”仍保持待答；部分回答只清除已回答的问题，同一回合继续执行也保留尚未回答的问题。
- 等待输入与运行状态分别表达。异步问题发出后，Codex 可能继续工作；健康详情将其显示为等待用户输入，公共连接评分与其他任务异常独立保留。
- 断线或观察不可用时显示待同步。普通文字里提到“请确认”、长时间无活动、Token 速率为零，都不会单独触发输入气泡。

## 支持与边界

当前支持已验证的本机 Codex 结构化异步问题记录（`request_user_input_async`）及其匹配回复。Monkex 通过现有有界 rollout 观察路径和已读取的当前回合补足提问，内存只保留问题标识、数量与时间；问题正文和答案不进入提醒元数据，不写入新的持久记录，也没有额外模型调用。

独立浮窗只接收进程内的任务标题、任务/回合/问题标识与数量，不额外读取模型或探测网络。Codex 当前公开的外部导航入口定位到对话，尚不传递具体问题锚点。若问题面板曾收起，进入对话后点击 Codex 自己的蓝色待输入提示展开；Monkex 不使用未公开的内部路由或系统模拟点击来代操作。

回合结束或新回合替代旧回合时清除旧提醒。超出有界历史窗口、未知记录格式或缺少提问身份的情况保持未确认。同步阻塞输入和审批尚缺可靠的跨客户端持久读取依据，第三方工具卡与登录弹窗也保留各自的覆盖边界；Codex 的记录格式变化可能需要适配。当前功能状态与公开安装包版本分别以源码和对应 Release 说明为准。

## English

A **Needs reply** label identifies a task with a structured async Codex question. An independent floating window above the tree or board shows each task title and pending-question count, with up to three bubbles per page and stable ordering. Its continuous tail points toward the tree; near the screen top it falls back below, with position clamped to the screen edges. A rounded leaf-green surface, deep-green text and compact banana-yellow **View** action follow the existing product palette. Each newly visible bubble enters once; routine polling stays still. Hover feedback preserves the full-row click area, and reduced-motion preferences disable animation. Tree hover and dragging keep their original behavior.

Window width follows the visible page's title and status text within 152–196px. Short labels keep the action close; long labels retain the maximum space. Page changes recalculate width, while unchanged polling keeps it stable.

Choose the bubble or **View** to open the original conversation without expanding the board. Fresh turn and question identities are verified before navigation; obsolete targets stop the jump. Successful navigation hides that floating bubble. Repeated snapshots of the same turn and question stay hidden during this app session. A changed pending target, increased pending count or new turn makes the reminder visible again. Navigation failures retain the bubble and show **Retry**, while stale observations disable navigation. Reminder navigation preserves unread results and harvest counts; Monkex never answers, approves or resumes work on your behalf.

Dismissal keeps up to 256 question identifiers in process memory and writes no account or disk state. The task card keeps its true pending status until a matching structured reply arrives. Restarting Monkex observes unanswered questions again. Tool acceptance means the question was sent; partial replies leave other questions pending, including while an asynchronous turn continues working.

The floating window receives only in-memory task titles, identifiers, counts and availability; it adds no model or network probes. Official external navigation targets conversations and exposes no individual-question anchor. Reopen a collapsed question panel through Codex's own blue input indicator. Monkex leaves private navigation routes and simulated system clicks unused.

Runtime health distinguishes user input from quiet execution. Public connection scores and unrelated task warnings retain their own meaning. Unavailable observations become pending sync. Plain-language requests, quiet periods and zero reported tokens alone never create a bubble.

Support covers verified local asynchronous question/reply records (`request_user_input_async`) within bounded runtime history, supplemented by already-read current-turn items. Only identifiers, counts and timestamps survive in memory; question text and answers are excluded from reminder metadata and persistent state. Ended or superseded turns clear obsolete reminders. Unknown formats, missing identities and records beyond the bounded tail remain unconfirmed. Synchronous blocking input and approvals still lack a verified persistent cross-client source; third-party cards and login dialogs retain separate coverage boundaries. No model calls are added.
