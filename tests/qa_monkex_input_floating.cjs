// Actual product DOM with synthetic reminder snapshots; no real Codex conversations.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/qa-monkex-input-floating');fs.mkdirSync(out,{recursive:true});
const item=(i,lang)=>({thread_id:'demo-'+i,turn_id:'turn-demo',question_id:JSON.stringify(['request_user_input_async','call-demo-'+i,0]),title:lang==='en'?`Demo ${i+1} · Choose the next direction for this long project title`:`演示 ${i+1} · 选择项目下一步的页面配色与布局方案`,count:i===0?2:1,available:true});
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.MONKEX_QA_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),records=[],errors=[];
  try{for(const lang of ['zh','en'])for(const count of [1,3,4,5]){
    const height=12+Math.min(count,3)*52+(count>3?26:0),context=await browser.newContext({viewport:{width:196,height},locale:lang==='en'?'en-US':'zh-CN',deviceScaleFactor:2,reducedMotion:'reduce'}),page=await context.newPage(),writes=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(({items,lang})=>{
      window.__MONKEX_REMINDER_FIXTURE__={snapshot:{items,lang,revision:1,stale:false}};window.__nativeCalls=[];window.__nativeDismissed=new Map();window.__nativeHidden=false;
      const key=item=>JSON.stringify([item.thread_id,item.turn_id,item.question_id]);
      window.__TAURI__={core:{invoke:async(command,args)=>{
        window.__nativeCalls.push({command,args});const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot;
        if(['set_input_reminder_interaction','set_input_reminder_page'].includes(command))return null;
        if(command==='dismiss_input_reminder'){window.__nativeDismissed.set(JSON.stringify([args.threadId,args.turnId,args.questionId]),args.count);snapshot.revision++;window.__nativeHidden=!snapshot.items.some(item=>item.count>(window.__nativeDismissed.get(key(item))??0));return null;}
        if(command!=='get_input_reminders')throw Error('Unexpected command');
        const result=structuredClone(snapshot);for(const item of result.items)if(item.count>(window.__nativeDismissed.get(key(item))??Infinity))window.__nativeDismissed.delete(key(item));result.items=result.items.filter(item=>!window.__nativeDismissed.has(key(item)));window.__nativeHidden=!result.items.length;return result;
      }}};
    },{items:Array.from({length:count},(_,i)=>item(i,lang)),lang});
    let response={ok:true,navigation_scope:'thread'};
    await page.route('http://monkex.test/**',async route=>{
      const request=route.request(),pathname=new URL(request.url()).pathname;
      if(pathname.startsWith('/api/')){writes.push({path:pathname,method:request.method(),body:request.postDataJSON(),header:request.headers()['x-work-twin']});return route.fulfill({json:response});}
      const file=path.join(root,pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:'Missing'});
      return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync(file)});
    });
    await page.goto(`http://monkex.test/shell/reminders.html?lang=${lang}&fixture=1`);
    await page.waitForFunction(expected=>window.__monkexReminderController?.items.length===expected,count);
    assert.equal(await page.locator('.reminder-bubble').count(),Math.min(count,3));
    assert.equal(await page.locator('.reminder-title').first().innerText(),item(0,lang).title,'each floating bubble identifies its own task');
    const geometry=await page.locator('#reminderSurface').evaluate(surface=>{const bounds=surface.getBoundingClientRect();return {width:bounds.width,height:bounds.height,scrollWidth:document.documentElement.scrollWidth,rows:[...document.querySelectorAll('.reminder-bubble')].map(row=>{const r=row.getBoundingClientRect(),title=row.querySelector('.reminder-title').getBoundingClientRect(),detail=row.querySelector('.reminder-detail').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,titleBottom:title.bottom,detailTop:detail.top};})};});
    assert.equal(geometry.width,196);assert.equal(geometry.height,height);assert.equal(geometry.scrollWidth,196);assert.ok(geometry.rows.every(row=>row.x>=0&&row.x+row.width<=196&&row.y+row.height<=height&&row.titleBottom<=row.detailTop&&row.height>=44));
    assert.equal(await page.locator('script[src*="app.js"]').count(),0,'child does not boot the board or diagnostics');
    assert.match(await page.locator('.reminder-detail-text').first().innerText(),lang==='en'?/2 questions to reply/:/待回复 · 2 问/);
    await page.screenshot({path:path.join(out,`${lang}-${count}-reminders.png`)});
    if(count>3){
      await page.locator('#reminderNext').click();assert.equal(await page.locator('.reminder-row').first().getAttribute('data-thread-id'),'demo-3');
      assert.equal(await page.evaluate(()=>window.__nativeCalls.filter(call=>call.command==='set_input_reminder_page').at(-1).args.page),1);
      const lastHeight=12+(count-3)*52+26;assert.equal((await page.locator('#reminderSurface').boundingBox()).height,lastHeight,'the final page has only its visible rows and footer');
      await page.setViewportSize({width:196,height:lastHeight});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await page.screenshot({path:path.join(out,`${lang}-${count}-last-page.png`)});
      const sizeCalls=await page.evaluate(()=>window.__nativeCalls.filter(call=>call.command==='set_input_reminder_page').length);
      await page.evaluate(()=>window.__monkexReminderController.refresh());assert.equal(await page.evaluate(()=>window.__nativeCalls.filter(call=>call.command==='set_input_reminder_page').length),sizeCalls,'unchanged polling never repeats a native resize');
      await page.locator('#reminderPrevious').click();assert.equal(await page.evaluate(()=>window.__nativeCalls.filter(call=>call.command==='set_input_reminder_page').at(-1).args.page),0);await page.setViewportSize({width:196,height});
    }
    await page.locator('.reminder-bubble').first().click();await page.waitForFunction(()=>!window.__monkexReminderController.busy.size);
    assert.equal(writes.length,1);assert.equal(writes[0].path,'/api/threads/demo-0/open-input');assert.equal(writes[0].header,'1');assert.deepEqual(Object.keys(writes[0].body).sort(),['question_id','turn_id']);assert.equal(writes[0].body.question_id,item(0,lang).question_id);assert.equal(await page.locator('.reminder-bubble').count(),Math.min(count-1,3));
    assert.equal(await page.locator('[data-thread-id="demo-0"]').count(),0,'the opened reminder disappears');
    await page.evaluate(()=>window.__monkexReminderController.refresh());assert.equal(await page.locator('[data-thread-id="demo-0"]').count(),0,'unchanged polling leaves the opened reminder hidden');
    assert.deepEqual(await page.evaluate(()=>window.__nativeCalls.filter(call=>call.command==='dismiss_input_reminder').at(-1).args),{threadId:'demo-0',turnId:item(0,lang).turn_id,questionId:item(0,lang).question_id,count:item(0,lang).count});
    assert.equal(await page.evaluate(()=>window.__nativeHidden),count===1,'the final dismissal hides the native window');
    await page.screenshot({path:path.join(out,`${lang}-${count}-after-open.png`)});
    await page.evaluate(async()=>{const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot;snapshot.items[0].question_id='new-question';snapshot.revision++;await window.__monkexReminderController.refresh();});assert.ok(await page.evaluate(()=>window.__monkexReminderController.items.some(item=>item.thread_id==='demo-0')),'a new question may remind again');
    if(count===1||count===3){
      await page.evaluate(async items=>{const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot;snapshot.items=items;snapshot.revision++;await window.__monkexReminderController.refresh();},Array.from({length:count},(_,i)=>({...item(i,lang),question_id:'press-'+i})));
      const beforeResize=writes.length,pressedIndex=count===1?0:2,pressed=await page.locator('.reminder-bubble').nth(pressedIndex).boundingBox();
      await page.mouse.move(pressed.x+25,pressed.y+20);await page.mouse.down();
      await page.evaluate(async({count,extra})=>{const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot,first=document.querySelector('.reminder-row').dataset.threadId;snapshot.items=count===1?[...snapshot.items,extra]:snapshot.items.filter(item=>item.thread_id===first);snapshot.revision++;await window.__monkexReminderController.refresh();},{count,extra:item(9,lang)});
      assert.equal(await page.locator('.reminder-bubble').count(),count,'a pressed row keeps its original geometry while the native snapshot changes');
      assert.equal((await page.locator('#reminderSurface').boundingBox()).height,height);
      await page.mouse.up();await page.waitForFunction(()=>!window.__monkexReminderController.busy.size);await page.waitForFunction(()=>document.querySelectorAll('.reminder-bubble').length===1);
      assert.equal(writes.length,beforeResize+(count===1?1:0),'a retained target opens once; a removed target cannot open after release');
      const locks=await page.evaluate(()=>window.__nativeCalls.filter(call=>call.command==='set_input_reminder_interaction'));assert.equal(locks.at(-1).args.active,false);assert.ok(locks.some(call=>call.args.active===true));
      await page.evaluate(async items=>{const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot;snapshot.items=items;snapshot.revision++;await window.__monkexReminderController.refresh();},Array.from({length:count},(_,i)=>({...item(i,lang),question_id:'race-'+i})));
    }
    const before=writes.length;
    const button=page.locator('.reminder-bubble').first(),bounds=await button.boundingBox();await page.mouse.move(bounds.x+30,bounds.y+20);await page.mouse.down();
    await page.evaluate(async()=>{const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot,thread=document.querySelector('.reminder-row').dataset.threadId;snapshot.items.find(item=>item.thread_id===thread).question_id='new-target';snapshot.revision++;await window.__monkexReminderController.refresh();});
    await page.mouse.up();await page.waitForFunction(()=>!window.__monkexReminderController.busy.size);assert.equal(writes.length,before,'refresh during a press never redirects to a different question');
    await page.evaluate(async()=>{const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot;snapshot.stale=true;snapshot.revision++;await window.__monkexReminderController.refresh();});
    await page.waitForFunction(()=>document.querySelector('.reminder-bubble')?.disabled,null,{timeout:3000,polling:50});
    assert.ok(await page.locator('.reminder-bubble').first().isDisabled());assert.equal(await page.locator('.reminder-detail-text').first().innerText(),lang==='en'?'Pending sync':'待同步');
    await page.screenshot({path:path.join(out,`${lang}-${count}-stale.png`)});
    await page.evaluate(async()=>{const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot;snapshot.stale=false;snapshot.revision++;await window.__monkexReminderController.refresh();});
    assert.ok(await page.locator('.reminder-bubble').first().isEnabled());
    response={ok:false};await page.locator('.reminder-bubble').first().click();await page.waitForFunction(()=>!window.__monkexReminderController.busy.size);assert.ok(await page.locator('.reminder-bubble').first().isEnabled());assert.equal(await page.locator('.reminder-bubble').first().getAttribute('data-state'),'error','failed opening keeps a retryable bubble');
    if(count===1){
      await page.evaluate(async()=>{const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot;snapshot.lang=snapshot.lang==='en'?'zh':'en';snapshot.revision++;await window.__monkexReminderController.refresh();});
      assert.equal(await page.locator('html').getAttribute('lang'),lang==='en'?'zh-CN':'en','a reused native reminder window follows the current app language');
    }
    response={ok:false,stale:false,reason:'sync_unavailable'};await page.locator('.reminder-bubble').first().click();await page.waitForFunction(()=>!window.__monkexReminderController.busy.size);await page.waitForFunction(()=>document.querySelector('.reminder-bubble')?.disabled,null,{timeout:3000,polling:50});assert.ok(await page.locator('.reminder-bubble').first().isDisabled());
    await page.evaluate(async()=>{const snapshot=window.__MONKEX_REMINDER_FIXTURE__.snapshot;snapshot.items=[];snapshot.revision++;await window.__monkexReminderController.refresh();});assert.equal(await page.locator('.reminder-bubble').count(),0);
    assert.ok((await page.evaluate(()=>window.__nativeCalls)).every(call=>['get_input_reminders','set_input_reminder_interaction','set_input_reminder_page','dismiss_input_reminder'].includes(call.command)),'reminder only reads metadata and updates its own local window');assert.ok(writes.every(write=>write.path.endsWith('/open-input')));
    records.push({lang,count,height,geometry,writes});await context.close();
  }
  for(const lang of ['zh','en']){
    const context=await browser.newContext({viewport:{width:344,height:420},locale:lang==='en'?'en-US':'zh-CN'}),page=await context.newPage(),now=Math.floor(Date.now()/1000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(()=>{window.__nativeCalls=[];window.__TAURI__={core:{invoke:async(command,args)=>{window.__nativeCalls.push({command,args});return command==='pet_pointer_inside'?false:null;}}};});
    const target={turn_id:'turn-demo',question_id:item(0,lang).question_id};
    const feed={observed_at:now,health:{app_server:'online'},coverage:{external_runtime:'local_events'},threads:[{id:'demo-0',name:'Synthetic reminder',status:'running',unread:true,latest_turn_id:'turn-demo',updated_at:now,input_request:{pending:true,count:2,available:true,turn_id:'turn-demo',target,observed_at:now}}]};
    await page.route('http://monkex.test/**',async route=>{const pathname=new URL(route.request().url()).pathname;
      if(pathname==='/api/events')return route.fulfill({contentType:'text/event-stream',body:'event: ready\ndata: {}\n\n'});
      if(pathname.startsWith('/api/diagnostics'))return route.fulfill({json:{data_state:'current',observed_at:now,operational:{state:'waiting_user',code:'awaiting_user_input'},activity:{},network:{},official:{},tasks:[]}});
      if(pathname.startsWith('/api/'))return route.fulfill({json:feed});
      const file=path.join(root,pathname);return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':file.endsWith('.js')?'application/javascript':'image/png',body:fs.readFileSync(file)});
    });
    await page.goto(`http://monkex.test/shell/index.html?pet=1&lang=${lang}`);
    await page.waitForFunction(()=>window.__nativeCalls.some(call=>call.command==='sync_input_reminders'&&call.args.items.length===1));
    const published=await page.evaluate(()=>window.__nativeCalls.filter(call=>call.command==='sync_input_reminders').at(-1).args);
    assert.deepEqual(Object.keys(published.items[0]).sort(),['available','count','question_id','thread_id','title','turn_id']);assert.equal(published.items[0].available,true);assert.equal(published.items[0].question_id,target.question_id);
    assert.ok(await page.locator('#petInputBubble').isHidden(),'native mode replaces the old tree corner counter');assert.ok(await page.locator('#appShell').isHidden(),'new native reminder metadata keeps the board collapsed');
    feed.threads[0].input_request.available=false;await page.evaluate(()=>refresh());
    assert.equal(await page.evaluate(()=>window.__nativeCalls.filter(call=>call.command==='sync_input_reminders').at(-1).args.items[0].available),false);
    feed.threads[0].input_request.pending=false;await page.evaluate(()=>refresh());assert.equal(await page.evaluate(()=>window.__nativeCalls.filter(call=>call.command==='sync_input_reminders').at(-1).args.items.length),0);
    records.push({lang,surface:'native-main',published});await context.close();
  }
  const context=await browser.newContext({viewport:{width:196,height:64}}),page=await context.newPage();let apiCalls=0;page.on('pageerror',error=>errors.push(error.message));
  await page.route('http://monkex.test/**',async route=>{const pathname=new URL(route.request().url()).pathname;if(pathname.startsWith('/api/')){apiCalls++;return route.fulfill({json:{}});}const file=path.join(root,pathname);return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.css')?'text/css':'application/javascript',body:fs.readFileSync(file)});});
  await page.goto('http://monkex.test/shell/reminders.html?lang=en');assert.equal(await page.locator('#reminderEmpty').innerText(),'Waiting for desktop');assert.equal(apiCalls,0);await context.close();
  }finally{await browser.close();}
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'qa.json'),JSON.stringify({records,errors},null,2)+'\n');console.log(JSON.stringify({layouts:records.length,errors}));
})().catch(error=>{console.error(error);process.exitCode=1;});
