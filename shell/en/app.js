const englishSystemMessage=value=>[["\u8bf7\u5b89\u88c5\u5e76\u767b\u5f55 Codex\uff1b\u627e\u4e0d\u5230\u7a0b\u5e8f\u65f6\u8bbe\u7f6e MONKEX_CODEX_PATH \u540e\u91cd\u542f Monkex","Install and sign in to Codex. If it cannot be found, set MONKEX_CODEX_PATH and restart Monkex."],["\u8bf7\u5148\u5b89\u88c5\u5e76\u767b\u5f55 Codex\uff1b\u53ef\u901a\u8fc7 MONKEX_CODEX_PATH \u6307\u5b9a Codex \u53ef\u6267\u884c\u6587\u4ef6","Install and sign in to Codex. Use MONKEX_CODEX_PATH for a nonstandard executable location."],["Codex \u8fde\u63a5\u6682\u65f6\u4e2d\u65ad\uff0c\u6b63\u5728\u91cd\u8bd5\uff1b\u53ef\u70b9\u51fb\u91d1\u5e01\u91cd\u65b0\u8fde\u63a5","Codex connection interrupted. Retrying; click the coin to reconnect."],["Codex App Server \u521d\u59cb\u5316\u5931\u8d25","Codex App Server initialization failed."],["Codex App Server \u8fde\u63a5\u5df2\u5173\u95ed","Codex App Server connection closed."],["Codex App Server \u5df2\u5173\u95ed","Codex App Server is closed."],["Codex App Server \u672a\u8fd0\u884c","Codex App Server is not running."],["\u672c\u673a\u5de5\u4f5c\u5206\u8eab\u670d\u52a1\u53d1\u751f\u5185\u90e8\u9519\u8bef","The local Monkex service encountered an internal error."],["\u4ec5\u63a5\u53d7\u672c\u673a\u5de5\u4f5c\u5206\u8eab\u7a97\u53e3\u7684\u8bf7\u6c42","Only local Monkex window requests are accepted."],["\u8bf7\u6c42\u5fc5\u987b\u662f JSON \u5bf9\u8c61","The request must be a JSON object."],["\u5de5\u4f5c\u5206\u8eab\u58f3\u5b50\u72b6\u6001\u7248\u672c\u4e0d\u517c\u5bb9","Incompatible Monkex state version."],["Monkex \u83dc\u5355\u72b6\u6001\u635f\u574f","Monkex menu state is damaged"],["\u5de5\u4f5c\u5206\u8eab\u58f3\u5b50\u72b6\u6001\u7ed3\u6784\u635f\u574f","Invalid Monkex state structure."],["Codex \u4efb\u52a1\u6570\u636e\u65e0\u6548","Invalid Codex task data."],["Monkex \u83dc\u5355\u4e0d\u53ef\u7528","Monkex menu is unavailable"],["Codex \u8bf7\u6c42\u8d85\u65f6\uff1a","Codex request timed out: "],["\u8bf7\u6c42 JSON \u65e0\u6548","Invalid JSON request."],["\u5de5\u4f5c\u5206\u8eab\u58f3\u5b50\u72b6\u6001\u635f\u574f","Monkex state is damaged."],["\u8bf7\u6c42\u6765\u6e90\u6821\u9a8c\u5931\u8d25","Request origin verification failed."],["\u4efb\u52a1 ID \u65e0\u6548","Invalid task ID."],["\u8bf7\u6c42\u957f\u5ea6\u65e0\u6548","Invalid request length."],["\u8bf7\u6c42\u5185\u5bb9\u8fc7\u5927","Request too large."],["\u8d44\u6e90\u8def\u5f84\u65e0\u6548","Invalid resource path."],["\u8fd4\u56de\u7ed3\u679c\u65e0\u6548","Invalid response"],["\u7a97\u53e3\u6a21\u5f0f\u65e0\u6548","Invalid window mode"],["\u62d6\u52a8\u4f4d\u79fb\u65e0\u6548","Invalid drag displacement"],["\u63a5\u53e3\u4e0d\u5b58\u5728","Endpoint not found."],["\u8d44\u6e90\u4e0d\u5b58\u5728","Resource not found."],["\u5b9a\u4f4d\u539f\u4efb\u52a1","Locate original task"],["\u5931\u8d25\uff1a"," failed: "]].reduce((message,[from,to])=>message.split(from).join(to),String(value||''));
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
  return {running:"Running",pending:"Pending sync",unread:"Completed",read:"Read"}[displayStatus(card)];
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
  if(displayStatus(card)==="pending"||runtime.observation_available===false)return {label:"Pending sync",hint:"Runtime records are pending sync; the last task state is retained"};
  const age=Number.isFinite(runtime.activity_at)?now-runtime.activity_at:null;
  const reportFresh=Number.isFinite(tokens.last_report_at)&&now-tokens.last_report_at<=60&&now-tokens.last_report_at>=-30;
  if(reportFresh&&tokens.ready&&tokens.tokens_per_min>0)return {label:formatRate(tokens.tokens_per_min)+" t/min",hint:"Reported token usage over 60 seconds, including input, cache and output; this is a usage rate"};
  if(runtime.pending_tools>0)return {label:age!==null&&age>=180?"Tool wait":"Tool call",hint:"A tool call has started without a completion record. Local Python and other tools may produce no new token reports"};
  if(age!==null&&age>=180)return {label:"Unconfirmed",hint:"No new activity for a while; the task may be reasoning or waiting. Check the original conversation"};
  if(runtime.phase==="starting")return {label:"Awaiting response",hint:"The turn has started; no first model or tool activity has been observed"};
  if(runtime.phase==="thinking")return {label:"Reasoning",hint:"The latest record is reasoning activity; usage reporting may lag"};
  if(runtime.phase==="response")return {label:"Output",hint:"The latest record is output activity; usage reporting may lag"};
  return {label:"Awaiting report",hint:"No new token reports in 60 seconds; this is not a progress percentage or evidence the task stopped"};
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
  button.dataset.projectTone=projectTone(card);
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
  else if(state.petMode)invokeDesktop("set_pet_view",{view:value,activate:false}).catch(e=>banner("Could not resize window: "+e));
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
  const quotaLabel=quota.state==="unknown"?"Weekly quota pending":"Weekly "+quota.label;
  $("petLauncher").title=label+" · "+quotaLabel+" · Hold to drag · Hover or click to expand · Right-click to quit";
  $("petLauncher").setAttribute("aria-label",label+", "+quotaLabel+", hover or click to open task activity");
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
  return Number(value).toLocaleString("en-US",{maximumFractionDigits:2});
}
function quotaLocalTime(timestamp,full=false) {
  if(!Number.isFinite(timestamp)||timestamp<=0)return "Pending sync";
  return new Date(timestamp*1000).toLocaleString("en-US",full?{year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit"}:{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"});
}
function quotaCountdown(timestamp,now=Date.now()/1000) {
  if(!Number.isFinite(timestamp)||timestamp<=0)return "";
  const minutes=Math.ceil((timestamp-now)/60);
  if(minutes<=0)return "Awaiting reset sync";
  if(minutes<60)return minutes+" min left";
  if(minutes<1440)return Math.ceil(minutes/60)+" hr left";
  return Math.floor(minutes/1440)+" d "+Math.floor(minutes%1440/60)+" hr left";
}
function setQuotaResetExpanded(expanded) {
  if(expanded&&$("runtimeHealth"))setHealthExpanded(false);
  $("quotaResetWindows").hidden=!expanded;
  $("quotaResetToggle").setAttribute("aria-expanded",String(expanded));
  $("quotaResetToggle").title=expanded?"Hide quota reset times":"Show quota reset times";
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
  const value=usage.balance?.unlimited?"Unlimited":formatQuotaBalance(usage.balance?.balance);
  $("creditBalanceValue").textContent=value??"—";
  $("creditBalanceValue").title=value===null?"Credit balance pending sync":usage.balance?.unlimited?"Unlimited":"Credit balance: "+usage.balance.balance;
  $("creditBalanceHint").textContent=value===null?"Pending sync":"Current Codex balance";
  const cards=usage.cards;
  const count=Number.isInteger(cards?.available_count)&&cards.available_count>=0?cards.available_count:null;
  $("resetCardCount").textContent=count===null?"—":String(count);
  const expirations=count===null?[]:(Array.isArray(cards.expirations)?cards.expirations:[]).filter(item=>Number.isInteger(item.count)&&item.count>0&&(item.expires_at===null||(Number.isFinite(item.expires_at)&&item.expires_at>0))).sort((a,b)=>(a.expires_at??Infinity)-(b.expires_at??Infinity));
  const unlisted=Number.isInteger(cards?.unlisted_count)&&cards.unlisted_count>0?cards.unlisted_count:0;
  const nearest=expirations.find(item=>item.expires_at!==null);
  const expiryHint=count===null?"Pending sync":count===0?"No resets available":nearest?"Exp. "+quotaLocalTime(nearest.expires_at):unlisted||!expirations.length?"Expiration pending sync":"No expiration";
  $("resetCardNextExpiry").textContent=expiryHint;
  $("resetCardNextExpiry").title=nearest?"Next expiry "+quotaLocalTime(nearest.expires_at,true):expiryHint;
  const list=$("resetCardExpirations");
  list.replaceChildren();
  const appendExpiry=(amount,label,title=label)=>{
    const item=document.createElement("li"),number=document.createElement("span"),date=document.createElement("span");
    number.textContent=amount===null?"—":"×"+amount;date.textContent=label;date.title=title;
    item.append(number,date);list.append(item);
  };
  for(const item of expirations)appendExpiry(item.count,item.expires_at===null?"No expiration":quotaLocalTime(item.expires_at),item.expires_at===null?"No expiration":quotaLocalTime(item.expires_at,true));
  if(unlisted)appendExpiry(unlisted,"Expiration pending sync");
  if(!list.children.length)appendExpiry(count,count===0?"No resets available":"Expiration pending sync");
  const windows=$("quotaResetWindows");windows.replaceChildren();
  const ordered=[10080,300].map(minutes=>usage.windows.find(item=>item.window_minutes===minutes)).filter(Boolean);
  if(!ordered.length)ordered.push({window_minutes:10080,resets_at:null});
  for(const item of ordered){
    const row=document.createElement("p"),label=document.createElement("span"),text=document.createElement("span");
    label.textContent=item.window_minutes===10080?"Weekly reset":"5-hour reset";
    const timestamp=item.resets_at;
    if(Number.isFinite(timestamp)&&timestamp>0){
      const time=document.createElement("time");time.dateTime=new Date(timestamp*1000).toISOString();
      time.textContent=quotaLocalTime(timestamp);time.title=quotaLocalTime(timestamp,true);
      text.append(time,document.createTextNode(" · "+quotaCountdown(timestamp,now)));
    }else text.textContent="Pending sync";
    row.append(label,text);windows.append(row);
  }
  const status=$("quotaDetailsStatus");
  status.hidden=!usage.fresh||!usage.pending;
  status.textContent=usage.pending?"Last synced "+quotaLocalTime(state.usageDetails?.observed_at)+" · Retrying sync":"";
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
  const description=rate>0?' · Total token rate over the last 60 seconds: '+Math.round(rate).toLocaleString()+' /min · Slow coin rotation indicates activity, not per-coin billing':' · No recent token usage observed';
  element.title+=description;
}
function healthAge(seconds) {
  if(!Number.isFinite(seconds)||seconds<0)return "Unknown";
  if(seconds<60)return Math.floor(seconds)+" s ago";
  if(seconds<3600)return Math.floor(seconds/60)+" min ago";
  return Math.floor(seconds/3600)+" hr ago";
}
function healthTime(timestamp) {
  if(!Number.isFinite(timestamp)||timestamp<=0)return "Not checked";
  return new Date(timestamp*1000).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
}
function healthPhase(phase) {
  return {thinking:"Reasoning",tool:"Tool activity",response:"Output",waiting:"Waiting",starting:"Starting",unknown:"Type unknown"}[phase]||"Type unknown";
}
function healthNetworkText(check) {
  if(!check)return "Not checked";
  const labels={reachable:"Reachable",slow:"Slow",http_error:"HTTP response",timeout:"Timed out",dns_error:"DNS failed",tls_error:"TLS failed",unreachable:"Failed"};
  const label=labels[check.state]||"Unknown";
  const latency=Number.isFinite(check.latency_ms)?Math.round(check.latency_ms)+" ms":"";
  return label+(latency?" · "+latency:"")+(check.state==="http_error"&&Number.isInteger(check.http_status)?" · "+check.http_status:"");
}
function renderOperationalHealth(data,now) {
  const fresh=!state.diagnosticsFailed&&data?.data_state==="current"&&Number.isFinite(data?.observed_at)&&now-data.observed_at<=30&&now-data.observed_at>=-30;
  const value=fresh?data?.operational:null;
  const states={active:["Active","ok"],tool_running:["Tool call","ok"],quiet:["Unconfirmed","notice"],waiting:["Awaiting response","notice"],error:["Issue","warning"],unknown:["Unconfirmed","unknown"],idle:["Idle","unknown"]};
  const selected=states[value?.state]||states.unknown;
  let [label,level]=selected;
  if(value?.state==="tool_running"&&value.level!=="ok"){label="Tool wait";level="notice";}
  const reasons={active:"Recent task activity was observed.",tool_running:"A tool call was observed; awaiting its completion record.",tool_wait:"Some tools have not returned for a while. Check the original conversation; continued execution is unconfirmed.",quiet:"Some tasks have had no new activity for a while. Check their original conversations.",awaiting_response:"Tasks have started; their first model or tool response has not been observed.",recent_connection_error:"A recent turn recorded a connection failure. Check the original conversation; no reconnect was performed here.",recent_task_error:"A recent turn recorded an execution error. Check the original conversation for its cause.",activity_unconfirmed:"Some task records are unavailable; waiting for confirmation.",sync_unavailable:"Runtime records are pending sync; previous task cards are retained.",idle:"No tasks are running; check the connection when needed."};
  const reason=reasons[value?.code]||reasons.sync_unavailable;
  const affected=Number.isInteger(value?.affected_tasks)&&value.affected_tasks>0?value.affected_tasks:0;
  $("healthSummary").textContent=label;
  $("healthSummary").title=reason;
  $("healthOperationalReason").textContent=(affected?affected+" tasks · ":"")+reason;
  $("runtimeHealth").dataset.level=level;
  const badge=$("runtimeHealthToggle");badge.dataset.level=level;
  badge.dataset.checking=String(Boolean(state.diagnosticsResetting||data?.network?.checking));
  const alert=$("healthRuntimeAlert");alert.dataset.level=level;
  alert.hidden=level==="ok"||value?.state==="idle";
  const scoreLabel="Public connection · "+$("healthScoreValue").textContent;
  badge.setAttribute("aria-label",scoreLabel+" · Codex health · "+label);
  badge.title=scoreLabel+"\n"+"Codex health · "+label+"\n"+reason;
}
function renderHealthScore(data,now=Date.now()/1000) {
  const score=data?.score||{},network=data?.network||{};
  const current=!state.diagnosticsFailed&&!state.diagnosticsResetting&&Number.isFinite(data?.observed_at)&&now-data.observed_at<=30&&now-data.observed_at>=-30;
  const stale=!state.diagnosticsResetting&&(score.grade==="stale"||(network.stale===true&&Number.isFinite(network.checked_at)));
  const valid=current&&!stale&&["good","fair","poor"].includes(score.grade)&&Number.isFinite(score.value)&&score.value>=0&&score.value<=100;
  const grade=stale?"stale":valid?score.grade:"collecting";
  const confidence=valid?{provisional:"Preliminary",short_check:"Short check"}[score.confidence]||"Preliminary":stale?"Retest needed":current||state.diagnosticsResetting?"Sampling":"Pending sync";
  $("healthScoreValue").textContent=valid?Math.round(score.value)+" /100":"—";
  $("healthBadgeValue").textContent=valid?String(Math.round(score.value)):"—";
  $("runtimeHealthToggle").dataset.scoreLevel=valid?{good:"ok",fair:"notice",poor:"warning"}[score.grade]:"unknown";
  $("healthScoreValue").title="Score from public-path samples; verify actual Codex responses through tasks.";
  $("healthConnectionConfidence").textContent=confidence;
  const reasons={good:"The current path looks responsive. Continue observing actual task progress.",fair:"The current path has delay or jitter. Compare a short check after switching nodes.",poor:"The current path has frequent failures or jitter. Switch nodes and retest.",collecting:"Building a baseline for this node. Several rounds are needed before scoring.",stale:"These samples have expired. Retest the current node."};
  const noteLabels={partial_coverage:"Service coverage is incomplete.",insufficient_rounds:"More independent rounds are needed.",runtime_unconfirmed:"Actual Codex responses remain unverified.",runtime_quiet:"Some running tasks have no recent activity.",missing_latency:"Latency data is insufficient.",failed_latency_floor:"Failed requests are included in latency scoring.",http_restricted:"The endpoint restricts access. Use this as a path reference.",unexpected_response:"The endpoint returned an unexpected response.",service_failures:"Some service connection checks failed.",codex_recent_failures:"Recent Codex path checks failed.",official_codex_degraded:"Official status reports degraded Codex performance.",official_codex_outage:"Official status reports a Codex outage.",official_other_notice:"Official status reports issues in other services.",official_status_unknown:"Official status is unavailable.",short_check_only:"A short check reflects this moment. Keep observing."};
  const notes=Array.isArray(score.notes)?score.notes:[];
  const priority=["official_codex_outage","official_codex_degraded","codex_recent_failures","service_failures","http_restricted","unexpected_response","partial_coverage","insufficient_rounds","missing_latency","runtime_quiet","runtime_unconfirmed","official_status_unknown"];
  const reasonCode=priority.find(code=>notes.includes(code));
  $("healthScoreReason").textContent=(current||state.diagnosticsResetting||stale?reasons[grade]:"Reading the current path score…")+(current&&reasonCode?" "+noteLabels[reasonCode]:"");
  const count=Number.isInteger(score.sample_count)&&score.sample_count>=0?score.sample_count:0;
  const rounds=Number.isInteger(network.rounds_completed)?network.rounds_completed:Number.isInteger(score.round_count)?score.round_count:0;
  const planned=Number.isInteger(network.rounds_planned)&&network.rounds_planned>0?network.rounds_planned:6;
  const progress=state.diagnosticsResetting?"Starting a fresh sample session":"Public path · "+rounds+"/"+planned+" rounds · "+count+" samples";
  $("healthScoreProgress").textContent=progress+(network.node_changed_at?" · Samples reset":"");
  $("healthScoreProgress").title=notes.map(code=>noteLabels[code]).filter(Boolean).join("\n");
  $("healthRouteNote").hidden=!(network.exit_observed===false&&Number.isFinite(network.checked_at));
  $("healthRouteNote").textContent="Exit unconfirmed. Retest after switching nodes.";
  if(score.components&&valid)$("healthScoreValue").title+="\n"+"Reliability "+formatRate(score.components.reliability)+"/60 · "+"Latency "+formatRate(score.components.latency)+"/25 · "+"Stability "+formatRate(score.components.stability)+"/15";
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
  const explanations={sync_unavailable:"Activity data is unavailable. Wait for sync before assessing progress.",idle:"No tasks are running. You can check the connection on demand.",network_unavailable:"Public connection checks failed. Check the network or proxy and retry.",openai_path:"Public internet is reachable; the OpenAI path is slow or failed. Try another route and recheck.",connection_slow:"This public connection check was slow. Recheck and compare task activity.",reference_path:"The public reference check failed; the OpenAI path is reachable. Check again to compare.",endpoint_response:"The connection succeeded, but the public endpoint returned an HTTP restriction or error. Check its status code; this result describes only the probe endpoint.",service_notice:"The official status reports a disruption that may affect some tasks.",quiet:"Some tasks have been quiet for a while. Compare connection checks and official status.",active:"Recent activity detected. Compare output reports and task events to assess progress.",waiting:"Running tasks have no new reports yet. They may be reasoning, using tools or awaiting a response."};
  Object.assign(explanations,{tool_running:"Tool calls are pending. Their execution may produce no new tokens.",tool_wait:"Some tools have not returned for a while; check the original conversation.",awaiting_response:"Tasks started; waiting for the first response.",activity_unconfirmed:"Some task records are pending sync.",recent_connection_error:"A recent turn recorded a connection failure.",recent_task_error:"A recent turn recorded an execution error."});
  const output=fresh&&Number.isFinite(activity.output_tokens_per_min)?activity.output_tokens_per_min:null;
  $("healthAssessment").textContent=fresh?(explanations[assessment.code]||explanations.waiting):explanations.sync_unavailable;
  $("healthTotalRate").textContent=fresh?formatRate(activity.total_tokens_per_min):"—";
  $("healthOutputRate").textContent=output===null?"—":formatRate(output);
  $("healthOutputRate").title=output===0?"No output report in the last 60 seconds. Reasoning or tool activity may still be ongoing.":"Output tokens reported in the last 60 seconds. Reports may arrive late.";
  const activityAge=Number.isFinite(activity.last_activity_at)?Math.max(0,now-activity.last_activity_at):null;
  $("healthLastActivity").textContent=fresh?"Last activity "+healthAge(activityAge)+" · "+(Number.isInteger(data.running_tasks)?data.running_tasks:0)+" running":"Activity pending sync";
  const network=data?.network||{},checks=!state.diagnosticsResetting&&Array.isArray(network.checks)?network.checks:[];
  for(const [id,target]of [["general","healthGeneralNetwork"],["codex","healthCodexNetwork"],["api","healthAPINetwork"],["auth","healthAuthNetwork"]]){
    const check=checks.find(item=>item.id===id),element=$(target);
    element.textContent=healthNetworkText(check)+(network.stale&&check?" · Old data":"");
    element.dataset.state=check?.state||"unknown";
    element.title=check?"Recent median "+(Number.isFinite(check.median_ms)?Math.round(check.median_ms)+" ms":"Unknown")+" · Baseline "+(Number.isFinite(check.baseline_ms)?Math.round(check.baseline_ms)+" ms":"Unknown")+" · Consecutive failures "+(Number.isInteger(check.failure_streak)?check.failure_streak:0):"Not checked";
  }
  const official=data?.official||{},incidents=Array.isArray(official.incidents)?official.incidents:[],components=Array.isArray(official.components)?official.components:[];
  const officialState={operational:"Official: no known issue",degraded:"Official: disruption reported",unknown:"Official status unavailable"}[official.state]||"Official status not checked";
  $("healthOfficial").textContent=officialState+(official.stale?" · Old data":"")+(incidents.length?" · "+String(incidents[0].name||""):"");
  $("healthOfficial").title=components.map(item=>String(item.name)+": "+String(item.status)).join("\n")+(official.checked_at?"\n"+"Checked "+healthTime(official.checked_at):"");
  const componentStates={operational:"Operational",degraded_performance:"Degraded",partial_outage:"Partial outage",major_outage:"Outage",under_maintenance:"Maintenance"};
  $("healthOfficialComponents").hidden=!components.length;
  $("healthOfficialComponents").textContent=components.map(item=>String(item.name)+" · "+(componentStates[item.status]||"Status unknown")).join(" / ");
  $("healthCheckTime").textContent=network.blocked?"Check timed out. Waiting for the system connection to finish before retrying.":state.diagnosticsResetting||network.checking?"Checking connection…":network.checked_at?"Checked "+healthTime(network.checked_at)+(network.stale?" · Old data":""):"Connection not checked";
  $("healthCheckTime").title=network.route==="system_proxy"?"Checks use the system proxy; Codex may use a different route.":"Checks use the current system route, which may pass through a VPN tunnel.";
  $("healthCheckButton").disabled=Boolean(state.diagnosticsBusy||network.checking||network.blocked);
  $("healthCheckButton").setAttribute("aria-busy",String(Boolean(state.diagnosticsBusy||network.checking)));
  const tasks=Array.isArray(data?.tasks)?data.tasks:[],issues=fresh&&Array.isArray(data?.recent_issues)?data.recent_issues:[],list=$("healthTaskList"),scroll=list.scrollTop;
  $("healthTaskSummary").textContent="Task activity · "+tasks.length+(fresh&&activity.quiet_tasks>0?" · "+activity.quiet_tasks+" quiet":"");
  list.replaceChildren();
  for(const task of tasks){
    const row=node("li","health-task"),title=node("div","health-task-title");
    const name=node("strong","",String(task.name||"Task"));name.title=String(task.name||"Task");
    title.append(name,node("span","",fresh?healthAge(task.activity_age_seconds):"Pending sync"));
    row.dataset.signal=fresh?String(task.signal||"unknown"):"unknown";
    const meta=node("p","",healthPhase(task.phase)+" · "+"Out rpt. "+(fresh?formatRate(task.output_tokens_per_min):"—")+"/min");
    meta.title=[task.model,task.effort].filter(value=>typeof value==="string").join(" · ")+" · "+"Last report "+healthAge(task.report_age_seconds);
    row.append(title,meta);list.append(row);
  }
  for(const issue of issues){
    const row=node("li","health-task"),title=node("div","health-task-title");
    title.append(node("strong","",String(issue.name||"Task")),node("span","",healthAge(issue.age_seconds)));
    row.dataset.signal="quiet";
    row.append(title,node("p","",issue.code==="http_connection_failed"?"Recent turn connection failure":"Recent turn execution error"));list.append(row);
  }
  if(!tasks.length&&!issues.length)list.append(node("li","health-no-tasks",fresh?"No running tasks":"Activity pending sync"));
  list.scrollTop=scroll;syncBoardSize(false,false);
}
async function refreshDiagnostics(check=false) {
  if(state.diagnosticsBusy||state.diagnosticsStopped)return;
  state.diagnosticsBusy=true;state.diagnosticsResetting=check;renderDiagnostics();
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch(check?"/api/diagnostics/check":"/api/diagnostics",{cache:"no-store",signal:controller.signal,...(check?{method:"POST",headers:{"Content-Type":"application/json","X-Work-Twin":"1"},body:JSON.stringify({reset:true})}:{})});
    if(!response.ok)throw Error("Activity checks are unavailable. Please retry shortly.");
    const data=await response.json();
    if(!data||!Number.isFinite(data.observed_at)||!data.activity)throw Error("Activity checks are unavailable. Please retry shortly.");
    state.diagnostics=data;state.diagnosticsFailed=false;$("healthCheckError").hidden=true;
  }catch(error){
    state.diagnosticsFailed=true;
    if(check){$("healthCheckError").textContent="Activity checks are unavailable. Please retry shortly.";$("healthCheckError").hidden=false;}
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
  return String(card.cwd||card.project_label||"Unlinked tasks");
}
function projectLabel(card) {
  if(card.project_label)return String(card.project_label);
  const parts=String(card.cwd||"").split(/[\\/]/).filter(Boolean);
  return parts.at(-1)||"Unlinked tasks";
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
  $("syncLabel").textContent=wantedCards.length+" tasks · "+(state.observedAt?relativeTime(state.observedAt):"Syncing");
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
    if(force){
      state.threads=[];state.weeklyUsage=null;state.usageDetails=null;state.observedAt=null;state.connected=false;
      $("connectionText").textContent="Reconnecting to Codex…";banner("");renderList(true);updateCounts();
    }
    const data=await api(force?"/api/refresh":"/api/threads",force?{}:undefined);
    state.readPlay?.setWeeklyHarvest(data.weekly_harvest);
    state.threads=data.threads||[];
    state.connected=data.health?.app_server==="online" && !data.error && !data.stale && !data.loading;
    $("connectionText").textContent=data.loading?"Preparing tasks":state.connected?(data.coverage?.external_runtime==="local_events"?"Codex connected · Syncing live status":"Codex connected · Some statuses pending"):"Sync interrupted · Keeping last known state";
    state.observedAt=data.observed_at;
    state.weeklyUsage=data.health?.usage?.weekly||null;
    state.usageDetails=data.health?.usage?.details||null;
    if(data.error)banner(data.error);
    if(!data.loading) renderList(force);
    updateCounts();
  }catch(e){
    state.connected=false;$("connectionText").textContent="Disconnected";banner(e.message);renderList(true);updateCounts();
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
  const label=state.pinned?"Unpin · Restore collapse on pointer leave":"Pin · Stay open after the pointer leaves";
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
