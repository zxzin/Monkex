// Synthetic, local-only visual and motion checks for the independent reply bubble.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/qa-monkex-bubble-polish');
fs.mkdirSync(out,{recursive:true});
const item=(index,lang)=>({thread_id:'polish-demo-'+index,turn_id:'polish-turn',question_id:'polish-question-'+index,title:lang==='en'?'Demo · Review this project direction and next steps':'演示 · 确认项目下一步的方向与细节',count:2,available:true});
const settle=page=>page.evaluate(()=>new Promise(resolve=>setTimeout(resolve,330)));
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.MONKEX_QA_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),records=[],errors=[];
  try{for(const lang of ['zh','en'])for(const motion of ['no-preference','reduce']){
    const context=await browser.newContext({viewport:{width:196,height:168},locale:lang==='en'?'en-US':'zh-CN',deviceScaleFactor:2,reducedMotion:motion}),page=await context.newPage(),writes=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(({entry,lang})=>{
      window.__MONKEX_REMINDER_FIXTURE__={snapshot:{items:[entry],lang,revision:1,stale:false}};
      window.__polishAnimations=[];window.__polishNative=[];
      document.addEventListener('animationstart',event=>window.__polishAnimations.push({name:event.animationName,thread:event.target.closest?.('.reminder-row')?.dataset.threadId}),true);
      window.__TAURI__={core:{invoke:async(command,args)=>{
        window.__polishNative.push({command,args});
        if(command==='get_input_reminders')return structuredClone(window.__MONKEX_REMINDER_FIXTURE__.snapshot);
        if(['set_input_reminder_interaction','set_input_reminder_page','dismiss_input_reminder'].includes(command))return null;
        throw Error('Unexpected native command '+command);
      }}};
    },{entry:item(0,lang),lang});
    await page.route('http://monkex.test/**',async route=>{
      const request=route.request(),pathname=new URL(request.url()).pathname;
      if(pathname.startsWith('/api/')){writes.push({path:pathname,body:request.postDataJSON()});return route.fulfill({json:{ok:false}});}
      const file=path.join(root,pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:'Missing'});
      return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync(file)});
    });
    await page.goto(`http://monkex.test/shell/reminders.html?lang=${lang}&fixture=1`);
    await page.waitForFunction(()=>window.__monkexReminderController?.items.length===1);
    await settle(page);
    const initial=await page.evaluate(()=>{
      const row=document.querySelector('.reminder-row');window.__polishFirstRow=row;
      const bubble=row.querySelector('.reminder-bubble'),title=row.querySelector('.reminder-title'),detail=row.querySelector('.reminder-detail'),arrow=row.querySelector('.reminder-arrow');
      const box=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
      const cs=getComputedStyle(bubble),arrowStyle=getComputedStyle(arrow),rowStyle=getComputedStyle(row);
      return {row:box(row),bubble:box(bubble),title:box(title),detail:box(detail),arrow:box(arrow),radius:cs.borderTopLeftRadius,arrowRadius:arrowStyle.borderRadius,animationName:rowStyle.animationName,animations:window.__polishAnimations.slice(),scroll:document.documentElement.scrollWidth};
    });
    assert.equal(initial.scroll,196);assert.equal(initial.bubble.height,46);assert.equal(initial.bubble.width,184);assert.equal(initial.arrow.width,24);assert.equal(initial.arrow.height,24);
    assert.ok(initial.title.right<=initial.arrow.x-2,'title stays clear of the circular reply cue');
    assert.ok(initial.detail.right<=initial.arrow.x-2,'secondary text stays clear of the reply cue');
    assert.ok(initial.title.bottom<=initial.detail.y,'title and state have separate lines');
    assert.ok(initial.title.x>=initial.bubble.x&&initial.arrow.right<=initial.bubble.right);
    assert.ok(parseFloat(initial.radius)>=15,'the bubble has a soft continuous outline');
    assert.ok(initial.arrowRadius.includes('50%')||parseFloat(initial.arrowRadius)>=12,'the reply cue remains circular');
    if(motion==='reduce')assert.equal(initial.animations.length,0,'reduced motion prevents entry animation');
    else assert.equal(initial.animations.filter(event=>event.thread==='polish-demo-0').length,1,'the first bubble enters exactly once');
    const starts=initial.animations.length;
    await page.evaluate(async()=>{for(let i=0;i<4;i++){window.__MONKEX_REMINDER_FIXTURE__.snapshot.revision++;await window.__monkexReminderController.refresh();}});
    await settle(page);
    assert.equal(await page.evaluate(()=>document.querySelector('.reminder-row')===window.__polishFirstRow),true,'polling preserves the visible DOM node');
    assert.equal(await page.evaluate(()=>window.__polishAnimations.length),starts,'ordinary polling never replays entry motion');
    const beforeHover=await page.locator('.reminder-bubble').boundingBox();await page.locator('.reminder-bubble').hover();await settle(page);
    assert.deepEqual(await page.locator('.reminder-bubble').boundingBox(),beforeHover,'hover preserves the full-row click target');
    await page.mouse.move(195,167);
    for(const desktop of ['light','dark']){
      await page.evaluate(color=>{document.documentElement.style.background=color;document.body.style.background=color;},desktop==='dark'?'#14251c':'#f7f8f6');
      await page.screenshot({path:path.join(out,`${lang}-${motion}-${desktop}.png`),clip:{x:0,y:0,width:196,height:64}});
    }
    await page.evaluate(async entry=>{const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot;snapshot.items.push(entry);snapshot.revision++;await window.__monkexReminderController.refresh();},item(1,lang));
    await settle(page);
    const entryEvents=await page.evaluate(()=>window.__polishAnimations);
    if(motion==='no-preference'){
      assert.equal(entryEvents.filter(event=>event.thread==='polish-demo-0').length,1);
      assert.equal(entryEvents.filter(event=>event.thread==='polish-demo-1').length,1,'only the newly created row animates');
    }else assert.equal(entryEvents.length,0);
    await page.evaluate(async entry=>{const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot;snapshot.items.push(entry);snapshot.revision++;await window.__monkexReminderController.refresh();},item(2,lang));
    await settle(page);await page.screenshot({path:path.join(out,`${lang}-${motion}-three.png`)});
    for(const anchor of ['above','below'])for(const offset of [20,92,164]){
      const tail=await page.evaluate(({anchor,offset})=>{
        document.documentElement.dataset.anchor=anchor;document.documentElement.style.setProperty('--reminder-tail-x',offset+'px');
        const node=document.querySelector('.reminder-bubble'),style=getComputedStyle(node,'::after');
        return {top:style.top,bottom:style.bottom,left:style.left,width:style.width,height:style.height,transform:style.transform};
      },{anchor,offset});
      assert.ok(Number.isFinite(parseFloat(tail.left))&&parseFloat(tail.left)>=0&&parseFloat(tail.left)+parseFloat(tail.width)<=184,'the tail stays within the horizontal bubble bounds');
      if(anchor==='below')assert.ok(parseFloat(tail.top)<0,'below-tree placement points upward');else assert.ok(parseFloat(tail.bottom)<0,'above-tree placement points downward');
      if(motion==='reduce')await page.screenshot({path:path.join(out,`${lang}-tail-${anchor}-${offset}.png`),clip:{x:0,y:0,width:196,height:64}});
    }
    await page.evaluate(()=>{document.documentElement.dataset.anchor='above';document.documentElement.style.setProperty('--reminder-tail-x','92px');});
    await page.locator('.reminder-bubble').first().click();await page.waitForFunction(()=>!window.__monkexReminderController.busy.size);
    assert.equal(writes.length,1);assert.equal(writes[0].path,'/api/threads/polish-demo-0/open-input');assert.equal(await page.locator('.reminder-bubble').first().getAttribute('data-state'),'error');
    assert.ok(await page.locator('.reminder-bubble').first().isEnabled());await page.screenshot({path:path.join(out,`${lang}-${motion}-error.png`)});
    await page.evaluate(async()=>{const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot;snapshot.stale=true;snapshot.revision++;await window.__monkexReminderController.refresh();});
    assert.ok(await page.locator('.reminder-bubble').first().isDisabled());assert.equal(await page.locator('.reminder-detail-text').first().innerText(),lang==='en'?'Pending sync':'待同步');
    await page.screenshot({path:path.join(out,`${lang}-${motion}-stale.png`)});
    records.push({lang,motion,initial,entryEvents,writes});await context.close();
  }
  for(const lang of ['zh','en']){
    const context=await browser.newContext({viewport:{width:196,height:64},locale:lang==='en'?'en-US':'zh-CN',deviceScaleFactor:2,reducedMotion:'reduce'}),page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(({lang,entry})=>{
      window.__MONKEX_REMINDER_FIXTURE__={snapshot:{items:[entry],lang,revision:1,stale:false}};window.__widthNative=[];
      window.__TAURI__={core:{invoke:async(command,args)=>{window.__widthNative.push({command,args});if(command==='get_input_reminders')return structuredClone(window.__MONKEX_REMINDER_FIXTURE__.snapshot);if(['set_input_reminder_interaction','set_input_reminder_page','dismiss_input_reminder'].includes(command))return null;throw Error('Unexpected command '+command);}}};
    },{lang,entry:{...item(0,lang),title:lang==='en'?'Reply':'短任务'}});
    await page.route('http://monkex.test/**',async route=>{
      const pathname=new URL(route.request().url()).pathname;
      if(pathname.startsWith('/api/'))return route.fulfill({json:{ok:false}});
      const file=path.join(root,pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:'Missing'});
      return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync(file)});
    });
    await page.goto(`http://monkex.test/shell/reminders.html?lang=${lang}&fixture=1`);
    await page.waitForFunction(()=>window.__widthNative.some(call=>call.command==='set_input_reminder_page'&&typeof call.args.width==='number'));
    const widthCalls=()=>page.evaluate(()=>window.__widthNative.filter(call=>call.command==='set_input_reminder_page'));
    const applyViewport=async(height=64)=>{
      const width=(await widthCalls()).at(-1).args.width;
      assert.ok(width>=152&&width<=196);assert.equal(width%2,0);
      await page.setViewportSize({width,height});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const geometry=await page.evaluate(()=>{const row=document.querySelector('.reminder-bubble'),title=row.querySelector('.reminder-title'),detail=row.querySelector('.reminder-detail-text'),arrow=row.querySelector('.reminder-arrow'),box=node=>node.getBoundingClientRect().toJSON();return {surface:box(document.querySelector('#reminderSurface')),bubble:box(row),title:box(title),detail:box(detail),arrow:box(arrow),scroll:document.documentElement.scrollWidth};});
      assert.equal(geometry.surface.width,width);assert.equal(geometry.bubble.width,width-12);assert.equal(geometry.bubble.height,46);assert.equal(geometry.scroll,width);
      assert.ok(geometry.title.right<=geometry.arrow.x-2&&geometry.detail.right<=geometry.arrow.x-2);
      return {width,geometry};
    };
    const short=await applyViewport();if(lang==='zh')assert.equal(short.width,152,'a short Chinese task shrinks the bubble to its compact minimum');
    await page.screenshot({path:path.join(out,`${lang}-width-short.png`)});
    const stableCalls=(await widthCalls()).length;
    await page.evaluate(async()=>{for(let i=0;i<4;i++){window.__MONKEX_REMINDER_FIXTURE__.snapshot.revision++;await window.__monkexReminderController.refresh();}});
    assert.equal((await widthCalls()).length,stableCalls,'stable polling and a native viewport resize do not repeat the same width command');
    await page.evaluate(async title=>{const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot;snapshot.items[0].title=title;snapshot.revision++;await window.__monkexReminderController.refresh();},lang==='en'?'Review colors now':'确认新页面配色方案');
    const moderate=await applyViewport();assert.ok(moderate.width>=short.width&&moderate.width<196,'moderate titles use an intermediate width');
    await page.screenshot({path:path.join(out,`${lang}-width-moderate.png`)});
    await page.evaluate(async title=>{const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot;snapshot.items[0].title=title;snapshot.revision++;await window.__monkexReminderController.refresh();},item(0,lang).title);
    const long=await applyViewport();assert.equal(long.width,196,'long titles retain the bounded maximum');
    await page.screenshot({path:path.join(out,`${lang}-width-long.png`)});
    await page.evaluate(async title=>{const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot;snapshot.items[0].title=title;snapshot.revision++;await window.__monkexReminderController.refresh();},lang==='en'?'Reply':'短任务');
    await applyViewport();await page.locator('.reminder-bubble').click();await page.waitForFunction(()=>!window.__monkexReminderController.busy.size);
    const failed=await applyViewport();assert.ok(failed.width>=short.width,'a longer error status may grow the bubble');assert.equal(await page.locator('.reminder-bubble').getAttribute('data-state'),'error');assert.ok(await page.locator('.reminder-bubble').isEnabled());
    await page.screenshot({path:path.join(out,`${lang}-width-error.png`)});
    const entries=Array.from({length:4},(_,i)=>({...item(i,lang),question_id:'width-page-'+i,title:i===3?item(i,lang).title:lang==='en'?'Reply':'短任务'}));
    await page.evaluate(async entries=>{const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot;snapshot.items=entries;snapshot.revision++;await window.__monkexReminderController.refresh();},entries);
    const shortPage=await applyViewport(194);assert.equal(shortPage.width,short.width,'hidden-page titles do not inflate the current page');
    await page.locator('#reminderNext').click();const longPage=await applyViewport(90);assert.equal(longPage.width,196,'switching to a longer visible title expands its page');
    assert.equal((await widthCalls()).at(-1).args.page,1);await page.locator('#reminderPrevious').click();const previousPage=await applyViewport(194);assert.equal(previousPage.width,short.width,'returning to a short page restores compact width');
    records.push({lang,surface:'adaptive-width',short,moderate,long,failed,shortPage,longPage,previousPage,nativeCalls:await widthCalls()});await context.close();
  }
  }finally{await browser.close();}
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'qa.json'),JSON.stringify({records,errors},null,2)+'\n');console.log(JSON.stringify({records:records.length,errors}));
})().catch(error=>{console.error(error);process.exitCode=1;});
