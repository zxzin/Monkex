const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const state = {
  threads: [], selectedThreadId: null, openingId: null, filter: "board", observedAt: null, weeklyUsage: null,
  petMode: params.get("pet") === "1", petExpanded: false,
  mode: "compact", pinned: localStorage.getItem("twin-pinned") === "true",
  connected: false, refreshing: false, listBusy: false, queuedRender: false,
  petInteractionTimer: null, petInteractionResolve: null, petInteractionToken: 0,
  petInteractionCooldownUntil: 0, boardSize: 0, autoCollapseTimer: null, selectionRevision: 0,
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
  return {running:"进行中",unread:"未读",read:"已读"}[displayStatus(card)];
}
function displayStatus(card) {
  return state.connected&&card.status==="running"?"running":card.unread?"unread":"read";
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
  button.setAttribute("aria-pressed",String(card.id===state.selectedThreadId));
  button.setAttribute("aria-busy",String(card.id===state.openingId));
  button.disabled=card.id===state.openingId;
  button.title=card.name+" · "+shortStatus(card)+"\n"+(card.project_label||"")+" · "+relativeTime(activityTime(card))+(card.task_brief?"\nAI 摘要："+card.task_brief:"")+"\n点击在 Codex 中打开";
  const icon=node("i","task-state");icon.setAttribute("aria-hidden","true");
  const copy=node("div","task-copy"),title=node("div","task-title-line");
  title.append(node("strong","",card.name));
  title.append(node("span","row-status",shortStatus(card)));
  const meta=node("div","task-meta"),brief=node("span",card.task_brief?"stage ai-brief":"stage",card.task_brief||card.summary||card.project_label||"任务");
  brief.title=briefExplanation(card);meta.append(brief);
  if(status==="running"){
    const speed=node("span","row-rate");speed.title="当前任务 · 近 60 秒 Token 消耗速度，含输入与输出";
    const fan=node("span","token-fan mini-fan");renderTokenFan(fan,card.tokens,true);
    speed.append(fan,node("span","",rateText(card.tokens)));meta.append(speed);
  }else meta.append(node("time","",relativeTime(activityTime(card))));
  copy.append(title,meta);button.replaceChildren(icon,copy);
}
function briefExplanation(card) {
  if(card.task_brief)return "AI 摘要 · "+(card.brief_status==="ready"?"依据近期对话":"上次摘要，等待更新")+"\n"+card.task_brief;
  if(card.summary)return "最近进展 · "+card.summary;
  return {pending:"正在概括近期对话",insufficient:"对话信息不足，暂时保留原任务名",unavailable:"AI 摘要暂不可用，稍后重试"}[card.brief_status]||"";
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
function mode(value) {
  state.mode = value;
  cancelAutoCollapse();
  if(value==="collapsed"){state.readPlay?.suspend();setSettings(false);}
  state.petExpanded = value !== "collapsed";
  if (state.petExpanded) stopPetInteraction();
  document.documentElement.dataset.mode = value;
  $("petShell").hidden = !state.petMode || value !== "collapsed";
  $("appShell").hidden = state.petMode && value === "collapsed";
  if(value==="compact")syncBoardSize(true);
  else if(state.petMode)invokeDesktop("set_pet_view",{view:value}).catch(e=>banner("窗口调整失败："+e));
}
function updateCounts() {
  if(!state.connected)state.readPlay?.suspend();
  $("connectionDot").dataset.connected=String(state.connected);
  const connectionLabel=state.connected?"已连接 Codex；点击任务打开原对话":"连接中断，保留上次记录";
  $("connectionDot").title=connectionLabel;$("connectionDot").setAttribute("aria-label",connectionLabel);
  const quota=weeklyQuotaState(state.weeklyUsage);
  $("weeklyRemaining").textContent=quota.label;
  $("weeklyQuota").dataset.state=quota.state;
  const reset=state.weeklyUsage?.resets_at;
  $("weeklyQuota").title=quota.state==="unknown"?"Codex 周订阅额度待同步":"Codex 账户本周剩余 "+quota.label+(reset?" · 重置于 "+new Date(reset*1000).toLocaleString("zh-CN"):"");
  $("petQuotaRemaining").textContent=quota.label;
  $("petQuota").dataset.state=quota.state;
  $("petQuota").title=$("weeklyQuota").title;
  const groups=boardSets();
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
  $("petLauncher").title=label+" · "+quotaLabel+" · 点击查看任务";
  $("petLauncher").setAttribute("aria-label",label+"，"+quotaLabel+"，展开任务动态");
  window.WorkTwinBananaTree?.render($("petHarvest"),unread,state.connected);
  window.WorkTwinBananaTree.renderGrowth($("petGrowth"),running,state.connected);
}
function weeklyQuotaState(usage,now=Date.now()/1000) {
  const valid=state.connected&&usage?.available&&Number.isFinite(usage.remaining_percent)&&
    Number.isFinite(usage.observed_at)&&now-usage.observed_at<=90&&now-usage.observed_at>=-30&&
    (usage.resets_at==null||usage.resets_at>now);
  if(!valid)return {label:"—",state:"unknown"};
  const remaining=Math.max(0,Math.min(100,usage.remaining_percent));
  return {label:String(Math.round(remaining*10)/10)+"%",state:remaining<=20?"low":"normal"};
}
function activityTime(card) {
  const seconds=value=>typeof value==="number"?value:typeof value==="string"?Date.parse(value)/1000:NaN;
  const times=[seconds(card.updated_at),seconds(card.runtime_observed_at)].filter(t=>Number.isFinite(t)&&t>0);
  return times.length?Math.max(...times):0;
}
function boardSets(now=Date.now()/1000) {
  const active=t=>state.connected&&t.status==="running";
  const age=t=>activityTime(t)?Math.max(0,now-activityTime(t)):Infinity;
  const recent=state.threads.filter(t=>active(t)||age(t)<=86400);
  return {
    recent,
    board:recent.filter(t=>active(t)||t.unread),
    history:state.threads.filter(t=>!active(t)&&age(t)>86400&&age(t)<=7*86400),
  };
}
function filtered() {
  const query=$("searchInput").value.trim().toLowerCase();
  const rank=t=>state.connected&&t.status==="running"?2:state.filter==="recent"&&!t.unread?1:0;
  return (boardSets()[state.filter]||[]).filter(t=>
    (!query || [t.task_brief,t.summary,t.name,t.project_label].join(" ").toLowerCase().includes(query))
  ).sort((a,b)=>rank(a)-rank(b)||activityTime(b)-activityTime(a));
}
function renderList(force=false) {
  const list=$("taskList");
  const existing=new Map([...list.querySelectorAll("[data-thread-id]")].map(row=>[row.dataset.threadId,row]));
  const wantedCards=filtered();
  $("syncLabel").textContent=wantedCards.length+" 项 · "+(state.observedAt?relativeTime(state.observedAt):"同步中");
  if(!force && state.listBusy) {
    const wanted=new Set(wantedCards.map(t=>t.id));
    // Refresh text, status and measured speed in place; keep the hovered order.
    for(const card of wantedCards){const row=existing.get(card.id);if(row)updateTaskRow(row,card);}
    if(existing.size===wanted.size&&[...existing.keys()].every(id=>wanted.has(id))){state.queuedRender=true;syncBoardSize();return;}
  }
  state.queuedRender=false;
  const rows=wantedCards.map(t=>{
    const b=existing.get(t.id)||node("button","task-button");b.type="button";
    if(!existing.has(t.id))b.addEventListener("click",()=>selectThread(t.id));
    updateTaskRow(b,t);return b;
  });
  if(!rows.length)rows.push(node("p","empty-note",$("searchInput").value?"当前时间范围内没有匹配任务":state.filter==="board"?(state.connected?"当前待办已看完\n最近结果可在「近24小时」找回":"运行状态待同步"):state.filter==="history"?"24 小时至 7 天内暂无历史任务":"近 24 小时暂无任务"));
  const scroll=$("taskList").scrollTop;
  $("taskList").replaceChildren(...rows);$("taskList").scrollTop=scroll;
  syncBoardSize();
}
async function refresh() {
  if(state.refreshing)return;
  state.refreshing=true;
  try{
    const data=await api("/api/threads");
    state.threads=data.threads||[];
    state.connected=data.health?.app_server==="online" && !data.error && !data.stale && !data.loading;
    $("connectionText").textContent=data.loading?"正在整理任务":state.connected?(data.coverage?.external_runtime==="local_events"?"Codex 已连接 · 正在同步运行状态":"Codex 已连接 · 部分状态待确认"):"同步中断 · 保留上次状态";
    state.observedAt=data.observed_at;
    state.weeklyUsage=data.health?.usage?.weekly||null;
    if(data.error)banner(data.error);
    if(!data.loading) renderList();
    updateCounts();
  }catch(e){
    state.connected=false;$("connectionText").textContent="连接中断";banner(e.message);renderList(true);updateCounts();
  }finally{state.refreshing=false;}
}
function boardHeight(count,extra=0) {
  return Math.min(420,Math.max(180,92+Math.max(1,count)*46+extra));
}
function syncBoardSize(force=false) {
  if(state.mode!=="compact")return;
  const settings=$("boardSettings"),extra=(settings.hidden?0:settings.offsetHeight+8)+($("systemBanner").hidden?0:$("systemBanner").offsetHeight);
  const height=boardHeight(filtered().length,extra);
  if(!force&&height===state.boardSize)return;
  state.boardSize=height;document.documentElement.style.setProperty("--board-height",height+"px");
  if(state.petMode)invokeDesktop("set_pet_view",{view:"compact",height}).catch(()=>{});
}
function cancelAutoCollapse() {
  clearTimeout(state.autoCollapseTimer);state.autoCollapseTimer=null;
}
function syncPin() {
  const label=state.pinned?"拔起图钉 · 跳转后自动收起":"钉住看板 · 跳转后保持展开";
  $("pinButton").setAttribute("aria-pressed",String(state.pinned));
  $("pinButton").setAttribute("aria-label",label);$("pinButton").title=label;
}
function togglePin() {
  state.pinned=!state.pinned;cancelAutoCollapse();
  try{localStorage.setItem("twin-pinned",String(state.pinned));}catch{}
  syncPin();
}
function setSettings(open) {
  cancelAutoCollapse();
  $("boardSettings").hidden=!open;
  $("greetMonkey").setAttribute("aria-expanded",String(open));
  if(!open&&$("searchInput").value){$("searchInput").value="";renderList(true);}
  syncBoardSize();
  if(open)$("searchInput").focus();
}
async function selectThread(id) {
  cancelAutoCollapse();
  const revision=++state.selectionRevision;
  const opened=await state.navigation.navigate(id);
  if(opened&&revision===state.selectionRevision&&!state.pinned&&state.petMode&&$("systemBanner").hidden){
    state.autoCollapseTimer=setTimeout(()=>{
      state.autoCollapseTimer=null;
      if(revision===state.selectionRevision&&!state.pinned&&state.mode==="compact"&&$("boardSettings").hidden&&!state.navigation.pending)mode("collapsed");
    },1200);
  }
  return opened;
}
function bind() {
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
  $("searchInput").oninput=()=>renderList(true);
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
  for(const id of ["petDragHandle","dragArea"])$(id).onmousedown=e=>{if(e.button===0&&state.petMode){e.preventDefault();invokeDesktop("start_window_drag");}};
  $("petLauncher").onmouseenter=()=>{if(Date.now()>state.petInteractionCooldownUntil){state.petInteractionCooldownUntil=Date.now()+2000;playPetInteraction(["hello","peek","idle"],380);}};
  $("petLauncher").onclick=()=>mode("compact");
  $("greetMonkey").onclick=()=>{const open=$("boardSettings").hidden;setSettings(open);if(open)playPetInteraction(["hello","idle"],180);};
  document.addEventListener("click",event=>{
    if(!$("boardSettings").hidden&&!$("boardSettings").contains(event.target)&&!$("greetMonkey").contains(event.target))setSettings(false);
  });
  document.addEventListener("keydown",event=>{
    if(event.key==="Escape"&&!$("boardSettings").hidden){event.preventDefault();setSettings(false);$("greetMonkey").focus();}
  });
  $("petShell").oncontextmenu=e=>{if(window.__TAURI__){e.preventDefault();invokeDesktop("show_pet_menu",{x:e.clientX,y:e.clientY});}};
  window.addEventListener("work-twin-pet-mode",e=>mode(e.detail?.expanded?"compact":"collapsed"));
}
async function init() {
  if(state.petMode)document.documentElement.classList.add("pet-mode");
  const visibility=()=>{document.documentElement.dataset.pageHidden=String(document.hidden);};
  visibility();document.addEventListener("visibilitychange",visibility);
  window.addEventListener("pagehide",()=>{document.documentElement.dataset.pageHidden="true";});
  bind();
  window.addEventListener("pagehide",stopPetInteraction);
  window.addEventListener("pagehide",cancelAutoCollapse);
  window.addEventListener("pagehide",()=>state.readPlay?.dispose());
  mode(state.petMode&&!state.pinned&&params.get("expanded")!=="1"?"collapsed":"compact");
  await refresh();
  setInterval(refresh,5000);
  const events=new EventSource("/api/events");
  for(const name of ["feed_updated","summaries_updated","task_started","user_gate_required","user_gate_resolved","codex_event"]){
    events.addEventListener(name,e=>{
      if(name==="codex_event"){
        const payload=JSON.parse(e.data||"{}");
        if(!["turn/completed","turn/started","item/completed"].includes(payload.method))return;
      }
      refresh();
    });
  }
  events.onerror=()=>{state.connected=false;renderList(true);updateCounts();};
}
init();
