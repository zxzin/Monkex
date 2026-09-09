const englishSystemMessage=value=>[["\u8bf7\u5b89\u88c5\u5e76\u767b\u5f55 Codex\uff1b\u627e\u4e0d\u5230\u7a0b\u5e8f\u65f6\u8bbe\u7f6e MONKEX_CODEX_PATH \u540e\u91cd\u542f Monkex","Install and sign in to Codex. If it cannot be found, set MONKEX_CODEX_PATH and restart Monkex."],["\u8bf7\u5148\u5b89\u88c5\u5e76\u767b\u5f55 Codex\uff1b\u53ef\u901a\u8fc7 MONKEX_CODEX_PATH \u6307\u5b9a Codex \u53ef\u6267\u884c\u6587\u4ef6","Install and sign in to Codex. Use MONKEX_CODEX_PATH for a nonstandard executable location."],["Codex App Server \u521d\u59cb\u5316\u5931\u8d25","Codex App Server initialization failed."],["Codex App Server \u8fde\u63a5\u5df2\u5173\u95ed","Codex App Server connection closed."],["Codex App Server \u5df2\u5173\u95ed","Codex App Server is closed."],["Codex App Server \u672a\u8fd0\u884c","Codex App Server is not running."],["\u4efb\u52a1\u540c\u6b65\u6682\u65f6\u4e2d\u65ad\uff0c\u4fdd\u7559\u4e0a\u6b21\u89c2\u6d4b\u7ed3\u679c","Task sync interrupted. Keeping the last observation."],["\u672c\u673a\u5de5\u4f5c\u5206\u8eab\u670d\u52a1\u53d1\u751f\u5185\u90e8\u9519\u8bef","The local Monkex service encountered an internal error."],["\u4ec5\u63a5\u53d7\u672c\u673a\u5de5\u4f5c\u5206\u8eab\u7a97\u53e3\u7684\u8bf7\u6c42","Only local Monkex window requests are accepted."],["\u8bf7\u6c42\u5fc5\u987b\u662f JSON \u5bf9\u8c61","The request must be a JSON object."],["\u5de5\u4f5c\u5206\u8eab\u58f3\u5b50\u72b6\u6001\u7248\u672c\u4e0d\u517c\u5bb9","Incompatible Monkex state version."],["Monkex \u83dc\u5355\u72b6\u6001\u635f\u574f","Monkex menu state is damaged"],["\u5de5\u4f5c\u5206\u8eab\u58f3\u5b50\u72b6\u6001\u7ed3\u6784\u635f\u574f","Invalid Monkex state structure."],["Codex \u4efb\u52a1\u6570\u636e\u65e0\u6548","Invalid Codex task data."],["Monkex \u83dc\u5355\u4e0d\u53ef\u7528","Monkex menu is unavailable"],["Codex \u8bf7\u6c42\u8d85\u65f6\uff1a","Codex request timed out: "],["\u8bf7\u6c42 JSON \u65e0\u6548","Invalid JSON request."],["\u5de5\u4f5c\u5206\u8eab\u58f3\u5b50\u72b6\u6001\u635f\u574f","Monkex state is damaged."],["\u8bf7\u6c42\u6765\u6e90\u6821\u9a8c\u5931\u8d25","Request origin verification failed."],["\u4efb\u52a1 ID \u65e0\u6548","Invalid task ID."],["\u8bf7\u6c42\u957f\u5ea6\u65e0\u6548","Invalid request length."],["\u8bf7\u6c42\u5185\u5bb9\u8fc7\u5927","Request too large."],["\u8d44\u6e90\u8def\u5f84\u65e0\u6548","Invalid resource path."],["\u8fd4\u56de\u7ed3\u679c\u65e0\u6548","Invalid response"],["\u7a97\u53e3\u6a21\u5f0f\u65e0\u6548","Invalid window mode"],["\u62d6\u52a8\u4f4d\u79fb\u65e0\u6548","Invalid drag displacement"],["\u63a5\u53e3\u4e0d\u5b58\u5728","Endpoint not found."],["\u8d44\u6e90\u4e0d\u5b58\u5728","Resource not found."],["\u5b9a\u4f4d\u539f\u4efb\u52a1","Locate original task"],["\u5931\u8d25\uff1a"," failed: "]].reduce((message,[from,to])=>message.split(from).join(to),String(value||''));
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
  return {running:"Running",unread:"Unread",read:"Read"}[displayStatus(card)];
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
  const label="Token activity · "+rateText(tokens)+(running&&period?" · Spins faster with higher usage":" · Idle");
  container.setAttribute("aria-label",label);container.title=label;
}
function updateTaskRow(button,card) {
  const status=displayStatus(card);
  button.dataset.status=status;button.dataset.threadId=card.id;
  button.setAttribute("aria-pressed",String(card.id===state.selectedThreadId));
  button.setAttribute("aria-busy",String(card.id===state.openingId));
  button.disabled=card.id===state.openingId;
  button.title=card.name+" · "+shortStatus(card)+"\n"+(card.project_label||"")+" · "+relativeTime(activityTime(card))+"\nClick to open in Codex";
  const icon=node("i","task-state");icon.setAttribute("aria-hidden","true");
  const copy=node("div","task-copy"),title=node("div","task-title-line");
  title.append(node("strong","",card.name));
  title.append(node("span","row-status",shortStatus(card)));
  const meta=node("div","task-meta"),progress=node("span","stage",card.summary||card.project_label||"Task");
  progress.title=card.summary?"Latest progress · "+card.summary:"";meta.append(progress);
  if(status==="running"){
    const speed=node("span","row-rate");speed.title="This task · Token usage over the last 60 seconds, including input and output";
    const fan=node("span","token-fan mini-fan");renderTokenFan(fan,card.tokens,true);
    speed.append(fan,node("span","",rateText(card.tokens)));meta.append(speed);
  }else meta.append(node("time","",relativeTime(activityTime(card))));
  copy.append(title,meta);button.replaceChildren(icon,copy);
}
async function api(path, body) {
  const response = await fetch(path, {
    cache: "no-store",
    ...(body === undefined ? {} : {method:"POST", headers:{"Content-Type":"application/json","X-Work-Twin":"1"}, body:JSON.stringify(body)})
  }).catch(()=>{throw Error("Cannot connect right now. Please try again.");});
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "Request failed");
  return result;
}
function banner(message) {
  message=englishSystemMessage(message);
  $("systemBanner").textContent = message || "";
  $("systemBanner").hidden = !message;
  syncBoardSize();
}
function relativeTime(value) {
  const t = typeof value === "number" ? value * 1000 : Date.parse(value);
  if (!Number.isFinite(t)) return "Pending sync";
  const seconds = Math.max(0, Math.floor((Date.now()-t)/1000));
  if (seconds<60) return "Just now";
  if(seconds<3600) return Math.floor(seconds/60)+" min ago";
  if(seconds<86400) return Math.floor(seconds/3600)+" hr ago";
  return Math.floor(seconds/86400)+" d ago";
}
function mode(value) {
  state.mode = value;
  cancelAutoCollapse();
  if(value==="collapsed")state.readPlay?.suspend();
  state.petExpanded = value !== "collapsed";
  if (state.petExpanded) stopPetInteraction();
  document.documentElement.dataset.mode = value;
  $("petShell").hidden = !state.petMode || value !== "collapsed";
  $("appShell").hidden = state.petMode && value === "collapsed";
  if(value==="compact")syncBoardSize(true);
  else if(state.petMode)invokeDesktop("set_pet_view",{view:value}).catch(e=>banner("Could not resize window: "+e));
}
function updateCounts() {
  state.readPlay?.syncPocket();
  if(!state.connected)state.readPlay?.suspend();
  $("connectionDot").dataset.connected=String(state.connected);
  const connectionLabel=state.connected?"Connected to Codex; click a task to open its conversation":"Disconnected; showing last known tasks";
  $("connectionDot").title=connectionLabel;$("connectionDot").setAttribute("aria-label",connectionLabel);
  const quota=weeklyQuotaState(state.weeklyUsage);
  $("weeklyRemaining").textContent=quota.label;
  $("weeklyQuota").dataset.state=quota.state;
  const reset=state.weeklyUsage?.resets_at;
  $("weeklyQuota").title=quota.state==="unknown"?"Waiting for Codex weekly quota":"Codex weekly quota remaining: "+quota.label+(reset?" · Resets at "+new Date(reset*1000).toLocaleString("en-US"):"");
  if(quota.state!=="unknown"&&(!state.connected||state.weeklyUsage.refresh_pending)){
    $("weeklyQuota").title+=" · Last synced "+new Date(state.weeklyUsage.observed_at*1000).toLocaleTimeString("en-US")+" · Retrying sync";
  }
  $("petQuotaRemaining").textContent=quota.label;
  $("petQuota").dataset.state=quota.state;
  $("petQuota").title=$("weeklyQuota").title;
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
  const quotaLabel=quota.state==="unknown"?"Weekly quota pending":"Weekly "+quota.label;
  $("petLauncher").title=label+" · "+quotaLabel+" · Hold to drag · Click to expand · Right-click to quit";
  $("petLauncher").setAttribute("aria-label",label+", "+quotaLabel+", open task board");
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
function renderQuotaFlow(element,cards,quota) {
  // A slow, fixed-speed turn signals observed activity while preserving the banana face.
  const now=Date.now()/1000;
  const rate=state.connected?cards.reduce((sum,card)=>{
    const tokens=card.tokens;
    const fresh=Number.isFinite(tokens?.last_report_at)&&now-tokens.last_report_at<=60&&now-tokens.last_report_at>=-30;
    return sum+(card.status==='running'&&fresh&&tokens?.ready&&Number.isFinite(tokens.tokens_per_min)&&tokens.tokens_per_min>0?tokens.tokens_per_min:0);
  },0):0;
  element.dataset.flowing=String(rate>0&&quota.state!=='unknown');
  const description=rate>0?' · Total token rate over the last 60 seconds: '+Math.round(rate).toLocaleString()+' /min · Slow coin rotation indicates activity, not per-coin billing':' · No recent token usage observed';
  element.title+=description;
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
  const rank=t=>state.connected&&t.status==="running"?2:state.filter==="recent"&&!t.unread?1:0;
  return (boardSets()[state.filter]||[]).sort((a,b)=>rank(a)-rank(b)||activityTime(b)-activityTime(a));
}
function renderList(force=false) {
  const list=$("taskList");
  const existing=new Map([...list.querySelectorAll("[data-thread-id]")].map(row=>[row.dataset.threadId,row]));
  const wantedCards=filtered();
  $("syncLabel").textContent=wantedCards.length+" tasks · "+(state.observedAt?relativeTime(state.observedAt):"Syncing");
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
  if(!rows.length)rows.push(node("p","empty-note",state.filter==="board"?(state.connected?"All caught up\nRecent results are in 24 hours":"Waiting for running status"):state.filter==="history"?"No tasks from 24 hours to 7 days ago":"No tasks in the last 24 hours"));
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
    const data=await api(force?"/api/refresh":"/api/threads",force?{}:undefined);
    state.readPlay?.setWeeklyHarvest(data.weekly_harvest);
    state.threads=data.threads||[];
    state.connected=data.health?.app_server==="online" && !data.error && !data.stale && !data.loading;
    $("connectionText").textContent=data.loading?"Preparing tasks":state.connected?(data.coverage?.external_runtime==="local_events"?"Codex connected · Syncing live status":"Codex connected · Some statuses pending"):"Sync interrupted · Keeping last known state";
    state.observedAt=data.observed_at;
    state.weeklyUsage=data.health?.usage?.weekly||null;
    if(data.error)banner(data.error);
    if(!data.loading) renderList(force);
    updateCounts();
  }catch(e){
    state.connected=false;$("connectionText").textContent="Disconnected";banner(e.message);renderList(true);updateCounts();
  }finally{state.refreshing=false;}
  })();
  return state.refreshPromise;
}
function boardHeight(count,extra=0) {
  return Math.min(420,Math.max(180,92+Math.max(1,count)*46+extra));
}
function syncBoardSize(force=false) {
  if(state.mode!=="compact")return;
  const extra=$("systemBanner").hidden?0:$("systemBanner").offsetHeight;
  const height=boardHeight(filtered().length,extra);
  if(!force&&height===state.boardSize)return;
  state.boardSize=height;document.documentElement.style.setProperty("--board-height",height+"px");
  if(state.petMode)invokeDesktop("set_pet_view",{view:"compact",height}).catch(()=>{});
}
function cancelAutoCollapse() {
  clearTimeout(state.autoCollapseTimer);state.autoCollapseTimer=null;
}
function syncPin() {
  const label=state.pinned?"Unpin · Collapse when switching windows":"Pin · Stay open when switching windows";
  $("pinButton").setAttribute("aria-pressed",String(state.pinned));
  $("pinButton").setAttribute("aria-label",label);$("pinButton").title=label;
}
function togglePin() {
  state.pinned=!state.pinned;cancelAutoCollapse();
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
  button.title="Refreshing tasks and quota…";
  try{
    await refresh(true);
    button.title=weeklyQuotaState(state.weeklyUsage).state==="unknown"?"Quota pending; click to retry":state.weeklyUsage?.refresh_pending?"Showing last synced quota · Retrying automatically":"Updated · Click to refresh tasks and quota";
  }finally{
    state.coinRefreshing=false;button.setAttribute("aria-busy","false");
  }
}
function bindPetDrag() {
  const tree=$("petLauncher");
  let press=null,dragged=false,moves=Promise.resolve();
  const release=()=>{if(press&&tree.hasPointerCapture?.(press.id))tree.releasePointerCapture(press.id);press=null;};
  tree.onpointerdown=e=>{
    if(e.button!==0||!state.petMode)return;
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
      .catch(error=>{tree.title="Drag failed; try again: "+error;});
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
  $("petLauncher").onmouseenter=()=>{if(Date.now()>state.petInteractionCooldownUntil){state.petInteractionCooldownUntil=Date.now()+2000;playPetInteraction(["hello","peek","idle"],380);}};
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
  window.addEventListener("pagehide",stopQuotaCoinFeedback);
  window.addEventListener("pagehide",()=>state.readPlay?.dispose());
  mode(state.petMode&&!state.pinned&&params.get("expanded")!=="1"?"collapsed":"compact");
  await refresh();
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
