# 运行健康 / Runtime Health

展开任务看板，点击周额度左侧的线条表情。表情旁的 13px 数字常驻显示「公共连接质量」0–100 分，下方显示「极佳 / 流畅 / 平稳 / 波动 / 不稳」文字档位；独立小圆点表示任务等待、静默、待同步或明确错误。详情从表情下方弹出，箭头指向入口，展示当前档位含义与完整分数刻度。任务状态依据实际运行记录，公共接口高分仍保留静默、失联和错误提醒。数值只描述指定公开路径的响应质量；采样不足或过期显示「—」。点击外部、关闭按钮或按 Esc 收起。详细档位、权重、阈值和限制见[评分公式](HEALTH_SCORE.md)。表情随连接档位依次为大笑、笑脸、微笑、担忧、哭脸；未知或重测显示中性待机脸，分数、文字和独立任务提醒保持。此功能属于当前源码，公开安装包的可用功能以对应 Release 为准。

## 看什么

| 信号 | 含义与使用方式 |
| --- | --- |
| 实测出口 | 分数下方展示本次公共检测的出口地区。它描述检测路径，与 VPN 客户端所选线路及 Codex 实际请求路径分别理解；无法可靠读取的 VPN 连接名和线路名已移除。 |
| 任务状态与独立提示 | 近期任务有事件时为活跃；只有启动记录时为等待响应；任一任务长时间无事件时提示待确认；同步过期或观察不可用保持未知；当前回合最近 5 分钟的明确失败单独提示异常。提醒在顶部保留独立小圆点，点击查看具体状态。 |
| 最近活动、静默任务 | 来自本机结构化活动与用量报告；约 3 分钟未观察到新活动会提示静默。展开各任务信号看具体任务、最近阶段与上报时间。长思考、工具执行和日志延迟均可能出现静默。 |
| 总 Token / 输出 Token 每分钟 | 最近 60 秒累计报告的增量，起步不足一分钟时按已观测窗口折算。总量包含输入和缓存；输出包含推理。0 表示窗口内无新增报告，破折号表示尚无可用基线。两者都不等于模型逐字生成速度。 |
| 公共连接参照 / Codex / API / 登录 | 通过当前环境或系统代理，对固定公开端点发起小型 HTTPS 请求，记录至响应头返回的耗时，包含解析、连接和握手。Codex 和 API 端点的无凭据 401/405 属于预期响应。此数字衡量公共连接，不能代表模型请求排队或推理时间。 |
| 官方状态 | 读取 OpenAI 官方状态页，分开展示 Codex、Responses、Conversations 等组件及当前公告。公告是聚合状态，与某个任务是否受影响分别判断。 |

首次运行或「重新测当前节点」启动六轮短测，轮次间隔 3 秒，通常约 20–60 秒完成。切换节点后重新测会清空之前的链路样本；检测到公网出口变化时也会分开统计。相同公网出口下的节点切换需要手动重新测。运行任务存在时约每 60 秒补充一轮，保留最近 15 分钟的内存样本。用量和活动跟随既有任务同步，界面约每 5 秒读取快照。无需额外模型生成请求，也不会消耗重置卡。

## 如何判断

- 近期有活动、公共连接可达：观察到本机事件和公共连接响应；仍可在任务中检查具体进度。
- 单个任务静默、其他任务有活动：优先回到该任务确认长工具执行、思考、审批或重试情况。
- 参照可达、OpenAI 传输检测失败：检查通向 OpenAI 的网络／代理路径，切换后再次检测作对比。
- 两个传输检测均失败：检查当前网络、代理与 DNS，再次检测确认。
- HTTP 403、429、重定向或服务错误：连接已经建立，地址返回了限制或错误；详情保留状态码，避免误报断网。
- 官方公告异常：结合公告涉及的地区、服务和本机活动判断。正常状态页也无法排除个别请求异常。

连接超过 2.5 秒，或已有至少 3 个成功样本时超过近期中位数的 3 倍且超过 1 秒，会提示「较慢」。这些是检查线索，保留实际毫秒数；它们不是 Codex 性能承诺。3 分钟静默仅是查看任务的提醒，不会自动中止任务或重连 Codex。

任务同步超过 30 秒或失联显示待同步，保留原运行卡片并隐藏旧速度，恢复后按新记录更新。已有明确回合的任务会保留运行生命周期，匹配的完成/失败事件结束它；长工具等待保持可见。卡片有新用量时显示 `t/min`，其余根据记录显示“工具执行”“等待工具”“等待响应”“思考中”或“待确认”。单独的零上报值只在详情保留，不当作进度或网络故障。

运行详情只使用与任务当前回合 ID 一致的活动和用量快照；回合缺失或不匹配时显示待确认，同时隐藏旧阶段、模型、时间和速度。切换回合会清空上一回合活动，本轮首条用量报告建立基线，第二条才计算本轮速率。线程与项目的滚动 60 秒用量继续按原规则跨回合汇总，两种统计各自保留口径。

明确的 `task_started` 记录建立持续运行的生命周期；冷启动只读到孤立进度时，保留有限的活动有效期和未知开始时间。迟到的旧工具记录归属于原回合，API 已完成状态和更新回合受到保护，避免已完成任务再次冒出。

当前 Codex 历史接口可能给正在继续的回合返回 `interrupted` 标签。兼容规则要求回合 ID 完全一致、缺少结束时间和本轮最终结果，同时观察到有效期内的真实推理、输出或工具启动，才沿用运行状态；工具结束回执不延长这类证明。接口或本地出现明确结束证据后以结束状态为准。后续接口能够可靠提供执行状态时，可移除此兼容规则。

公共评分超过 3 分钟无新样本变为未知；公共检测明细超过 5 分钟标为旧数据。官方读取失败显示未知。单次请求超时为 6 秒，整轮 8 秒后提供超时结果；系统 DNS 若仍未返回，等待原有工作线程结束后恢复检测，避免累积请求。手动连续点击至少间隔 10 秒。

## 数据与边界

- 任务标题、阶段、模型设置和计数留在本机；新增监控历史仅存内存，退出清空。
- 外部请求固定为 `https://www.microsoft.com/favicon.ico`、`https://chatgpt.com/backend-api/codex/responses`、`https://api.openai.com/v1/models`、`https://auth.openai.com/.well-known/openid-configuration`、`https://chatgpt.com/cdn-cgi/trace` 和 `https://status.openai.com/api/v2/summary.json`。没有用户正文、账号信息、授权头或 Cookie；公共服务会接收普通请求的 IP 和请求元数据。
- 出口检测复用原有 trace 请求，在内存保留进程随机盐指纹、地区代码及服务边缘机房代码。原 IP 解析后立即丢弃；代理地址、账户与凭据不展示、不落盘。地区由本次公共检测返回，边缘机房仅作提示，两者均与 VPN 客户端的所选线路分别标注。读不到出口时清空旧地区；切换节点后手动重新测可隔离样本。
- 仅显示能实际检测到的出口资料；没有系统 VPN 查询、第三方客户端集成、配置或订阅读取，也不切换节点。
- 出口资料随原有检测轮次更新，重测立即清除旧字段，超过五分钟的资料隐藏，失败后保留未知。新增资料不改变评分、采样频率，不增加外部请求或模型 Token 消耗。
- 检测遵循此进程可用的系统／环境代理设置；VPN 隧道与 Codex 实际请求可能使用不同路径，因此界面只报告观测到的结果。
- 阶段表示最近观察到的事件；没有完整配对记录时保留未知。工具参数、执行输出和对话正文不会进入新增监控记录。
- 此功能衡量活动、用量上报和公共 HTTPS 响应。链路带宽、模型首 Token 延迟、逐 Token 解码速度及服务器内部排队无法由这些信号直接确定。

## English

Click the outline face left of weekly quota to open **Codex Health**. Its 13px reading keeps the public-connection score out of 100 visible, paired with Prime (95–100), Smooth (85–94), Steady (70–84), Mixed (60–69) or Poor (0–59). The popover explains the current band and highlights it on the full score scale. Missing or stale samples display a dash with a sampling, sync or retest label. These are interpretation bands for the existing connection score; the scoring formula remains unchanged. A separate dot preserves runtime warnings for waiting or quiet tasks, unknown observations and recent explicit turn failures. The popover is anchored below the face and shows task evidence, connection samples, public HTTPS checks and official notices; click outside, use the close button, or press Esc to dismiss it. See [the score formula](HEALTH_SCORE.md). Public responses establish reachability of the sampled endpoints; authenticated sessions and model generation need their own evidence.

Reported usage uses a rolling 60-second window. Total usage includes input/cache; output includes reasoning. Zero means no new usage report in that window; a dash means insufficient measurements. Neither is model decoding TPS. A task quiet for three minutes deserves a look, and may still be thinking or waiting for a tool.

Cards show fresh reported usage as `t/min`, or a phase such as Tool call, Tool wait, Awaiting response or Unconfirmed. Transient observation failures retain previously running cards as Pending sync and hide old rates. Anchored turns stay visible until a matching terminal event or an authoritative newer state; long-running local tools do not expire a task by age alone.

Runtime details require an atomic activity/usage snapshot matching the card's current turn ID. Missing or mismatched identities show Unconfirmed and hide old phases, models, timestamps and rates. Each new turn clears prior activity and establishes a fresh usage baseline: the first report starts measurement, and the second enables its rate. Thread/project rolling usage retains its separate cross-turn 60-second window.

Initial and reset checks take six rounds, three seconds apart. Reset after switching nodes; an observed public exit change also clears old samples. Single background rounds run about every minute while tasks run, retaining fifteen minutes of in-memory samples. Requests send no conversation, account data, cookies or authentication to the fixed public URLs above. These services receive ordinary connection metadata. Public IPs are discarded after creating a process-salted in-memory change fingerprint. The process may take a different proxy/VPN path from Codex.

One compact observed-exit row sits below the score, using the existing trace request's country code. Unavailable VPN connection and selected-node names have been removed. No OS VPN queries, third-party client integration, new external requests, client configuration reads, credentials, network changes or model calls are added. Exit labels stay in memory, clear on reset or failed observation, and hide after five minutes. The public probe's exit may differ from Codex's actual path.

Reference: [Cloudflare trace edge identification](https://developers.cloudflare.com/support/troubleshooting/general-troubleshooting/geographic-traffic-routing/). Country labels describe the trace result, with no claim about the physical location of the selected VPN server.

Public HTTPS delay includes connection setup. A response over 2.5 seconds, or over three times a baseline of at least three successes and over one second, is flagged for inspection. HTTP errors show their status codes separately from transport failures. Official aggregate incidents and local activity remain separate evidence. No diagnostic action generates model output, redeems resets, stops tasks or changes proxy settings.
