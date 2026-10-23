const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const state = {
  threads: [], selectedThreadId: null, openingId: null, filter: "board", observedAt: null, weeklyUsage: null, usageDetails: null,
  petMode: params.get("pet") === "1", petExpanded: false,
  mode: "compact", pinned: localStorage.getItem("twin-pinned") === "true",
  connected: false, refreshing: false, listBusy: false, queuedRender: false,
  petInteractionTimer: null, petInteractionResolve: null, petInteractionToken: 0,
  petInteractionCooldownUntil: 0, boardSize: 0, autoCollapseTimer: null, hoverCollapseTimer: null,
  pointerInside: false, selectionRevision: 0, nativePointerInside: null,
  hoverExpandTimer: null, hoverPollTimer: null, hoverTrackingStopped: false, petDragging: false,
  diagnostics: null, diagnosticsBusy: false, diagnosticsFailed: false, diagnosticsResetting: false, diagnosticsTimer: null, diagnosticsStopped: false,
};
const PET_POSES = new Set(["idle", "hello", "peek", "nod"]);

function prefersReducedMotion() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function setPetFrame(name) {
  const frame = PET_POSES.has(name) ? name : "idle";
  for(const id of ["petCharacter","brandMonkey"])$(id).dataset.frame=frame;
}

function stopPetInteraction() {
  state.petInteractionToken += 1;
  if (state.petInteractionTimer !== null) {
    window.clearTimeout(state.petInteractionTimer);
    state.petInteractionTimer = null;
  }
  if (state.petInteractionResolve !== null) {
    state.petInteractionResolve();
    state.petInteractionResolve = null;
  }
  $("petLauncher").removeAttribute("data-interacting");
  setPetFrame("idle");
}

async function playPetInteraction(sequence, frameDuration = 170) {
  if (prefersReducedMotion()) return Promise.resolve();
  const frames = sequence.filter((name) => PET_POSES.has(name));
  if (!frames.length) return Promise.resolve();

  state.petInteractionToken += 1;
  const token = state.petInteractionToken;
  if (state.petInteractionTimer !== null) window.clearTimeout(state.petInteractionTimer);
  if (state.petInteractionResolve !== null) state.petInteractionResolve();
  $("petLauncher").dataset.interacting = "true";

  return new Promise((resolve) => {
    state.petInteractionResolve = resolve;
    let index = 0;
    const advance = () => {
      if (token !== state.petInteractionToken) {
        if (state.petInteractionResolve === resolve) state.petInteractionResolve = null;
        resolve();
        return;
      }
      setPetFrame(frames[index]);
      index += 1;
      if (index < frames.length) {
        state.petInteractionTimer = window.setTimeout(advance, frameDuration);
        return;
      }
      state.petInteractionTimer = window.setTimeout(() => {
        if (token === state.petInteractionToken) {
          state.petInteractionTimer = null;
          state.petInteractionResolve = null;
          $("petLauncher").removeAttribute("data-interacting");
          setPetFrame("idle");
        }
        resolve();
      }, frameDuration);
    };
    advance();
  });
}

function invokeDesktop(command, args = {}) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") return Promise.resolve(null);
  return invoke(command, args);
}

function node(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}
function shortStatus(card) {
  return {running:"进行中",pending:"待同步",unread:"已完成",read:"已读"}[displayStatus(card)];
}
function displayStatus(card) {
  const running=card.status==="running";
  if((running&&(!state.connected||card.sync_pending))||(card.status==="unknown"&&card.last_observed_status==="running"&&card.sync_pending))return "pending";
  return running?"running":card.unread?"unread":"read";
}
function formatRate(value) {
  if(!Number.isFinite(value))return "—";
  if(value>=1000000)return (value/1000000).toFixed(1).replace(/\.0$/,'')+"M";
  if(value>=1000)return (value/1000).toFixed(1).replace(/\.0$/,'')+"k";
  return Math.round(value).toLocaleString();
}
function rateText(tokens) {
  return state.connected&&tokens?.ready?formatRate(tokens.tokens_per_min)+" /min":"—";
}
function taskRunState(card,now=Date.now()/1000) {
  const runtime=card.runtime||{},tokens=card.tokens||{};
  if(displayStatus(card)==="pending"||runtime.observation_available===false)return {label:"待同步",hint:"运行记录暂未同步，保留上次任务状态"};
  const age=Number.isFinite(runtime.activity_at)?now-runtime.activity_at:null;
  const reportFresh=Number.isFinite(tokens.last_report_at)&&now-tokens.last_report_at<=60&&now-tokens.last_report_at>=-30;
  if(reportFresh&&tokens.ready&&tokens.tokens_per_min>0)return {label:formatRate(tokens.tokens_per_min)+" t/min",hint:"近60秒上报的 Token 用量，含输入、缓存与输出；属于用量速率"};
  if(runtime.pending_tools>0)return {label:age!==null&&age>=180?"等待工具":"工具执行",hint:"已发起工具调用，尚未收到完成记录；本地 Python 等工具执行期间可能没有新增 Token 上报"};
  if(age!==null&&age>=180)return {label:"待确认",hint:"较长时间没有新运行记录；可能在思考或等待，需查看原对话确认"};
  if(runtime.phase==="starting")return {label:"等待响应",hint:"回合已开始，尚未观察到首个模型或工具活动"};
  if(runtime.phase==="thinking")return {label:"思考中",hint:"最近记录为思考活动，用量可能延迟上报"};
  if(runtime.phase==="response")return {label:"输出中",hint:"最近记录为输出活动，用量可能延迟上报"};
  return {label:"等待上报",hint:"近60秒没有新增 Token 上报；这不是进度百分比，也不代表任务停止"};
}
function fanPeriod(rate) {
  return Number.isFinite(rate)&&rate>0?Math.max(.55,4/(1+Math.sqrt(rate/30000))):0;
}
function renderTokenFan(container,tokens,running) {
  if(!container.firstElementChild){
    const svgElement=(tag,attrs)=>{
      const element=document.createElementNS("http://www.w3.org/2000/svg",tag);
      for(const [key,value]of Object.entries(attrs))element.setAttribute(key,value);
      return element;
    };
    const svg=svgElement("svg",{viewBox:"0 0 24 24","aria-hidden":"true"});
    const rim=svgElement("circle",{cx:"12",cy:"12",r:"10.5",fill:"#fff9df",stroke:"#e8c45c","stroke-width":".8"});
    const rotor=svgElement("g",{class:"fan-rotor",fill:"#efbd29"});
    for(const angle of [0,120,240])rotor.append(svgElement("path",{
      d:"M11.2 11.2C8.8 9.5 8.1 6.6 9.1 4.5C10 2.6 13.5 2.6 15.1 4.1C16.5 5.5 15.4 8.2 12.7 11.1Z",
      transform:`rotate(${angle} 12 12)`
    }));
    const hub=svgElement("circle",{cx:"12",cy:"12",r:"2.35",fill:"#c99a1c",stroke:"#fff9df","stroke-width":"1.2"});
    svg.append(rim,rotor,hub);container.append(svg);
  }
  const period=fanPeriod(state.connected&&tokens?.ready?tokens.tokens_per_min:0);
  container.dataset.spinning=String(Boolean(running&&period));
  container.style.setProperty("--fan-period",(period||4)+"s");
  container.setAttribute("role","img");
  const label="黄色风扇 · "+rateText(tokens)+(running&&period?" · 用量越高转得越快":" · 静止");
  container.setAttribute("aria-label",label);container.title=label;
}
function updateTaskRow(button,card) {
  const status=displayStatus(card);
  button.dataset.status=status;button.dataset.threadId=card.id;
  button.dataset.projectTone=projectTone(card);
  button.setAttribute("aria-pressed",String(card.id===state.selectedThreadId));
  button.setAttribute("aria-busy",String(card.id===state.openingId));
  button.disabled=card.id===state.openingId;
  button.title=card.name+" · "+shortStatus(card)+"\n"+(card.project_label||"")+" · "+relativeTime(activityTime(card))+"\n点击在 Codex 中打开";
  const icon=node("i","task-state");icon.setAttribute("aria-hidden","true");
  const copy=node("div","task-copy"),title=node("div","task-title-line");
  title.append(node("strong","",card.name));
  title.append(node("span","row-status",shortStatus(card)));
  const meta=node("div","task-meta"),progress=node("span","stage",card.summary||card.project_label||"任务");
  progress.title=card.summary?"最近进展 · "+card.summary:"";meta.append(progress);
  if(status==="running"||status==="pending"){
    const observed=taskRunState(card),speed=node("span","row-rate");speed.title=observed.hint;
    const measured=observed.label.includes("t/min"),fan=node("span","token-fan mini-fan");renderTokenFan(fan,measured?card.tokens:null,status==="running"&&measured);
    speed.append(fan,node("span","",observed.label));meta.append(speed);
  }else meta.append(node("time","",relativeTime(activityTime(card))));
  copy.append(title,meta);button.replaceChildren(icon,copy);
}
async function api(path, body) {
  const response = await fetch(path, {
    cache: "no-store",
    ...(body === undefined ? {} : {method:"POST", headers:{"Content-Type":"application/json","X-Work-Twin":"1"}, body:JSON.stringify(body)})
  }).catch(()=>{throw Error("暂时连接不上，请稍后重试");});
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "请求失败");
  return result;
}
function banner(message) {
  $("systemBanner").textContent = message || "";
  $("systemBanner").hidden = !message;
  syncBoardSize();
}
function relativeTime(value) {
  const t = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(t)) return "待同步";
  const seconds = Math.max(0, Math.floor((Date.now()-t)/1000));
  if (seconds<60) return "刚刚";
  if(seconds<3600) return Math.floor(seconds/60)+" 分钟前";
  if(seconds<86400) return Math.floor(seconds/3600)+" 小时前";
  return Math.floor(seconds/86400)+" 天前";
}
function mode(value, options = {}) {
  state.mode = value;
  cancelAutoCollapse();
  cancelHoverCollapse();
  cancelHoverExpand();
  if(value==="collapsed")state.readPlay?.suspend();
  state.petExpanded = value !== "collapsed";
  if (state.petExpanded) stopPetInteraction();
  document.documentElement.dataset.mode = value;
  $("petShell").hidden = !state.petMode || value !== "collapsed";
  $("appShell").hidden = state.petMode && value === "collapsed";
  if(value==="compact")syncBoardSize(true,options.activate!==false);
  else if(state.petMode)invokeDesktop("set_pet_view",{view:value,activate:false}).catch(e=>banner("窗口调整失败："+e));
}
function updateCounts() {
  state.readPlay?.syncPocket();
  if(!state.connected)state.readPlay?.suspend();
  $("connectionDot").dataset.connected=String(state.connected);
  const connectionLabel=state.connected?"已连接 Codex；点击任务打开原对话":"连接中断，保留上次记录";
  $("connectionDot").title=connectionLabel;$("connectionDot").setAttribute("aria-label",connectionLabel);
  const quota=weeklyQuotaState(state.weeklyUsage);
  $("weeklyRemaining").textContent=quota.label;
  $("weeklyQuota").dataset.state=quota.state;
  const reset=state.weeklyUsage?.resets_at;
  $("weeklyQuota").title=quota.state==="unknown"?"Codex 周订阅额度待同步":"Codex 账户本周剩余 "+quota.label+(reset?" · 重置于 "+new Date(reset*1000).toLocaleString("zh-CN"):"");
  if(quota.state!=="unknown"&&(!state.connected||state.weeklyUsage.refresh_pending)){
    $("weeklyQuota").title+=" · 上次同步 "+new Date(state.weeklyUsage.observed_at*1000).toLocaleTimeString("zh-CN")+" · 正在重试同步";
  }
  $("petQuotaRemaining").textContent=quota.label;
  $("petQuota").dataset.state=quota.state;
  $("petQuota").title=$("weeklyQuota").title;
  renderQuotaDetails();
  const groups=boardSets();
  renderQuotaFlow($("weeklyQuota"),groups.board,quota);
  const running=groups.board.filter(t=>state.connected&&t.status==="running").length;
  const unread=groups.recent.filter(t=>displayStatus(t)==="unread").length;
  $("boardCount").textContent=groups.board.length;
  $("recentCount").textContent=groups.recent.length;
  $("historyCount").textContent=groups.history.length;
  const activity=window.WorkTwinBananaTree.activityState(unread,running,state.connected);
  const label=activity.label;
  $("petLauncher").dataset.state=activity.state;
  $("petCharacter").dataset.running=String(activity.running);
  const quotaLabel=quota.state==="unknown"?"周额度待同步":"周剩余 "+quota.label;
  $("petLauncher").title=label+" · "+quotaLabel+" · 按住拖动 · 悬停或轻点展开 · 右键退出";
  $("petLauncher").setAttribute("aria-label",label+"，"+quotaLabel+"，悬停或轻点展开任务动态");
  window.WorkTwinBananaTree?.render($("petHarvest"),unread,state.connected);
  window.WorkTwinBananaTree.renderGrowth($("petGrowth"),running,state.connected);
}
function weeklyQuotaState(usage,now=Date.now()/1000) {
  const valid=usage?.available&&Number.isFinite(usage.remaining_percent)&&
    Number.isFinite(usage.observed_at)&&now-usage.observed_at<=90&&now-usage.observed_at>=-30&&
    (usage.resets_at==null||usage.resets_at>now);
  if(!valid)return {label:"—",state:"unknown"};
  const remaining=Math.max(0,Math.min(100,usage.remaining_percent));
  return {label:String(Math.round(remaining*10)/10)+"%",state:remaining<=20?"low":remaining<=50?"medium":"normal",remaining};
}
function quotaDetailsState(details,now=Date.now()/1000) {
  const fresh=Number.isFinite(details?.observed_at)&&now-details.observed_at<=90&&now-details.observed_at>=-30;
  if(!fresh)return {fresh:false,pending:true,balance:null,cards:null,windows:[]};
  return {fresh:true,pending:details.refresh_pending===true,
    balance:details.credit_balance?.available===true?details.credit_balance:null,
    cards:details.reset_cards?.available===true?details.reset_cards:null,
    windows:Array.isArray(details.windows)?details.windows.filter(item=>[300,10080].includes(item.window_minutes)):[]};
}
function formatQuotaBalance(value) {
  if(typeof value!=="string"||!/^\d+(?:\.\d+)?$/.test(value)||!Number.isFinite(Number(value)))return null;
  return Number(value).toLocaleString("zh-CN",{maximumFractionDigits:2});
}
function quotaLocalTime(timestamp,full=false) {
  if(!Number.isFinite(timestamp)||timestamp<=0)return "待同步";
  return new Date(timestamp*1000).toLocaleString("zh-CN",full?{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}:{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});
}
function quotaCountdown(timestamp,now=Date.now()/1000) {
  if(!Number.isFinite(timestamp)||timestamp<=0)return "";
  const minutes=Math.ceil((timestamp-now)/60);
  if(minutes<=0)return "等待重置同步";
  if(minutes<60)return minutes+" 分钟后";
  if(minutes<1440)return Math.ceil(minutes/60)+" 小时后";
  return Math.floor(minutes/1440)+" 天 "+Math.floor(minutes%1440/60)+" 小时后";
}
function setQuotaResetExpanded(expanded) {
  if(expanded&&$("runtimeHealth"))setHealthExpanded(false);
  $("quotaResetWindows").hidden=!expanded;
  $("quotaResetToggle").setAttribute("aria-expanded",String(expanded));
  $("quotaResetToggle").title=expanded?"收起额度重置时间":"展开额度重置时间";
  syncBoardSize(false,false);
}
function setHealthExpanded(expanded) {
  $("runtimeHealth").hidden=!expanded;
  $("runtimeHealthToggle").setAttribute("aria-expanded",String(expanded));
  if(expanded){$("resetCardDetails").open=false;setQuotaResetExpanded(false);}
  syncBoardSize(false,false);
}
function renderQuotaDetails(now=Date.now()/1000) {
  const panel=document.getElementById?.("quotaDetails");
  if(!panel)return;
  const usage=quotaDetailsState(state.usageDetails,now);
  panel.dataset.state=usage.fresh?usage.pending?"pending":"current":"unknown";
  const value=usage.balance?.unlimited?"不限额":formatQuotaBalance(usage.balance?.balance);
  $("creditBalanceValue").textContent=value??"—";
  $("creditBalanceValue").title=value===null?"额度余额待同步":usage.balance?.unlimited?"不限额":"额度余额："+usage.balance.balance;
  $("creditBalanceHint").textContent=value===null?"待同步":"Codex 当前余额";
  const cards=usage.cards;
  const count=Number.isInteger(cards?.available_count)&&cards.available_count>=0?cards.available_count:null;
  $("resetCardCount").textContent=count===null?"—":String(count);
  const expirations=count===null?[]:(Array.isArray(cards.expirations)?cards.expirations:[]).filter(item=>Number.isInteger(item.count)&&item.count>0&&(item.expires_at===null||(Number.isFinite(item.expires_at)&&item.expires_at>0))).sort((a,b)=>(a.expires_at??Infinity)-(b.expires_at??Infinity));
  const unlisted=Number.isInteger(cards?.unlisted_count)&&cards.unlisted_count>0?cards.unlisted_count:0;
  const nearest=expirations.find(item=>item.expires_at!==null);
  const expiryHint=count===null?"待同步":count===0?"暂无可用重置卡":nearest?"到期 "+quotaLocalTime(nearest.expires_at):unlisted||!expirations.length?"有效期待同步":"无到期时间";
  $("resetCardNextExpiry").textContent=expiryHint;
  $("resetCardNextExpiry").title=nearest?"最近到期 "+quotaLocalTime(nearest.expires_at,true):expiryHint;
  const list=$("resetCardExpirations");
  list.replaceChildren();
  const appendExpiry=(amount,label,title=label)=>{
    const item=document.createElement("li"),number=document.createElement("span"),date=document.createElement("span");
    number.textContent=amount===null?"—":"×"+amount;date.textContent=label;date.title=title;
    item.append(number,date);list.append(item);
  };
  for(const item of expirations)appendExpiry(item.count,item.expires_at===null?"无到期时间":quotaLocalTime(item.expires_at),item.expires_at===null?"无到期时间":quotaLocalTime(item.expires_at,true));
  if(unlisted)appendExpiry(unlisted,"有效期待同步");
  if(!list.children.length)appendExpiry(count,count===0?"暂无可用重置卡":"有效期待同步");
  const windows=$("quotaResetWindows");windows.replaceChildren();
  const ordered=[10080,300].map(minutes=>usage.windows.find(item=>item.window_minutes===minutes)).filter(Boolean);
  if(!ordered.length)ordered.push({window_minutes:10080,resets_at:null});
  for(const item of ordered){
    const row=document.createElement("p"),label=document.createElement("span"),text=document.createElement("span");
    label.textContent=item.window_minutes===10080?"周额度重置":"5 小时额度重置";
    const timestamp=item.resets_at;
    if(Number.isFinite(timestamp)&&timestamp>0){
      const time=document.createElement("time");time.dateTime=new Date(timestamp*1000).toISOString();
      time.textContent=quotaLocalTime(timestamp);time.title=quotaLocalTime(timestamp,true);
      text.append(time,document.createTextNode(" · "+quotaCountdown(timestamp,now)));
    }else text.textContent="待同步";
    row.append(label,text);windows.append(row);
  }
  const status=$("quotaDetailsStatus");
  status.hidden=!usage.fresh||!usage.pending;
  status.textContent=usage.pending?"上次同步 "+quotaLocalTime(state.usageDetails?.observed_at)+" · 正在重试同步":"";
  syncBoardSize();
}
function renderQuotaFlow(element,cards,quota) {
  // A slow, fixed-speed turn signals observed activity while preserving the banana face.
  const now=Date.now()/1000;
  const rate=state.connected?cards.reduce((sum,card)=>{
    const tokens=card.tokens;
    const fresh=Number.isFinite(tokens?.last_report_at)&&now-tokens.last_report_at<=60&&now-tokens.last_report_at>=-30;
    return sum+(card.status==='running'&&fresh&&tokens?.ready&&Number.isFinite(tokens.tokens_per_min)&&tokens.tokens_per_min>0?tokens.tokens_per_min:0);
  },0):0;
  element.dataset.flowing=String(rate>0&&quota.state!=='unknown');
  const description=rate>0?' · 运行任务近60秒 Token 速率合计 '+Math.round(rate).toLocaleString()+' /min · 香蕉币缓转表示活跃，不代表逐枚扣费':' · 当前无已观测的 Token 消耗';
  element.title+=description;
}
function healthAge(seconds) {
  if(!Number.isFinite(seconds)||seconds<0)return "未知";
  if(seconds<60)return Math.floor(seconds)+" 秒前";
  if(seconds<3600)return Math.floor(seconds/60)+" 分钟前";
  return Math.floor(seconds/3600)+" 小时前";
}
function healthTime(timestamp) {
  if(!Number.isFinite(timestamp)||timestamp<=0)return "未检测";
  return new Date(timestamp*1000).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
}
function healthPhase(phase) {
  return {thinking:"思考",tool:"工具活动",response:"输出",waiting:"等待",starting:"启动",unknown:"类型未知"}[phase]||"类型未知";
}
function healthNetworkText(check) {
  if(!check)return "未检测";
  const labels={reachable:"可达",slow:"较慢",http_error:"HTTP 响应",timeout:"超时",dns_error:"DNS 失败",tls_error:"TLS 失败",unreachable:"连接失败"};
  const label=labels[check.state]||"未知";
  const latency=Number.isFinite(check.latency_ms)?Math.round(check.latency_ms)+" ms":"";
  return label+(latency?" · "+latency:"")+(check.state==="http_error"&&Number.isInteger(check.http_status)?" · "+check.http_status:"");
}
function renderOperationalHealth(data,now) {
  const fresh=!state.diagnosticsFailed&&data?.data_state==="current"&&Number.isFinite(data?.observed_at)&&now-data.observed_at<=30&&now-data.observed_at>=-30;
  const value=fresh?data?.operational:null;
  const states={active:["活跃","ok"],tool_running:["工具中","ok"],quiet:["待确认","notice"],waiting:["等待响应","notice"],error:["异常","warning"],unknown:["待确认","unknown"],idle:["空闲","unknown"]};
  const selected=states[value?.state]||states.unknown;
  let [label,level]=selected;
  if(value?.state==="tool_running"&&value.level!=="ok"){label="等待工具";level="notice";}
  const reasons={active:"已观察到近期任务活动。",tool_running:"已观察到工具调用，等待完成记录。",tool_wait:"部分工具较长时间未返回；可以打开原对话确认，当前无法判断工具是否仍在执行。",quiet:"部分任务较长时间没有新活动，需要查看原对话确认。",awaiting_response:"任务已经启动，尚未观察到首个模型或工具响应。",recent_connection_error:"最近回合记录了连接失败，请查看原对话；这里没有执行重连。",recent_task_error:"最近回合记录了执行错误，请查看原对话确认原因。",activity_unconfirmed:"部分任务的运行记录暂不可用，等待同步确认。",sync_unavailable:"运行记录暂未同步，保留上次任务卡片。",idle:"当前没有运行任务，可按需检查连接。"};
  const reason=reasons[value?.code]||reasons.sync_unavailable;
  const affected=Number.isInteger(value?.affected_tasks)&&value.affected_tasks>0?value.affected_tasks:0;
  $("healthSummary").textContent=label;
  $("healthSummary").title=reason;
  $("healthOperationalReason").textContent=(affected?affected+" 项任务 · ":"")+reason;
  $("runtimeHealth").dataset.level=level;
  const badge=$("runtimeHealthToggle");badge.dataset.level=level;
  badge.dataset.checking=String(Boolean(state.diagnosticsResetting||data?.network?.checking));
  const alert=$("healthRuntimeAlert");alert.dataset.level=level;
  alert.hidden=level==="ok"||value?.state==="idle";
  const scoreLabel="公共连接质量 · "+$("healthScoreValue").textContent;
  badge.setAttribute("aria-label",scoreLabel+" · Codex 健康度 · "+label);
  badge.title=scoreLabel+"\n"+"Codex 健康度 · "+label+"\n"+reason;
}
function renderHealthScore(data,now=Date.now()/1000) {
  const score=data?.score||{},network=data?.network||{};
  const current=!state.diagnosticsFailed&&!state.diagnosticsResetting&&Number.isFinite(data?.observed_at)&&now-data.observed_at<=30&&now-data.observed_at>=-30;
  const stale=!state.diagnosticsResetting&&(score.grade==="stale"||(network.stale===true&&Number.isFinite(network.checked_at)));
  const valid=current&&!stale&&["good","fair","poor"].includes(score.grade)&&Number.isFinite(score.value)&&score.value>=0&&score.value<=100;
  const grade=stale?"stale":valid?score.grade:"collecting";
  const confidence=valid?{provisional:"初步",short_check:"短测完成"}[score.confidence]||"初步":stale?"需重测":current||state.diagnosticsResetting?"采样中":"待同步";
  $("healthScoreValue").textContent=valid?Math.round(score.value)+" /100":"—";
  $("healthBadgeValue").textContent=valid?String(Math.round(score.value)):"—";
  $("runtimeHealthToggle").dataset.scoreLevel=valid?{good:"ok",fair:"notice",poor:"warning"}[score.grade]:"unknown";
  $("healthScoreValue").title="评分来自公开链路采样；Codex 实际响应仍需任务验证";
  $("healthConnectionConfidence").textContent=confidence;
  const reasons={good:"当前链路表现顺畅，可继续观察实际任务进展。",fair:"当前链路存在延迟或波动，可对比切换节点后的短测。",poor:"当前链路存在较多失败或波动，可切换节点后重新检测。",collecting:"正在建立当前节点的参考，需要多轮采样后评分。",stale:"这份采样已过期，请重新检测当前节点。"};
  const noteLabels={partial_coverage:"服务采样尚未齐全。",insufficient_rounds:"独立采样轮数尚不足。",runtime_unconfirmed:"实际 Codex 响应仍待验证。",runtime_quiet:"部分运行任务近期没有新活动。",missing_latency:"延迟数据不足。",failed_latency_floor:"失败请求已纳入延迟评估。",http_restricted:"检测地址限制访问，评分仅作链路参考。",unexpected_response:"检测地址返回了非预期响应。",service_failures:"部分服务连接探测失败。",codex_recent_failures:"近期 Codex 链路探测失败。",official_codex_degraded:"官方报告 Codex 性能下降。",official_codex_outage:"官方报告 Codex 服务中断。",official_other_notice:"官方其他服务有异常报告。",official_status_unknown:"官方状态暂不可用。",short_check_only:"短测反映当前片段，仍需持续观察。"};
  const notes=Array.isArray(score.notes)?score.notes:[];
  const priority=["official_codex_outage","official_codex_degraded","codex_recent_failures","service_failures","http_restricted","unexpected_response","partial_coverage","insufficient_rounds","missing_latency","runtime_quiet","runtime_unconfirmed","official_status_unknown"];
  const reasonCode=priority.find(code=>notes.includes(code));
  $("healthScoreReason").textContent=(current||state.diagnosticsResetting||stale?reasons[grade]:"正在读取当前链路评分…")+(current&&reasonCode?" "+noteLabels[reasonCode]:"");
  const count=Number.isInteger(score.sample_count)&&score.sample_count>=0?score.sample_count:0;
  const rounds=Number.isInteger(network.rounds_completed)?network.rounds_completed:Number.isInteger(score.round_count)?score.round_count:0;
  const planned=Number.isInteger(network.rounds_planned)&&network.rounds_planned>0?network.rounds_planned:6;
  const progress=state.diagnosticsResetting?"新一轮采样即将开始":"公开链路参考 · "+rounds+"/"+planned+" 轮 · "+count+" 次探测";
  $("healthScoreProgress").textContent=progress+(network.node_changed_at?" · 统计已重置":"");
  $("healthScoreProgress").title=notes.map(code=>noteLabels[code]).filter(Boolean).join("\n");
  $("healthRouteNote").hidden=!(network.exit_observed===false&&Number.isFinite(network.checked_at));
  $("healthRouteNote").textContent="出口未确认；切换节点后请重新测量。";
  if(score.components&&valid)$("healthScoreValue").title+="\n"+"可靠性 "+formatRate(score.components.reliability)+"/60 · "+"延迟 "+formatRate(score.components.latency)+"/25 · "+"稳定性 "+formatRate(score.components.stability)+"/15";
  for(const [key,id,suffix]of [["success_percent","healthSuccessRate","%"],["p50_ms","healthP50"," ms"],["p95_ms","healthP95"," ms"],["jitter_ms","healthJitter"," ms"]]){
    $(id).textContent=current&&!stale&&Number.isFinite(score[key])?Math.round(score[key])+suffix:"—";
  }
}
function renderDiagnostics(now=Date.now()/1000) {
  const panel=$("runtimeHealth");if(!panel)return;
  const data=state.diagnostics,activity=data?.activity||{},assessment=data?.assessment||{};
  const fresh=!state.diagnosticsFailed&&data?.data_state==="current"&&Number.isFinite(data?.observed_at)&&now-data.observed_at<=30&&now-data.observed_at>=-30;
  renderHealthScore(data,now);
  renderOperationalHealth(data,now);
  const explanations={sync_unavailable:"运行信号暂未同步，恢复连接后再判断。",idle:"当前没有运行任务，可按需检测连接。",network_unavailable:"公开连接探测失败，可检查网络或代理后重测。",openai_path:"公共网络可达，OpenAI 连接较慢或失败，可切换链路后重测。",connection_slow:"本次公共连接耗时较高，可重测并对照任务活动。",reference_path:"公共网络参照探测失败，OpenAI 连接仍可达，可再次检测。",endpoint_response:"连接已建立，检测地址返回 HTTP 限制或错误；请查看状态码。该结果仅代表公开检测地址。",service_notice:"官方报告了服务异常，可能影响部分任务。",quiet:"部分任务较久没有新活动，可对照连接和官方状态判断。",active:"已观察到新活动，可结合输出与任务记录判断进展。",waiting:"运行任务暂未出现新报告，可能在思考、调用工具或等待响应。"};
  Object.assign(explanations,{tool_running:"当前有工具调用尚未完成，工具执行期间可能没有新增 Token。",tool_wait:"部分工具较长时间未返回，需要确认原对话。",awaiting_response:"已发起任务，等待首个响应。",activity_unconfirmed:"部分任务的记录待同步。",recent_connection_error:"最近回合记录了连接失败。",recent_task_error:"最近回合记录了执行错误。"});
  const output=fresh&&Number.isFinite(activity.output_tokens_per_min)?activity.output_tokens_per_min:null;
  $("healthAssessment").textContent=fresh?(explanations[assessment.code]||explanations.waiting):explanations.sync_unavailable;
  $("healthTotalRate").textContent=fresh?formatRate(activity.total_tokens_per_min):"—";
  $("healthOutputRate").textContent=output===null?"—":formatRate(output);
  $("healthOutputRate").title=output===0?"近 60 秒未收到输出上报；思考与工具活动可能仍在继续":"近 60 秒已上报输出 Token，报告可能延迟";
  const activityAge=Number.isFinite(activity.last_activity_at)?Math.max(0,now-activity.last_activity_at):null;
  $("healthLastActivity").textContent=fresh?"最近活动 "+healthAge(activityAge)+" · "+(Number.isInteger(data.running_tasks)?data.running_tasks:0)+" 项运行":"最近活动待同步";
  const network=data?.network||{},checks=!state.diagnosticsResetting&&Array.isArray(network.checks)?network.checks:[];
  for(const [id,target]of [["general","healthGeneralNetwork"],["codex","healthCodexNetwork"],["api","healthAPINetwork"],["auth","healthAuthNetwork"]]){
    const check=checks.find(item=>item.id===id),element=$(target);
    element.textContent=healthNetworkText(check)+(network.stale&&check?" · 旧数据":"");
    element.dataset.state=check?.state||"unknown";
    element.title=check?"近期中位延迟 "+(Number.isFinite(check.median_ms)?Math.round(check.median_ms)+" ms":"未知")+" · 参考基线 "+(Number.isFinite(check.baseline_ms)?Math.round(check.baseline_ms)+" ms":"未知")+" · 连续失败 "+(Number.isInteger(check.failure_streak)?check.failure_streak:0):"未检测";
  }
  const official=data?.official||{},incidents=Array.isArray(official.incidents)?official.incidents:[],components=Array.isArray(official.components)?official.components:[];
  const officialState={operational:"官方：暂无已知异常",degraded:"官方：报告服务异常",unknown:"官方状态暂不可用"}[official.state]||"官方状态待检测";
  $("healthOfficial").textContent=officialState+(official.stale?" · 旧数据":"")+(incidents.length?" · "+String(incidents[0].name||""):"");
  $("healthOfficial").title=components.map(item=>String(item.name)+": "+String(item.status)).join("\n")+(official.checked_at?"\n"+"检查于 "+healthTime(official.checked_at):"");
  const componentStates={operational:"正常",degraded_performance:"性能下降",partial_outage:"部分中断",major_outage:"服务中断",under_maintenance:"维护中"};
  $("healthOfficialComponents").hidden=!components.length;
  $("healthOfficialComponents").textContent=components.map(item=>String(item.name)+" · "+(componentStates[item.status]||"状态未知")).join(" / ");
  $("healthCheckTime").textContent=network.blocked?"检测超时，等待系统连接结束后重试":state.diagnosticsResetting||network.checking?"连接检测中…":network.checked_at?"检查于 "+healthTime(network.checked_at)+(network.stale?" · 旧数据":""):"尚未检测连接";
  $("healthCheckTime").title=network.route==="system_proxy"?"检测采用系统代理；Codex 实际链路可能不同":"检测采用当前系统链路，可能经过 VPN 隧道";
  $("healthCheckButton").disabled=Boolean(state.diagnosticsBusy||network.checking||network.blocked);
  $("healthCheckButton").setAttribute("aria-busy",String(Boolean(state.diagnosticsBusy||network.checking)));
  const tasks=Array.isArray(data?.tasks)?data.tasks:[],issues=fresh&&Array.isArray(data?.recent_issues)?data.recent_issues:[],list=$("healthTaskList"),scroll=list.scrollTop;
  $("healthTaskSummary").textContent="各任务运行信号 · "+tasks.length+(fresh&&activity.quiet_tasks>0?" · "+activity.quiet_tasks+" 项静默":"");
  list.replaceChildren();
  for(const task of tasks){
    const row=node("li","health-task"),title=node("div","health-task-title");
    const name=node("strong","",String(task.name||"任务"));name.title=String(task.name||"任务");
    title.append(name,node("span","",fresh?healthAge(task.activity_age_seconds):"待同步"));
    row.dataset.signal=fresh?String(task.signal||"unknown"):"unknown";
    const meta=node("p","",healthPhase(task.phase)+" · "+"上报输出 "+(fresh?formatRate(task.output_tokens_per_min):"—")+"/min");
    meta.title=[task.model,task.effort].filter(value=>typeof value==="string").join(" · ")+" · "+"最近上报 "+healthAge(task.report_age_seconds);
    row.append(title,meta);list.append(row);
  }
  for(const issue of issues){
    const row=node("li","health-task"),title=node("div","health-task-title");
    title.append(node("strong","",String(issue.name||"任务")),node("span","",healthAge(issue.age_seconds)));
    row.dataset.signal="quiet";
    row.append(title,node("p","",issue.code==="http_connection_failed"?"最近回合连接失败":"最近回合执行错误"));list.append(row);
  }
  if(!tasks.length&&!issues.length)list.append(node("li","health-no-tasks",fresh?"暂无运行任务":"运行信号待同步"));
  list.scrollTop=scroll;syncBoardSize(false,false);
}
async function refreshDiagnostics(check=false) {
  if(state.diagnosticsBusy||state.diagnosticsStopped)return;
  state.diagnosticsBusy=true;state.diagnosticsResetting=check;renderDiagnostics();
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch(check?"/api/diagnostics/check":"/api/diagnostics",{cache:"no-store",signal:controller.signal,...(check?{method:"POST",headers:{"Content-Type":"application/json","X-Work-Twin":"1"},body:JSON.stringify({reset:true})}:{})});
    if(!response.ok)throw Error("运行检测暂不可用，请稍后重试");
    const data=await response.json();
    if(!data||!Number.isFinite(data.observed_at)||!data.activity)throw Error("运行检测暂不可用，请稍后重试");
    state.diagnostics=data;state.diagnosticsFailed=false;$("healthCheckError").hidden=true;
  }catch(error){
    state.diagnosticsFailed=true;
    if(check){$("healthCheckError").textContent="运行检测暂不可用，请稍后重试";$("healthCheckError").hidden=false;}
  }finally{
    clearTimeout(timeout);state.diagnosticsBusy=false;state.diagnosticsResetting=false;renderDiagnostics();
  }
}
function stopDiagnostics() {
  state.diagnosticsStopped=true;clearInterval(state.diagnosticsTimer);
}
function activityTime(card) {
  const seconds=value=>typeof value==="number"?value:typeof value==="string"?Date.parse(value)/1000:NaN;
  const times=[seconds(card.updated_at),seconds(card.runtime_observed_at)].filter(t=>Number.isFinite(t)&&t>0);
  return times.length?Math.max(...times):0;
}
function boardSets(now=Date.now()/1000) {
  const active=t=>t.status==="running"||(t.status==="unknown"&&t.last_observed_status==="running"&&t.sync_pending===true);
  const age=t=>activityTime(t)?Math.max(0,now-activityTime(t)):Infinity;
  const recent=state.threads.filter(t=>active(t)||age(t)<=86400);
  return {
    recent,
    board:recent.filter(t=>active(t)||t.unread),
    history:state.threads.filter(t=>!active(t)&&age(t)>86400&&age(t)<=7*86400),
  };
}
function filtered() {
  const rank=t=>t.status==="running"||(t.status==="unknown"&&t.last_observed_status==="running"&&t.sync_pending===true)?2:state.filter==="recent"&&!t.unread?1:0;
  const sorted=(boardSets()[state.filter]||[]).sort((a,b)=>rank(a)-rank(b)||activityTime(b)-activityTime(a));
  return projectGroups(sorted).flatMap(group=>group.cards);
}
function projectIdentity(card) {
  return String(card.cwd||card.project_label||"未关联项目");
}
function projectLabel(card) {
  if(card.project_label)return String(card.project_label);
  const parts=String(card.cwd||"").split(/[\\/]/).filter(Boolean);
  return parts.at(-1)||"未关联项目";
}
function projectTone(card) {
  let hash=2166136261;
  for(const character of projectIdentity(card))hash=Math.imul(hash^character.codePointAt(0),16777619);
  return String((hash>>>0)%8);
}
function projectGroups(cards) {
  const groups=[],byProject=new Map();
  for(const card of cards){
    const key=projectIdentity(card);
    let group=byProject.get(key);
    if(!group){group={key,label:projectLabel(card),tone:projectTone(card),cards:[]};byProject.set(key,group);groups.push(group);}
    group.cards.push(card);
  }
  return groups;
}
function projectHeading(group) {
  const heading=node("div","project-heading");
  heading.dataset.projectTone=group.tone;
  heading.setAttribute("role","heading");heading.setAttribute("aria-level","2");
  heading.append(node("span","project-swatch"),node("strong","",group.label),node("span","project-count",String(group.cards.length)));
  return heading;
}
function renderList(force=false) {
  const list=$("taskList");
  const existing=new Map([...list.querySelectorAll("[data-thread-id]")].map(row=>[row.dataset.threadId,row]));
  const wantedCards=filtered();
  $("syncLabel").textContent=wantedCards.length+" 项 · "+(state.observedAt?relativeTime(state.observedAt):"同步中");
  if(!force && state.listBusy) {
    const wanted=new Set(wantedCards.map(t=>t.id));
    const priorityChanged=wantedCards.some(card=>existing.get(card.id)?.dataset.status!==displayStatus(card));
    // Keep routine activity refreshes stable under hover/focus. State changes
    // apply the unread/read/running priority immediately, using the old badges.
    for(const card of wantedCards){const row=existing.get(card.id);if(row)updateTaskRow(row,card);}
    if(!priorityChanged&&existing.size===wanted.size&&[...existing.keys()].every(id=>wanted.has(id))){state.queuedRender=true;syncBoardSize();return;}
  }
  state.queuedRender=false;
  const rows=[];
  for(const group of projectGroups(wantedCards)){
    rows.push(projectHeading(group));
    for(const t of group.cards){
      const b=existing.get(t.id)||node("button","task-button");b.type="button";
      if(!existing.has(t.id))b.addEventListener("click",()=>selectThread(t.id));
      updateTaskRow(b,t);rows.push(b);
    }
  }
  if(!rows.length)rows.push(node("p","empty-note",state.filter==="board"?(state.connected?"当前待办已看完\n最近结果可在「近24小时」找回":"运行状态待同步"):state.filter==="history"?"24 小时至 7 天内暂无历史任务":"近 24 小时暂无任务"));
  const scroll=$("taskList").scrollTop;
  $("taskList").replaceChildren(...rows);$("taskList").scrollTop=scroll;
  syncBoardSize();
}
async function refresh(force=false) {
  state.readPlay?.syncPocket();
  if(state.refreshing){
    await state.refreshPromise;
    if(force)return refresh(true);
    return;
  }
  state.refreshing=true;
  state.refreshPromise=(async()=>{
  try{
    if(force){
      state.threads=[];state.weeklyUsage=null;state.usageDetails=null;state.observedAt=null;state.connected=false;
      $("connectionText").textContent="正在重新连接 Codex…";banner("");renderList(true);updateCounts();
    }
    const data=await api(force?"/api/refresh":"/api/threads",force?{}:undefined);
    state.readPlay?.setWeeklyHarvest(data.weekly_harvest);
    state.threads=data.threads||[];
    state.connected=data.health?.app_server==="online" && !data.error && !data.stale && !data.loading;
    $("connectionText").textContent=data.loading?"正在整理任务":state.connected?(data.coverage?.external_runtime==="local_events"?"Codex 已连接 · 正在同步运行状态":"Codex 已连接 · 部分状态待确认"):"同步中断 · 保留上次状态";
    state.observedAt=data.observed_at;
    state.weeklyUsage=data.health?.usage?.weekly||null;
    state.usageDetails=data.health?.usage?.details||null;
    if(data.error)banner(data.error);
    if(!data.loading) renderList(force);
    updateCounts();
  }catch(e){
    state.connected=false;$("connectionText").textContent="连接中断";banner(e.message);renderList(true);updateCounts();
  }finally{state.refreshing=false;}
  })();
  return state.refreshPromise;
}
function boardHeight(count,extra=0,groupCount=0) {
  return Math.min(420,Math.max(180,92+Math.max(1,count)*46+Math.min(groupCount,7)*18+extra));
}
function positionHealthPopover() {
  const panel=$("runtimeHealth"),anchor=$("runtimeHealthToggle"),app=$("appShell");
  if(!panel||panel.hidden||!anchor?.getBoundingClientRect||!app?.getBoundingClientRect)return;
  const root=app.getBoundingClientRect(),button=anchor.getBoundingClientRect();
  const width=panel.offsetWidth,center=button.left-root.left+button.width/2;
  const left=Math.max(9,Math.min(root.width-width-11,center-width/2));
  const top=button.bottom-root.top+9;
  panel.style.left=left+"px";panel.style.top=top+"px";
  panel.style.setProperty("--health-anchor-x",(center-left)+"px");
  $("runtimeHealthBody").style.maxHeight=Math.max(48,Math.min(230,root.height-top-40))+"px";
}
function syncBoardSize(force=false,activate=true) {
  if(state.mode!=="compact")return;
  const bannerHeight=$("systemBanner").hidden?0:$("systemBanner").offsetHeight,quotaHeight=Number($("quotaDetails")?.offsetHeight)||0;
  const health=$("runtimeHealth");
  const extra=bannerHeight+quotaHeight;
  const cards=filtered();
  const height=Math.max(boardHeight(cards.length,extra,projectGroups(cards).length),health&&!health.hidden?300:0);
  if(!force&&height===state.boardSize){positionHealthPopover();return;}
  state.boardSize=height;document.documentElement.style.setProperty("--board-height",height+"px");
  positionHealthPopover();
  if(state.petMode)invokeDesktop("set_pet_view",{view:"compact",height,activate}).catch(()=>{});
}
function cancelAutoCollapse() {
  clearTimeout(state.autoCollapseTimer);state.autoCollapseTimer=null;
}
function cancelHoverCollapse() {
  clearTimeout(state.hoverCollapseTimer);state.hoverCollapseTimer=null;
}
function expandFromHover() {
  state.pointerInside=true;cancelHoverCollapse();
  if(state.petMode&&state.mode==="collapsed"&&!state.petDragging)mode("compact",{activate:false});
}
function cancelHoverExpand() {
  clearTimeout(state.hoverExpandTimer);state.hoverExpandTimer=null;
}
function scheduleHoverExpand() {
  state.pointerInside=true;cancelHoverCollapse();cancelHoverExpand();
  if(!state.petMode||state.mode!=="collapsed"||state.petDragging)return;
  // Allow a press to claim the tree for dragging before the board replaces it.
  state.hoverExpandTimer=setTimeout(()=>{state.hoverExpandTimer=null;if(state.pointerInside)expandFromHover();},180);
}
function onNativePointer(inside) {
  if(typeof inside!=="boolean"||!state.petMode||inside===state.nativePointerInside)return;
  state.nativePointerInside=inside;
  if(inside)scheduleHoverExpand();
  else{cancelHoverExpand();scheduleHoverCollapse();}
}
async function pollNativePointer() {
  if(state.hoverTrackingStopped)return;
  try{
    const inside=await invokeDesktop("pet_pointer_inside");
    if(!state.hoverTrackingStopped)onNativePointer(inside);
  }catch(error){
    // Older native hosts retain DOM tracking until a native sample succeeds.
    if(!state.hoverPollWarned){console.warn("Monkex native hover unavailable",error);state.hoverPollWarned=true;}
  }finally{
    if(!state.hoverTrackingStopped)state.hoverPollTimer=setTimeout(pollNativePointer,120);
  }
}
function stopHoverTracking() {
  state.hoverTrackingStopped=true;clearTimeout(state.hoverPollTimer);cancelHoverExpand();cancelHoverCollapse();
}
function scheduleHoverCollapse() {
  state.pointerInside=false;cancelHoverCollapse();
  if(!state.petMode||state.mode!=="compact"||state.pinned||state.navigation?.pending)return;
  state.hoverCollapseTimer=setTimeout(()=>{
    state.hoverCollapseTimer=null;
    if(!state.pointerInside&&!state.pinned&&state.mode==="compact"&&!state.navigation?.pending)mode("collapsed");
  },300);
}
function syncPin() {
  const label=state.pinned?"拔起图钉 · 恢复移开鼠标自动收起":"钉住看板 · 移开鼠标后仍保持展开";
  $("pinButton").setAttribute("aria-pressed",String(state.pinned));
  $("pinButton").setAttribute("aria-label",label);$("pinButton").title=label;
}
function togglePin() {
  state.pinned=!state.pinned;cancelAutoCollapse();cancelHoverCollapse();
  try{localStorage.setItem("twin-pinned",String(state.pinned));}catch{}
  syncPin();
}
function onWindowFocus(event) {
  // Task navigation owns its success/read-feedback timer and error visibility.
  // Native window focus keeps ordinary control-to-control focus changes local.
  if(event.detail?.focused===false&&state.petMode&&state.mode==="compact"&&!state.pinned&&!state.navigation?.pending){
    mode("collapsed");
  }
}
async function selectThread(id) {
  cancelAutoCollapse();
  const revision=++state.selectionRevision;
  const opened=await state.navigation.navigate(id);
  if(opened&&revision===state.selectionRevision&&!state.pinned&&state.petMode&&$("systemBanner").hidden){
    state.autoCollapseTimer=setTimeout(()=>{
      state.autoCollapseTimer=null;
      if(revision===state.selectionRevision&&!state.pinned&&state.mode==="compact"&&!state.navigation.pending)mode("collapsed");
    },1200);
  }
  return opened;
}
function playQuotaCoin(event) {
  event.stopPropagation();
  const button=$("quotaCoinButton");
  button.getAnimations().forEach(animation=>animation.cancel());
  const frames=prefersReducedMotion()
    ? [{backgroundColor:'#ffe48a'},{backgroundColor:'transparent'}]
    : [{transform:'translateY(0) scale(1)'},{transform:'translateY(1px) scale(.88)',offset:.18},{transform:'translateY(-2px) scale(1.04)',offset:.5},{transform:'translateY(0) scale(1)'}];
  button.animate(frames,{duration:prefersReducedMotion()?180:420,easing:'ease-out'});
}
function stopQuotaCoinFeedback() {
  $("quotaCoinButton").getAnimations().forEach(animation=>animation.cancel());
}
async function refreshFromCoin(event) {
  playQuotaCoin(event);
  if(state.coinRefreshing)return;
  state.coinRefreshing=true;
  const button=$("quotaCoinButton");
  button.setAttribute("aria-busy","true");
  button.title="正在刷新任务与额度…";
  try{
    await refresh(true);
    button.title=weeklyQuotaState(state.weeklyUsage).state==="unknown"?"额度暂未同步，点击重试":state.weeklyUsage?.refresh_pending?"显示上次同步额度 · 正在自动重试":"已刷新 · 点击刷新任务与额度";
  }finally{
    state.coinRefreshing=false;button.setAttribute("aria-busy","false");
  }
}
function bindPetDrag() {
  const tree=$("petLauncher");
  let press=null,dragged=false,moves=Promise.resolve();
  const release=()=>{if(press&&tree.hasPointerCapture?.(press.id))tree.releasePointerCapture(press.id);press=null;state.petDragging=false;};
  tree.onpointerdown=e=>{
    if(e.button!==0||!state.petMode)return;
    cancelHoverCollapse();
    cancelHoverExpand();state.petDragging=true;
    dragged=false;press={id:e.pointerId,x:e.screenX,y:e.screenY};
    tree.setPointerCapture(e.pointerId);e.preventDefault();
  };
  tree.onpointermove=e=>{
    // Captured pointer lifetime owns the gesture; WKWebView may report buttons=0.
    if(!press||press.id!==e.pointerId)return;
    const dx=e.screenX-press.x,dy=e.screenY-press.y;
    if(!dragged&&Math.hypot(dx,dy)<4)return;
    if(!dragged){dragged=true;stopPetInteraction();}
    press.x=e.screenX;press.y=e.screenY;
    // Screen coordinates stay stable as the captured pointer moves the window.
    moves=moves.then(()=>invokeDesktop("move_pet_window",{dx,dy}))
      .catch(error=>{tree.title="拖动失败，可重试："+error;});
  };
  tree.onpointerup=release;
  tree.onpointercancel=release;
  tree.ondragstart=e=>e.preventDefault();
  tree.onclick=e=>{
    if(e.detail!==0&&dragged){e.preventDefault();return;}
    mode("compact");
  };
}
function bind() {
  window.addEventListener("work-twin-window-focus",onWindowFocus);
  $("quotaCoinButton").onclick=refreshFromCoin;
  $("quotaResetToggle").onclick=()=>setQuotaResetExpanded($("quotaResetWindows").hidden);
  $("resetCardDetails").ontoggle=()=>{if($("resetCardDetails").open)setHealthExpanded(false);syncBoardSize(false,false);};
  $("runtimeHealthToggle").onclick=()=>setHealthExpanded($("runtimeHealth").hidden);
  $("healthCloseButton").onclick=()=>setHealthExpanded(false);
  document.addEventListener("pointerdown",event=>{if(!$("runtimeHealth").hidden&&!event.target.closest("#runtimeHealth, #runtimeHealthToggle"))setHealthExpanded(false);});
  document.addEventListener("keydown",event=>{if(event.key==="Escape"&&!$("runtimeHealth").hidden){setHealthExpanded(false);$("runtimeHealthToggle").focus();}});
  $("healthCheckButton").onclick=()=>refreshDiagnostics(true);
  window.addEventListener("resize",()=>syncBoardSize(false,false));
  if(window.WorkTwinReadPlay)state.readPlay=new window.WorkTwinReadPlay({
    getContext:()=>({connected:state.connected,mode:state.mode,filter:state.filter,unreadRemaining:boardSets().recent.filter(t=>displayStatus(t)==="unread").length}),
    celebrate:()=>playPetInteraction(["hello","nod","idle"],180),
  });
  state.navigation=new window.WorkTwinTaskNavigation({
    getCard:id=>state.threads.find(card=>card.id===id),
    isConnected:()=>state.connected,
    api,
    onPending:id=>{state.openingId=id;renderList();},
    onOpened:id=>{state.selectedThreadId=id;banner("");},
    onRead:()=>{updateCounts();renderList();},
    onError:banner,
    readPlay:state.readPlay,
  });
  $("collapseButton").onclick=()=>mode(state.petMode?"collapsed":"compact");
  $("pinButton").onclick=togglePin;syncPin();
  document.querySelectorAll("[data-filter]").forEach(b=>b.onclick=()=>{
    state.filter=b.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach(c=>{c.classList.toggle("active",c===b);c.setAttribute("aria-pressed",String(c===b));});
    $("taskList").scrollTop=0;renderList(true);
  });
  const list=$("taskList");
  list.onmouseenter=()=>state.listBusy=true;
  list.onmouseleave=()=>{state.listBusy=false;if(state.queuedRender&&!list.contains(document.activeElement))renderList();};
  list.onfocusin=()=>state.listBusy=true;
  list.onfocusout=()=>setTimeout(()=>{if(!list.contains(document.activeElement)&&!list.matches(":hover")){state.listBusy=false;if(state.queuedRender)renderList();}},0);
  $("dragArea").onmousedown=e=>{if(e.button===0&&state.petMode){e.preventDefault();invokeDesktop("start_window_drag");}};
  bindPetDrag();
  // Native samples own desktop hover even while another application has focus.
  // DOM events serve browser previews and older hosts until the first sample.
  $("petLauncher").onmouseenter=()=>{if(state.nativePointerInside===null)scheduleHoverExpand();};
  document.documentElement.addEventListener("pointerenter",()=>{if(state.nativePointerInside===null){state.pointerInside=true;cancelHoverCollapse();}});
  document.documentElement.addEventListener("pointerleave",()=>{if(state.nativePointerInside===null){cancelHoverExpand();scheduleHoverCollapse();}});
  $("petShell").oncontextmenu=e=>{if(window.__TAURI__){e.preventDefault();invokeDesktop("show_pet_menu",{x:e.clientX,y:e.clientY,lang:document.documentElement.lang});}};
  window.addEventListener("work-twin-pet-mode",e=>mode(e.detail?.expanded?"compact":"collapsed"));
}
async function init() {
  if(state.petMode)document.documentElement.classList.add("pet-mode");
  const visibility=()=>{document.documentElement.dataset.pageHidden=String(document.hidden);};
  visibility();document.addEventListener("visibilitychange",()=>{visibility();if(document.hidden)stopQuotaCoinFeedback();updateCounts();});
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change',()=>{stopQuotaCoinFeedback();updateCounts();});
  window.addEventListener("pagehide",()=>{document.documentElement.dataset.pageHidden="true";});
  bind();
  window.addEventListener("pagehide",stopPetInteraction);
  window.addEventListener("pagehide",cancelAutoCollapse);
  window.addEventListener("pagehide",cancelHoverCollapse);
  window.addEventListener("pagehide",stopHoverTracking);
  window.addEventListener("pagehide",stopQuotaCoinFeedback);
  window.addEventListener("pagehide",()=>state.readPlay?.dispose());
  window.addEventListener("pagehide",stopDiagnostics);
  mode(state.petMode&&!state.pinned&&params.get("expanded")!=="1"?"collapsed":"compact");
  if(state.petMode&&window.__TAURI__?.core?.invoke)pollNativePointer();
  refreshDiagnostics();
  state.diagnosticsTimer=setInterval(refreshDiagnostics,5000);
  await refresh();
  document.documentElement.dataset.monkexBoot="ready";
  try{sessionStorage.removeItem("monkex-boot-retry");}catch{}
  setInterval(refresh,5000);
  const events=new EventSource("/api/events");
  for(const name of ["feed_updated","task_started","user_gate_required","user_gate_resolved","codex_event"]){
    events.addEventListener(name,e=>{
      if(name==="codex_event"){
        const payload=JSON.parse(e.data||"{}");
        if(!["turn/completed","turn/started","item/completed"].includes(payload.method))return;
      }
      refresh();
    });
  }
  // SSE is an update hint; the polled task and quota responses own their health.
  events.onerror=()=>{refresh();};
}
init();
