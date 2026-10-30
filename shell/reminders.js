/* Independent, content-free reminder navigation. No read receipts or model calls. */
(function(scope){
  const PAGE_SIZE=3;
  const COPY={
    zh:{heading:"需要你回复",reply:n=>`待回复 · ${n} 问`,stale:"待同步",opening:"正在打开…",opened:"已打开 Codex",changed:"提醒已更新，请重新查看",failed:"打开失败 · 点击重试",unavailable:"等待桌面连接",empty:"当前没有待回复任务",previous:"上一页提醒",next:"下一页提醒",pages:(p,n,total)=>`${p} / ${n} · ${total} 项`,action:"在 Codex 中查看并回复",go:"查看",retry:"重试"},
    en:{heading:"Needs reply",reply:n=>`${n} ${n===1?'question':'questions'} to reply`,stale:"Pending sync",opening:"Opening…",opened:"Opened in Codex",changed:"Reminder changed · Check again",failed:"Couldn't open · Retry",unavailable:"Waiting for desktop",empty:"No pending replies",previous:"Previous reminders",next:"Next reminders",pages:(p,n,total)=>`${p} / ${n} · ${total} tasks`,action:"View and reply in Codex",go:"View",retry:"Retry"}
  };
  function targetKey(item){return JSON.stringify([item.thread_id,item.turn_id,item.question_id]);}
  function reminderContentWidth(widths){
    const valid=(Array.isArray(widths)?widths:[]).filter(value=>Number.isFinite(value)&&value>=0);
    // Surface 12 + border 2 + padding 20 + gap 8 + text action 32.
    return Math.max(152,Math.min(196,Math.ceil((Math.max(0,...valid)+74)/2)*2));
  }
  function cleanItems(items){
    const seen=new Set();
    return (Array.isArray(items)?items:[]).slice(0,32).flatMap(item=>{
      if(!item||typeof item.thread_id!=="string"||!/^[a-zA-Z0-9_-]{1,100}$/.test(item.thread_id)||seen.has(item.thread_id))return [];
      seen.add(item.thread_id);
      const turn=typeof item.turn_id==="string"?item.turn_id:"",question=typeof item.question_id==="string"?item.question_id:"";
      return [{thread_id:item.thread_id,turn_id:turn,question_id:question,title:Array.from(String(item.title||"Monkex").replace(/\p{Cc}/gu," ")).slice(0,160).join(""),count:Math.max(1,Math.min(4096,Math.floor(Number(item.count)||1))),available:item.available===true&&turn.length>0&&question.length>0}];
    });
  }
  class ReminderController{
    constructor({getSnapshot,openInput,dismissInput=async()=>{},onChange=()=>{},onAnnouncement=()=>{}}){
      Object.assign(this,{getSnapshot,openInput,dismissInput,onChange,onAnnouncement});
      this.items=[];this.page=0;this.stale=true;this.revision=-1;this.busy=new Map();this.notices=new Map();this.blocked=new Map();this.dismissed=new Map();this.pendingDismissals=new Map();this.dismissing=new Map();this.refreshing=null;this.disposed=false;
    }
    applySnapshot(snapshot){
      if(this.disposed)return;
      const revision=Number(snapshot?.revision);
      if(Number.isFinite(revision)&&revision<this.revision)return;
      if(Number.isFinite(revision))this.revision=revision;
      if(typeof snapshot?.lang==='string')this.lang=snapshot.lang.startsWith('en')?'en':'zh';
      this.stale=snapshot?.stale!==false;
      let incoming=cleanItems(snapshot?.items);
      if(this.stale&&!incoming.length)incoming=this.items;
      for(const item of incoming)if(item.count>(this.dismissed.get(targetKey(item))??Infinity))this.dismissed.delete(targetKey(item));
      for(const [key,until]of this.blocked)if(this.revision>until)this.blocked.delete(key);
      const byId=new Map(incoming.filter(item=>!this.dismissed.has(targetKey(item))).map(item=>[item.thread_id,{...item,available:item.available&&!this.stale&&!this.blocked.has(targetKey(item))}]));
      const ordered=[];
      for(const previous of this.items){const item=byId.get(previous.thread_id);if(item){ordered.push(item);byId.delete(previous.thread_id);}}
      this.items=ordered.concat([...byId.values()]);
      const keys=new Set(this.items.map(targetKey));
      for(const key of this.notices.keys())if(!keys.has(key))this.notices.delete(key);
      this.page=Math.min(this.page,Math.max(0,Math.ceil(this.items.length/PAGE_SIZE)-1));
      this.onChange();
    }
    refresh(){
      if(this.refreshing)return this.refreshing;
      const work=Promise.resolve().then(()=>this.getSnapshot()).then(snapshot=>this.applySnapshot(snapshot)).catch(()=>this.applySnapshot({items:this.items,revision:this.revision,stale:true})).then(()=>this.disposed?undefined:this.flushDismissals());
      this.refreshing=work.finally(()=>{this.refreshing=null;});
      return this.refreshing;
    }
    visibleItems(){return this.items.slice(this.page*PAGE_SIZE,(this.page+1)*PAGE_SIZE);}
    changePage(delta){this.page=Math.max(0,Math.min(Math.ceil(this.items.length/PAGE_SIZE)-1,this.page+delta));this.onChange();}
    dismiss(item){
      const key=targetKey(item);
      this.dismissed.set(key,item.count);this.pendingDismissals.set(key,{...item});
      while(this.dismissed.size>256){const oldest=this.dismissed.keys().next().value;this.dismissed.delete(oldest);this.pendingDismissals.delete(oldest);}
      this.items=this.items.filter(candidate=>targetKey(candidate)!==key||candidate.count>item.count);this.notices.delete(key);
      this.page=Math.min(this.page,Math.max(0,Math.ceil(this.items.length/PAGE_SIZE)-1));
      if(!this.disposed)this.onChange();
      return this.flushDismissals();
    }
    flushDismissals(){
      return Promise.all([...this.pendingDismissals].map(([key,item])=>{
        if(this.dismissing.has(key))return this.dismissing.get(key);
        // The conversation has opened already. Retry local hiding without reporting a navigation failure.
        const work=Promise.resolve().then(()=>this.dismissInput(item)).then(()=>this.pendingDismissals.delete(key)).catch(()=>{}).finally(()=>this.dismissing.delete(key));
        this.dismissing.set(key,work);return work;
      }));
    }
    open(item){
      const key=targetKey(item);
      if(this.busy.has(key))return this.busy.get(key);
      const work=Promise.resolve().then(async()=>{
        await this.refresh();
        if(this.disposed)return false;
        const current=this.items.find(candidate=>targetKey(candidate)===key);
        if(!current?.available){this.notices.set(key,{code:"changed"});this.onAnnouncement("changed");return false;}
        const result=await this.openInput(current);
        if(result?.stale||result?.reason==='sync_unavailable'){
          this.blocked.set(key,this.revision);current.available=false;this.notices.set(key,{code:result.stale?"changed":"stale"});this.onAnnouncement(result.stale?"changed":"stale");await this.refresh();return false;
        }
        if(result?.ok!==true)throw Error("open_failed");
        await this.dismiss(current);
        this.onAnnouncement("opened");
        return true;
      }).catch(()=>{this.notices.set(key,{code:"failed"});this.onAnnouncement("failed");return false;}).finally(()=>{this.busy.delete(key);if(!this.disposed)this.onChange();});
      this.busy.set(key,work);this.notices.delete(key);this.onChange();return work;
    }
    dispose(){this.disposed=true;}
  }
  function mount(){
    const params=new URLSearchParams(location.search);let lang=params.get("lang")?.startsWith("en")?'en':'zh',copy=COPY[lang];
    document.documentElement.lang=lang==='en'?'en':'zh-CN';
    const $=id=>document.getElementById(id),invoke=scope.__TAURI__?.core?.invoke;
    const fixture=params.get("fixture")==="1"&&scope.__MONKEX_REMINDER_FIXTURE__;
    const native=typeof invoke==="function",rows=new Map(),textMeasure=document.createElement('canvas').getContext('2d');let timer=null,stopped=false,interacting=false,releaseTimer=null,interactionDeadline=null,nativePageKey=null;
    function naturalTextWidth(node){
      if(!textMeasure)return 196;
      const style=getComputedStyle(node),text=node.textContent||'';
      textMeasure.font=style.fontStyle+' '+style.fontWeight+' '+style.fontSize+' '+style.fontFamily;
      return textMeasure.measureText(text).width+Math.max(0,Array.from(text).length-1)*(parseFloat(style.letterSpacing)||0);
    }
    function nativeInteraction(active){if(native)Promise.resolve(invoke('set_input_reminder_interaction',{active})).catch(()=>{});}
    function releaseInteraction(){clearTimeout(releaseTimer);releaseTimer=setTimeout(()=>{interacting=false;clearTimeout(interactionDeadline);nativeInteraction(false);render();},0);}
    function beginInteraction(){clearTimeout(releaseTimer);clearTimeout(interactionDeadline);interacting=true;nativeInteraction(true);interactionDeadline=setTimeout(releaseInteraction,5000);}
    $("reminderSurface").setAttribute("aria-label",copy.heading);$("reminderPages").setAttribute("aria-label",copy.heading);
    $("reminderPrevious").setAttribute("aria-label",copy.previous);$("reminderNext").setAttribute("aria-label",copy.next);
    const controller=new ReminderController({
      getSnapshot:()=>native?invoke("get_input_reminders"):fixture?fixture.snapshot:{items:[],revision:0,stale:true},
      dismissInput:item=>native?invoke('dismiss_input_reminder',{threadId:item.thread_id,turnId:item.turn_id,questionId:item.question_id,count:item.count}):undefined,
      openInput:async item=>{
        if(!native&&!fixture)return {ok:false};
        const requestController=new AbortController(),deadline=setTimeout(()=>requestController.abort(),12000);
        try{
          const response=await fetch('/api/threads/'+encodeURIComponent(item.thread_id)+'/open-input',{method:'POST',headers:{'Content-Type':'application/json','X-Work-Twin':'1'},body:JSON.stringify({turn_id:item.turn_id,question_id:item.question_id}),signal:requestController.signal});
          const result=await response.json();if(!response.ok&&!result?.stale)throw Error("open_failed");return result;
        }finally{clearTimeout(deadline);}
      },
      onAnnouncement:code=>{$("reminderAnnouncement").textContent=copy[code];},
      onChange:render
    });
    function createRow(item){
      const row=document.createElement('div'),button=document.createElement('button'),copyNode=document.createElement('span'),title=document.createElement('span'),detail=document.createElement('span'),text=document.createElement('span'),action=document.createElement('span');
      row.className='reminder-row';button.className='reminder-bubble';button.type='button';copyNode.className='reminder-copy';title.className='reminder-title';detail.className='reminder-detail';text.className='reminder-detail-text';action.className='reminder-action';action.setAttribute('aria-hidden','true');
      detail.append(text);copyNode.append(title,detail);button.append(copyNode,action);row.append(button);
      let pressed=null,moved=false;
      button.addEventListener('pointerdown',event=>{if(event.button===0){beginInteraction();pressed={target:{...row.item},x:event.clientX,y:event.clientY};moved=false;button.setPointerCapture?.(event.pointerId);event.stopPropagation();}});
      button.addEventListener('pointermove',event=>{if(pressed&&Math.hypot(event.clientX-pressed.x,event.clientY-pressed.y)>5)moved=true;});
      button.addEventListener('pointerup',()=>releaseInteraction());
      button.addEventListener('pointercancel',()=>{pressed=null;releaseInteraction();});
      button.addEventListener('dragstart',event=>event.preventDefault());
      button.addEventListener('click',event=>{event.stopPropagation();const target=event.detail===0?row.item:moved?null:pressed?.target||row.item;pressed=null;if(target)controller.open(target);});
      return Object.assign(row,{button,titleNode:title,text,action,item});
    }
    function render(){
      if(interacting)return;
      if(controller.lang&&controller.lang!==lang){
        lang=controller.lang;copy=COPY[lang];document.documentElement.lang=lang==='en'?'en':'zh-CN';
        $("reminderSurface").setAttribute("aria-label",copy.heading);$("reminderPages").setAttribute("aria-label",copy.heading);
        $("reminderPrevious").setAttribute("aria-label",copy.previous);$("reminderNext").setAttribute("aria-label",copy.next);
      }
      const visible=controller.visibleItems(),ids=new Set(visible.map(item=>item.thread_id));
      for(const [id,row]of rows)if(!ids.has(id)){row.remove();rows.delete(id);}
      for(const [index,item]of visible.entries()){
        let row=rows.get(item.thread_id);if(!row){row=createRow(item);rows.set(item.thread_id,row);}
        row.item=item;row.dataset.threadId=item.thread_id;
        const key=targetKey(item),busy=controller.busy.has(key),notice=controller.notices.get(key),tone=!item.available?'stale':busy?'busy':notice?.code==='failed'?'error':'ready';
        row.titleNode.textContent=item.title;row.button.dataset.state=tone;row.button.disabled=!item.available||busy;row.button.setAttribute('aria-busy',String(busy));
        row.text.textContent=!item.available?copy.stale:busy?copy.opening:notice?copy[notice.code]:copy.reply(item.count);
        row.action.textContent=tone==='error'?copy.retry:copy.go;row.action.hidden=!item.available||busy;row.button.title=item.title+' · '+(item.available?copy.action:copy.stale);row.button.setAttribute('aria-label',row.button.title);
        const list=$("reminderList");if(list.children[index]!==row)list.insertBefore(row,list.children[index]||null);
      }
      const total=controller.items.length,pages=Math.ceil(total/PAGE_SIZE);
      $("reminderPages").hidden=total<=PAGE_SIZE;$("reminderPrevious").disabled=controller.page===0;$("reminderNext").disabled=controller.page>=pages-1;$("reminderPageLabel").textContent=copy.pages(controller.page+1,pages,total);
      $("reminderEmpty").hidden=total>0;$("reminderEmpty").textContent=!native&&!fixture?copy.unavailable:controller.stale?copy.stale:copy.empty;
      const width=reminderContentWidth([...rows.values()].flatMap(row=>[naturalTextWidth(row.titleNode),naturalTextWidth(row.text)]));
      const pageKey=controller.page+":"+total+":"+width;
      if(native&&controller.revision>=0&&nativePageKey!==pageKey){
        nativePageKey=pageKey;
        Promise.resolve(invoke('set_input_reminder_page',{page:controller.page,width})).catch(()=>{if(nativePageKey===pageKey)nativePageKey=null;});
      }
    }
    $("reminderPrevious").onclick=()=>controller.changePage(-1);$("reminderNext").onclick=()=>controller.changePage(1);
    const poll=async()=>{if(stopped)return;await controller.refresh();if(!stopped)timer=setTimeout(poll,1000);};
    window.addEventListener('blur',releaseInteraction);
    window.addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);clearTimeout(releaseTimer);clearTimeout(interactionDeadline);nativeInteraction(false);controller.dispose();});
    // Fixtures are opt-in and never persisted. The production child reads only native snapshots.
    if(fixture)scope.__monkexReminderController=controller;
    render();if(native||fixture)poll();
  }
  const exports={ReminderController,cleanItems,targetKey,reminderContentWidth,PAGE_SIZE,COPY};
  if(typeof module!=='undefined'&&module.exports)module.exports=exports;
  scope.MonkexInputReminders=exports;
  if(typeof document!=='undefined')mount();
})(typeof window!=='undefined'?window:globalThis);
