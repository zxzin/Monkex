// Real UI with synthetic responses; no real tasks are opened or answered.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/qa-monkex-input-reminders');
fs.mkdirSync(out,{recursive:true});
const now=()=>Math.floor(Date.now()/1000);
const pending=()=>({pending:true,count:1,available:true,observed_at:now(),turn_id:'test-turn'});
const feed=()=>({observed_at:now(),health:{app_server:'online',usage:{weekly:{available:true,remaining_percent:85,observed_at:now(),resets_at:now()+7200}}},coverage:{external_runtime:'local_events'},threads:[
  {id:'done',name:'Ready for review',summary:'Completed example result',status:'result_ready',unread:true,pending_result_version:'r1',updated_at:now()-200,cwd:'/demo/studio',project_label:'Studio'},
  {id:'input-a',name:'Choose the next direction for this very long sample project title',summary:'Your choice will guide the next step',status:'completed',latest_turn_id:'test-turn',unread:true,pending_result_version:'r2',updated_at:now()-500,cwd:'/demo/studio',project_label:'Studio',input_request:pending()},
  {id:'input-b',name:'Research continues while a question is open',summary:'Current tools and token activity remain visible',status:'running',latest_turn_id:'test-turn',unread:false,updated_at:now()-600,cwd:'/demo/studio',project_label:'Studio',input_request:pending(),tokens:{ready:true,tokens_per_min:14200,last_report_at:now()},runtime:{phase:'thinking',observation_available:true,activity_at:now()}},
  {id:'running',name:'Build a sample preview',summary:'The original task is still running',status:'running',unread:false,updated_at:now(),cwd:'/demo/studio',project_label:'Studio',runtime:{phase:'tool',pending_tools:1,activity_at:now(),observation_available:true}}
]});
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.MONKEX_QA_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),errors=[],records=[];
  try{for(const lang of ['zh','en'])for(const width of [344,300]){
    const context=await browser.newContext({viewport:{width,height:420},locale:lang==='en'?'en-US':'zh-CN',deviceScaleFactor:2,reducedMotion:'reduce'});
    const page=await context.newPage(),server={feed:feed(),writes:[]};page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://monkex.test/**',async route=>{
      const req=route.request(),pathname=new URL(req.url()).pathname;
      if(pathname==='/api/events')return route.fulfill({status:200,contentType:'text/event-stream',body:'event: ready\ndata: {}\n\n'});
      if(pathname.startsWith('/api/diagnostics'))return route.fulfill({json:{data_state:'current',observed_at:now(),operational:{state:'waiting_user',level:'notice',code:'awaiting_user_input',affected_tasks:2},activity:{},network:{},official:{},tasks:[],assessment:{code:'awaiting_user_input'}}});
      if(pathname.startsWith('/api/')){if(req.method()==='POST'){server.writes.push(pathname);return route.fulfill({json:{ok:true}})}return route.fulfill({json:server.feed});}
      const file=path.join(root,pathname==='/'?'shell/index.html':pathname);
      if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:'Missing'});
      return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'image/png',body:fs.readFileSync(file)});
    });
    await page.goto(`http://monkex.test/shell/index.html?pet=1&expanded=1&lang=${lang}`);
    await page.waitForFunction(()=>document.querySelectorAll('.input-bubble').length===2);
    assert.equal(await page.locator('.input-bubble').first().innerText(),lang==='en'?'Needs reply':'需要你回复');
    const geometry=await page.locator('.task-button[data-status=waiting]').evaluateAll(rows=>rows.map(row=>{const title=row.querySelector('strong').getBoundingClientRect(),bubble=row.querySelector('.input-bubble').getBoundingClientRect(),r=row.getBoundingClientRect();return {width:r.width,titleRight:title.right,bubbleLeft:bubble.left,bubbleRight:bubble.right,right:r.right,scrollWidth:row.scrollWidth};}));
    assert.ok(geometry.every(row=>row.titleRight<=row.bubbleLeft&&row.bubbleRight<=row.right&&row.scrollWidth<=Math.ceil(row.width)),'title and reply bubble fit without overlap');
    assert.match(await page.locator('[data-thread-id="input-b"] .row-rate').innerText(),/14.2k t\/min/);
    await page.screenshot({path:path.join(out,`${lang}-${width}-board.png`)});
    await page.locator('[data-thread-id="input-a"] .input-bubble').click();
    await page.waitForFunction(()=>state.selectedThreadId==='input-a');
    assert.deepEqual(server.writes,['/api/threads/input-a/open'],'input card opens its exact chat and preserves unread results');
    await page.evaluate(()=>cancelAutoCollapse());
    await page.locator('#runtimeHealthToggle').click();
    assert.match(await page.locator('#healthOperationalReason').innerText(),lang==='en'?/Codex needs your reply/:/Codex 正在等你回复/);
    await page.locator('#healthCloseButton').click();
    await page.locator('#collapseButton').click();
    const pet=await page.locator('#petInputBubble').boundingBox();
    assert.ok(pet.x>=0&&pet.y>=0&&pet.x+pet.width<=76&&pet.y+pet.height<=76,'collapsed bubble stays inside native 76px footprint');
    assert.equal(await page.locator('#petInputBubble').innerText(),'2');
    await page.screenshot({path:path.join(out,`${lang}-${width}-tree.png`),clip:{x:0,y:0,width:76,height:76}});
    await page.locator('#petInputBubble').click();
    await page.waitForFunction(()=>state.mode==='compact');
    await page.evaluate(()=>cancelAutoCollapse());
    assert.ok(server.writes.every(p=>p.endsWith('/open')),'tree reminders never acknowledge, answer, or approve');
    server.feed.threads.forEach(card=>{if(card.input_request)card.input_request={pending:false,available:true,observed_at:now()}});
    await page.evaluate(()=>refresh());assert.equal(await page.locator('.input-bubble').count(),0);assert.equal(await page.locator('#petInputBubble').isHidden(),true);
    server.feed.threads[1].input_request={...pending(),available:false};
    await page.evaluate(()=>refresh());assert.equal(await page.locator('[data-thread-id="input-a"]').getAttribute('data-status'),'pending');assert.equal(await page.locator('.input-bubble').count(),0);
    server.feed.threads[1].input_request={...pending(),observed_at:now()-31};
    await page.evaluate(()=>refresh());assert.equal(await page.locator('.input-bubble').count(),0);
    server.feed.threads[1].input_request=pending();server.feed.error='Synthetic offline';
    await page.evaluate(()=>refresh());assert.equal(await page.locator('#petInputBubble').isHidden(),true);assert.equal(await page.locator('.input-bubble').count(),0);
    records.push({lang,width,geometry,pet,writes:server.writes});await context.close();
  }}finally{await browser.close()}
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'qa.json'),JSON.stringify({records,errors},null,2)+'\n');console.log(JSON.stringify({layouts:records.length,errors}));
})().catch(e=>{console.error(e);process.exitCode=1});
