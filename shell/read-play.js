/* Local, receipt-bound reading feedback. This module never calls a task API. */
(function(scope){
  function localWeekStart(now){
    const date=new Date(now);
    date.setDate(date.getDate()-(date.getDay()+6)%7);
    return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0')+'-'+String(date.getDate()).padStart(2,'0');
  }
  class ReadPlayLedger {
    constructor(){this.pending=new Map();this.seen=new Set();this.combo=0;this.lastAt=0;}
    arm(card,now){
      if(!card?.id||!card.unread||!card.pending_result_version||card.status==='running')return false;
      this.pending.set(card.id,{version:card.pending_result_version,at:now});
      while(this.pending.size>32)this.pending.delete(this.pending.keys().next().value);
      return true;
    }
    cancel(id){this.pending.delete(id);}
    confirm(receipt,card,now){
      const pending=this.pending.get(receipt?.threadId);
      if(!pending||pending.version!==receipt.version)return null;
      this.pending.delete(receipt.threadId);
      const key=receipt.threadId+':'+receipt.version;
      if(now-pending.at>60000||now<pending.at||!card||card.id!==receipt.threadId||card.status==='running'||
        (card.pending_result_version&&card.pending_result_version!==receipt.version)||this.seen.has(key))return null;
      this.seen.add(key);while(this.seen.size>256)this.seen.delete(this.seen.values().next().value);
      this.combo=this.lastAt&&now-this.lastAt<=45000?Math.min(99,this.combo+1):1;
      this.lastAt=now;return {combo:this.combo};
    }
    reset(){this.pending.clear();this.combo=0;this.lastAt=0;}
  }

  class ReadPlay {
    constructor({getContext,celebrate=()=>{},document:doc=scope.document,storage,clock=()=>Date.now()}={}){
      if(storage===undefined)try{storage=scope.localStorage;}catch{}
      this.getContext=getContext;this.celebrate=celebrate;this.doc=doc;this.storage=storage;this.clock=clock;
      this.ledger=new ReadPlayLedger();this.timers=new Set();this.animations=new Set();this.enabled=true;this.epoch=0;
      this.collected=0;this.landed=0;this.flights=new Set();this.catchRevision=0;this.toastTimer=null;
      this.weeklyHarvest=null;
      try{this.enabled=storage?.getItem('twin-play-feedback')!=='false';}catch{}
      this.monkey=doc.getElementById('greetMonkey');
      this.monkeyTitle=this.monkey?.title||'香蕉老板，准备收获';
      this.pocket=doc.createElement('span');this.pocket.className='harvest-pocket';this.pocket.hidden=true;
      this.pocket.setAttribute('aria-hidden','true');this.monkey?.append(this.pocket);
      this.onVisibility=()=>{if(doc.hidden)this.suspend();else this.syncPocket();};
      doc.addEventListener?.('visibilitychange',this.onVisibility);
      this.motionQuery=scope.matchMedia?.('(prefers-reduced-motion: reduce)');
      this.onMotion=()=>{if(this.motionQuery?.matches)this.clear();};
      this.motionQuery?.addEventListener?.('change',this.onMotion);
      this.toggle=doc.getElementById('playFeedbackToggle');
      if(this.toggle)this.toggle.onclick=()=>this.setEnabled(!this.enabled);
      this.syncToggle();
    }
    syncToggle(){
      if(this.toggle){
        this.toggle.setAttribute('aria-pressed',String(this.enabled));
        this.toggle.title=this.enabled?'关闭收香蕉动效':'开启收香蕉动效';
        this.toggle.setAttribute('aria-label',this.toggle.title);
      }
      this.doc.getElementById('appShell')?.setAttribute('data-play',String(this.enabled));
      this.syncPocket();
    }
    setWeeklyHarvest(value){
      const week=localWeekStart(this.clock());
      if(!value||value.week_start!==week||!Number.isSafeInteger(value.count)||value.count<0)return;
      if(this.weeklyHarvest?.week_start===week&&value.count<this.weeklyHarvest.count)return;
      this.weeklyHarvest={week_start:week,count:value.count};this.syncPocket();
    }
    syncPocket(){
      const week=localWeekStart(this.clock());
      const count=this.weeklyHarvest?(this.weeklyHarvest.week_start===week?this.weeklyHarvest.count:0):null;
      this.pocket.hidden=false;
      this.pocket.textContent=count===null?'—':String(count);
      this.pocket.dataset.digits=String(this.pocket.textContent.length);
      if(this.monkey)this.monkey.title=this.monkeyTitle+' · 本周已收 '+(count===null?'待同步':count+' 根')+' · 每周一 00:00 重置（本机时间）';
    }
    setEnabled(enabled){
      this.enabled=enabled;this.clear();this.ledger.reset();this.syncToggle();
      try{this.storage?.setItem('twin-play-feedback',String(enabled));}catch{}
    }
    arm(card){
      const context=this.getContext();
      if(this.enabled&&context.connected&&!this.doc.hidden)this.ledger.arm(card,this.clock());
    }
    cancel(id){this.ledger.cancel(id);}
    later(fn,delay){const id=scope.setTimeout(()=>{this.timers.delete(id);fn();},delay);this.timers.add(id);return id;}
    cancelTimer(id){if(id!==null){scope.clearTimeout(id);this.timers.delete(id);}}
    canPlay(){const c=this.getContext();return this.enabled&&c.connected&&!this.doc.hidden&&c.mode!=='collapsed';}
    showToast(combo){
      const toast=this.doc.getElementById('readPlayToast');if(!toast||!this.canPlay())return;
      const context=this.getContext(),cleared=context.filter!=='history'&&context.unreadRemaining===0&&this.landed===this.collected;
      toast.textContent=(cleared?'收齐啦':combo>1?'连收 ×'+combo:'香蕉入袋')+' · 本次 '+this.landed+' 根';
      toast.setAttribute('aria-label','已查看结果，'+toast.textContent);
      toast.dataset.clear=String(cleared);toast.dataset.tier=String(Math.min(3,combo));toast.hidden=false;
      this.cancelTimer(this.toastTimer);
      this.toastTimer=this.later(()=>{toast.hidden=true;toast.textContent='';this.toastTimer=null;},cleared?2600:2100);
    }
    effect(parent,className,x,y,text=''){
      const element=this.doc.createElement('span');element.className=className;element.textContent=text;element.setAttribute('aria-hidden','true');
      element.style.setProperty('left',x+'px');element.style.setProperty('top',y+'px');parent.append(element);return element;
    }
    clear(){
      this.epoch++;
      for(const id of this.timers)scope.clearTimeout(id);this.timers.clear();
      for(const animation of this.animations)animation.cancel();this.animations.clear();
      this.flights.clear();this.toastTimer=null;this.catchRevision++;
      this.landed=this.collected;this.syncPocket();
      if(this.monkey)delete this.monkey.dataset.harvest;
      this.doc.getElementById('readPlayLayer')?.replaceChildren();
      const toast=this.doc.getElementById('readPlayToast');if(toast){toast.hidden=true;toast.textContent='';}
    }
    suspend(){this.clear();this.ledger.reset();}
    dispose(){
      this.suspend();this.pocket.remove();
      this.doc.removeEventListener?.('visibilitychange',this.onVisibility);
      this.motionQuery?.removeEventListener?.('change',this.onMotion);
      if(this.monkey)this.monkey.title=this.monkeyTitle;
    }
    confirm(receipt,card){
      const context=this.getContext();
      if(!this.enabled||!context.connected||this.doc.hidden||context.mode==='collapsed'){this.cancel(receipt?.threadId);return;}
      const reward=this.ledger.confirm(receipt,card,this.clock());if(!reward)return;
      this.collected++;
      const epoch=this.epoch;
      const root=this.doc.getElementById('appShell'),layer=this.doc.getElementById('readPlayLayer'),toast=this.doc.getElementById('readPlayToast');
      if(!root||!layer||!toast)return;
      const rows=[...this.doc.querySelectorAll('#taskList [data-thread-id]')];
      const row=rows.find(r=>r.dataset.threadId===receipt.threadId);
      const rootRect=root.getBoundingClientRect(),rowRect=row?.getBoundingClientRect();
      const visibleRow=rowRect&&rowRect.height>0&&rowRect.top>=rootRect.top&&rowRect.bottom<=rootRect.bottom-8;
      // Collection begins at the rendered icon center, following row layout and scroll position.
      const iconRect=visibleRow?row.querySelector('.task-state')?.getBoundingClientRect():null;
      const x=iconRect?iconRect.left-rootRect.left+iconRect.width/2:28,y=iconRect?iconRect.top-rootRect.top+iconRect.height/2:28;
      // Every accepted receipt counts; at most four visual flights coexist during rapid collection.
      if(scope.matchMedia?.('(prefers-reduced-motion: reduce)').matches||this.flights.size>=4){
        this.landed++;this.syncPocket();this.showToast(reward.combo);return;
      }
      const monkey=this.doc.getElementById('greetMonkey')?.getBoundingClientRect();
      const endX=monkey?monkey.left-rootRect.left+monkey.width*.78:x,endY=monkey?monkey.top-rootRect.top+monkey.height*.86:28;
      const group=this.doc.createElement('span');group.className='read-flight';group.dataset.tier=String(Math.min(3,reward.combo));layer.append(group);this.flights.add(group);
      const banana=this.effect(group,'read-banana',x,y);
      for(const [k,v] of Object.entries({'--fly-x':endX-x+'px','--fly-y':endY-y+'px','--bend-x':Math.max(36,(endX-x)*.35+44)+'px','--bend-y':(endY-y)*.4-26+'px'}))banana.style.setProperty(k,v);
      this.effect(group,'read-pick',x,y);
      this.effect(group,'read-score',x+16,y-8,reward.combo>1?'×'+reward.combo+'  +1':'+1');
      const vectors=[[-15,-10],[11,-17],[19,6],[-11,14],[22,-10],[-19,4]];
      const burst=reward.combo>=3?vectors:vectors.slice(0,4);
      for(const [i,[dx,dy]] of burst.entries()){
        const pixel=this.effect(group,'read-spark',x,y);
        for(const [k,v] of Object.entries({'--dx':dx+'px','--dy':dy+'px','--spark-color':['var(--yellow)','var(--green)','var(--yellow)','var(--green-ink)'][i%4]}))pixel.style.setProperty(k,v);
      }
      this.later(()=>{
        banana.hidden=true;this.landed++;this.syncPocket();
        if(!this.canPlay()){group.remove();this.flights.delete(group);return;}
        this.showToast(this.ledger.combo);
        this.effect(group,'read-catch',endX,endY);
        const revision=++this.catchRevision;
        if(this.monkey)this.monkey.dataset.harvest='catch';
        this.celebrate();
        this.later(()=>{if(revision===this.catchRevision&&this.monkey)delete this.monkey.dataset.harvest;group.remove();this.flights.delete(group);},420);
      },740);
      // Animate only the geometric gap after a board removal; no title/message copies.
      if(context.mode==='compact'&&context.filter==='board'){
        const positions=rows.filter(r=>r!==row&&r.dataset.status!=='running').map(r=>[r,r.getBoundingClientRect().top]);
        scope.requestAnimationFrame(()=>{
          if(epoch!==this.epoch||!this.enabled||this.doc.hidden)return;
          for(const [element,top] of positions){
            if(!element.isConnected)continue;
            const dy=top-element.getBoundingClientRect().top;
            if(!dy||Math.abs(dy)>100||typeof element.animate!=='function')continue;
            const animation=element.animate([{transform:`translateY(${dy}px)`},{transform:'translateY(0)'}],{duration:210,easing:'ease-out'});
            this.animations.add(animation);animation.finished.then(()=>this.animations.delete(animation)).catch(()=>this.animations.delete(animation));
          }
        });
      }
    }
  }
  if(typeof module!=='undefined'&&module.exports)module.exports={ReadPlayLedger,ReadPlay,localWeekStart};
  else scope.WorkTwinReadPlay=ReadPlay;
})(typeof window==='undefined'?globalThis:window);
