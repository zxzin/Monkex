// Synthetic browser acceptance: compact display, disclosure, error recovery and no task writes.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/qa-monkex-diagnostics');
fs.mkdirSync(out,{recursive:true});
const epoch=()=>Math.floor(Date.now()/1000);
function diagnostics(){const now=epoch();return {observed_at:now,data_state:'current',running_tasks:5,
  score:{value:86,grade:'good',confidence:'short_check',sample_count:18,round_count:6,success_percent:100,p50_ms:420,p95_ms:900,jitter_ms:480,components:{reliability:60,latency:19,stability:7},notes:['public_path_only','short_check_only'],scope:'public_path',codex_observed:true},
  operational:{state:'quiet',level:'notice',code:'quiet',affected_tasks:4,active_tasks:1,quiet_tasks:4,unknown_tasks:0,tool_tasks:1,starting_tasks:3,issue_tasks:0,evidence:['recent_runtime_activity','runtime_quiet','tool_pending'],score_scope:'public_path'},
  activity:{state:'quiet',last_activity_at:now-4,quiet_tasks:4,total_tokens_per_min:12800,output_tokens_per_min:420},
  tasks:[{id:'demo-a',name:'Prepare launch assets',phase:'response',activity_age_seconds:4,signal:'active',output_tokens_per_min:420,report_age_seconds:8},...Array.from({length:4},(_,i)=>({id:'demo-quiet-'+i,name:i===0?'Run regression checks':'Waiting for first response '+i,phase:i===0?'tool':'starting',pending_tools:i===0?1:0,activity_age_seconds:240,signal:'quiet',output_tokens_per_min:0,report_age_seconds:240}))],
  network:{checked_at:now,route:'system_proxy',rounds_completed:6,rounds_planned:6,checks:[{id:'general',state:'reachable',latency_ms:43,median_ms:44},{id:'codex',state:'reachable',latency_ms:420,median_ms:450},{id:'api',state:'reachable',latency_ms:400},{id:'auth',state:'reachable',latency_ms:390}]},
  official:{state:'operational',checked_at:now,components:[{name:'Codex',status:'operational'}],incidents:[]},assessment:{level:'notice',code:'quiet'}};}
function feed(){const now=epoch();return {observed_at:now,health:{app_server:'online',usage:{weekly:{available:true,remaining_percent:65,observed_at:now,resets_at:now+86400},details:{observed_at:now,credit_balance:{available:true,balance:'12345.67'},reset_cards:{available:true,available_count:3,expirations:[{count:3,expires_at:now+86400}]},windows:[{window_minutes:10080,resets_at:now+86400}]}}},threads:[
  {id:'demo-a',name:'Prepare launch assets',summary:'Editing visual examples',project_label:'Demo project',status:'running',updated_at:now,runtime:{phase:'response',activity_at:now-4,pending_tools:0,observation_available:true},tokens:{ready:true,tokens_per_min:12800,last_report_at:now-4}},
  {id:'demo-b',name:'Run regression checks',summary:'Waiting for tool response',project_label:'Demo project',status:'running',updated_at:now,runtime:{phase:'tool',activity_at:now-240,pending_tools:1,observation_available:true},tokens:{ready:true,tokens_per_min:0,last_report_at:now-240}},
  {id:'demo-c',name:'Publish notes',summary:'Release notes ready for review',project_label:'Demo project',status:'idle',unread:true,updated_at:now-500}
]};}
async function geometry(page){
  const g=await page.evaluate(()=>{const box=element=>{const r=(typeof element==='string'?document.getElementById(element):element).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,width:r.width,height:r.height,bottom:r.bottom};};return {width:innerWidth,overflow:document.documentElement.scrollWidth,app:box('appShell'),health:box('runtimeHealth'),body:box('runtimeHealthBody'),list:box('taskList'),badge:box('runtimeHealthToggle'),heart:box(document.querySelector('.health-heart')),reading:box(document.querySelector('.health-reading')),number:box('healthBadgeValue'),numberFont:getComputedStyle(document.getElementById('healthBadgeValue')).fontSize,alert:box('healthRuntimeAlert'),caption:box(document.querySelector('.health-caption')),captionFont:getComputedStyle(document.querySelector('.health-caption')).fontSize,quota:box('weeklyQuota'),coin:box('quotaCoinButton'),pin:box('pinButton'),title:box('viewHeading'),anchor:Number.parseFloat(document.getElementById('runtimeHealth').style.getPropertyValue('--health-anchor-x'))};});
  assert.ok(g.overflow<=g.width&&g.list.height>=40&&g.app.bottom<=421,JSON.stringify(g));
  const overlaps=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
  assert.ok(!overlaps(g.badge,g.coin)&&!overlaps(g.badge,g.pin)&&!overlaps(g.coin,g.pin),JSON.stringify(g));
  assert.ok(g.title.right<=g.badge.left&&g.badge.right<=g.quota.left&&g.title.width>=45,'brand, health and quota stay in order: '+JSON.stringify(g));
  const narrow=g.width<=320,heartSize=narrow?16:18;
  assert.ok(Math.abs(g.badge.width-(narrow?40:44))<=1&&Math.abs(g.badge.height-(narrow?30:32))<=1,'the selected badge keeps its compact footprint: '+JSON.stringify(g));
  assert.ok(Math.abs(g.heart.width-heartSize)<=1&&Math.abs(g.heart.height-heartSize)<=1,'the pixel heart stays compact: '+JSON.stringify(g));
  assert.ok(g.heart.right<=g.reading.left&&g.number.left>=g.badge.left&&g.number.right<=g.badge.right,'heart and number have distinct readable space: '+JSON.stringify(g));
  assert.ok(Math.abs(g.heart.top+g.heart.height/2-g.reading.top-g.reading.height/2)<=1,'the heart and numeric reading align vertically: '+JSON.stringify(g));
  assert.equal(g.numberFont,'13px','the numeric reading uses the smaller selected type size, including 100');assert.equal(g.captionFont,'7px');
  if(g.alert.width)assert.ok(!overlaps(g.alert,g.number)&&!overlaps(g.alert,g.heart),'the independent task marker stays clear of the score and heart: '+JSON.stringify(g));
  assert.ok(g.caption.left>=g.badge.left&&g.caption.right<=g.badge.right&&g.caption.bottom<=g.badge.bottom,'the connection label fits its control');
  if(g.health.height){assert.ok(g.health.left>=0&&g.health.right<=g.width&&g.health.bottom<=g.app.bottom,JSON.stringify(g));assert.ok(Math.abs(g.health.top-g.badge.bottom-10)<=2,'popover starts below its badge');assert.ok(Math.abs(g.health.left+g.anchor-(g.badge.left+g.badge.width/2))<=2,'arrow points to the badge');}
  return g;
}
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.MONKEX_QA_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),errors=[],layouts=[];
  try{for(const lang of ['zh','en'])for(const width of [344,300]){
    const context=await browser.newContext({viewport:{width,height:420},locale:lang==='en'?'en-US':'zh-CN',deviceScaleFactor:2,reducedMotion:'reduce'});const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    const server={data:diagnostics(),feed:feed(),checks:0,writes:[],fail:false};
    await page.route('http://monkex.test/**',async route=>{
      const req=route.request(),pathname=new URL(req.url()).pathname;
      if(pathname==='/api/events')return route.fulfill({status:200,contentType:'text/event-stream',body:'event: ready\ndata: {}\n\n'});
      if(pathname.startsWith('/api/diagnostics')){if(req.method()==='POST'){server.checks++;assert.deepEqual(req.postDataJSON(),{reset:true},'current-node retest starts a fresh sample session');}if(server.fail)return route.fulfill({status:503,json:{error:'Unavailable'}});return route.fulfill({json:server.data});}
      if(pathname.startsWith('/api/')){if(req.method()==='POST')server.writes.push(pathname);return route.fulfill({json:server.feed});}
      const file=path.join(root,pathname==='/'?'shell/index.html':pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:'Missing'});
      return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'image/png',body:fs.readFileSync(file)});
    });
    await page.goto(`http://monkex.test/shell/index.html?pet=1&expanded=1&lang=${lang}`);
    await page.waitForFunction(()=>document.getElementById('healthScoreValue').textContent==='86 /100');
    assert.equal(await page.locator('#runtimeHealth').isHidden(),true);
    assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('aria-expanded'),'false');
    assert.equal(await page.locator('header #runtimeHealthToggle').count(),1);
    assert.equal(await page.locator('#runtimeHealthToggle').evaluate(element=>element.tagName),'BUTTON');
    assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('data-level'),'notice');assert.equal(await page.locator('#healthRuntimeAlert').isVisible(),true);assert.equal(await page.locator('#healthRuntimeAlert').getAttribute('data-level'),'notice');
    assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('data-score-level'),'ok');assert.equal(await page.locator('#healthBadgeValue').innerText(),'86');
    assert.equal(await page.locator('.health-caption').innerText(),lang==='en'?'Link':'连接');assert.equal(await page.locator('#runtimeHealthToggle #healthBadgeValue').count(),1);assert.equal(await page.locator('#runtimeHealth #healthScoreValue').count(),1);
    assert.equal(await page.locator('.health-ring,#healthStatusSymbol').count(),0);
    layouts.push({lang,width,state:'collapsed',...await geometry(page)});
    await page.screenshot({path:path.join(out,`${lang}-${width}-collapsed.png`)});
    await page.locator('#runtimeHealthToggle').click();
    await page.locator('#runtimeHealth').waitFor({state:'visible'});
    assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('aria-expanded'),'true');
    await page.waitForFunction(()=>document.getElementById('taskList').getBoundingClientRect().height>=40);
    layouts.push({lang,width,state:'expanded',...await geometry(page)});
    await page.screenshot({path:path.join(out,`${lang}-${width}-expanded.png`)});
    await page.keyboard.press('Escape');assert.equal(await page.locator('#runtimeHealth').isHidden(),true);
    await page.keyboard.press('Enter');assert.equal(await page.locator('#runtimeHealth').isVisible(),true);
    await page.locator('#healthCloseButton').click();assert.equal(await page.locator('#runtimeHealth').isHidden(),true);
    await page.locator('#runtimeHealthToggle').click();
    await page.locator('#healthCheckButton').click();
    await page.waitForFunction(()=>!document.getElementById('healthCheckButton').disabled);
    assert.equal(server.checks,1);assert.deepEqual(server.writes,[],'health controls do not mark tasks read or refresh their state');
    await page.locator('#healthTaskSummary').click();
    assert.equal(await page.locator('.health-task').count(),5);assert.match(await page.locator('#healthTaskList').innerText(),lang==='en'?/4 min ago/:/4 分钟前/);
    await page.locator('#quotaResetToggle').click();assert.equal(await page.locator('#runtimeHealth').isHidden(),true,'quota disclosure closes health');
    assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('aria-expanded'),'false');
    await page.locator('#runtimeHealthToggle').click();await page.locator('#quotaResetWindows').waitFor({state:'hidden'});
    await page.locator('#greetMonkey').click();await page.locator('#runtimeHealth').waitFor({state:'hidden'});
    await page.locator('#resetCardDetails>summary').click();
    assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('aria-expanded'),'false');
    await page.locator('#runtimeHealthToggle').click();await page.waitForFunction(()=>!document.getElementById('resetCardDetails').open);
    for(const [value,grade,scoreLevel]of [[0,'poor','warning'],[65,'fair','notice'],[100,'good','ok'],[null,'collecting','unknown'],[86,'stale','unknown']]){
      server.data.score={...server.data.score,value,grade};await page.locator('#healthCheckButton').click();
      await page.waitForFunction(()=>!document.getElementById('healthCheckButton').disabled);
      const expected=value===null||grade==='stale'?'—':value+' /100';await page.waitForFunction(expected=>document.getElementById('healthScoreValue').textContent===expected,expected);
      assert.equal(await page.locator('#healthBadgeValue').innerText(),expected==='—'?'—':String(value));assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('data-score-level'),scoreLevel);
      assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('data-level'),'notice','network quality and sampling state do not override quiet tasks');assert.equal(await page.locator('#healthRuntimeAlert').isVisible(),true);assert.equal(await page.locator('#healthRuntimeAlert').getAttribute('data-level'),'notice');
      assert.ok((await page.locator('#runtimeHealthToggle').getAttribute('aria-label')).includes(expected));await geometry(page);
      if(value===100)await page.screenshot({path:path.join(out,`${lang}-${width}-score-100.png`)});
    }
    for(const [status,level,code,showAlert,renderedLevel]of [['active','ok','active',false,'ok'],['tool_running','ok','tool_running',false,'ok'],['tool_running','notice','tool_wait',true,'notice'],['waiting','notice','awaiting_response',true,'notice'],['unknown','unknown','activity_unconfirmed',true,'unknown'],['error','error','recent_connection_error',true,'warning'],['idle','ok','idle',false,'unknown']]){
      server.data=diagnostics();server.data.score.value=100;server.data.operational={...server.data.operational,state:status,level,code};await page.locator('#healthCheckButton').click();
      await page.waitForFunction(()=>!document.getElementById('healthCheckButton').disabled);assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('data-level'),renderedLevel);assert.equal(await page.locator('#healthScoreValue').innerText(),'100 /100');
      assert.equal(await page.locator('#healthBadgeValue').innerText(),'100');assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('data-score-level'),'ok');assert.equal(await page.locator('#healthRuntimeAlert').isVisible(),showAlert);assert.equal(await page.locator('#healthRuntimeAlert').getAttribute('data-level'),renderedLevel);
      const accessibleName=await page.locator('#runtimeHealthToggle').getAttribute('aria-label');assert.match(accessibleName,/100 \/100/);assert.ok(accessibleName.includes(await page.locator('#healthSummary').innerText()),'the accessible name independently describes runtime status');assert.doesNotMatch(accessibleName,/Short check|短测完成/);await geometry(page);
    }
    // Task observation freshness and public-probe freshness are separate signals.
    server.data=diagnostics();server.data.data_state='stale';server.data.score.value=100;
    await page.locator('#healthCheckButton').click();await page.waitForFunction(()=>!document.getElementById('healthCheckButton').disabled&&document.getElementById('runtimeHealthToggle').dataset.level==='unknown');
    assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('data-level'),'unknown');assert.equal(await page.locator('#healthScoreValue').innerText(),'100 /100');assert.equal(await page.locator('#healthBadgeValue').innerText(),'100');assert.equal(await page.locator('#healthRuntimeAlert').isVisible(),true);assert.equal(await page.locator('#healthTotalRate').innerText(),'—');
    const boardIds=await page.locator('#taskList [data-thread-id]').evaluateAll(rows=>rows.map(row=>row.dataset.threadId));
    assert.deepEqual(boardIds,['demo-c','demo-a','demo-b']);
    for(const observerUnavailable of [false,true]){
      server.feed=feed();server.feed.stale=true;
      if(observerUnavailable)server.feed.threads=server.feed.threads.map(card=>card.status==='running'?{...card,status:'unknown',last_observed_status:'running',sync_pending:true,runtime:{...card.runtime,observation_available:false}}:card);
      await page.evaluate(()=>refresh());
      assert.deepEqual(await page.locator('#taskList [data-thread-id]').evaluateAll(rows=>rows.map(row=>row.dataset.threadId)),boardIds,'temporary feed or observer loss preserves running-card membership and order');
      assert.equal(await page.locator('[data-thread-id="demo-a"]').getAttribute('data-status'),'pending');assert.equal(await page.locator('[data-thread-id="demo-b"]').getAttribute('data-status'),'pending');
      assert.match(await page.locator('[data-thread-id="demo-b"] .row-rate').innerText(),lang==='en'?/Pending sync/:/待同步/);
      server.feed=feed();await page.evaluate(()=>refresh());
      assert.equal(await page.locator('[data-thread-id="demo-b"]').getAttribute('data-status'),'running');
      assert.match(await page.locator('[data-thread-id="demo-b"] .row-rate').innerText(),lang==='en'?/Tool wait/:/等待工具/,'a zero report during an outstanding tool is explained by its observed phase');
      assert.match(await page.locator('[data-thread-id="demo-a"] .row-rate').innerText(),/12\.8k t\/min/);
    }
    assert.deepEqual(server.writes,[],'observation-loss and recovery checks never mark tasks read or reconnect Codex');
    server.data=diagnostics();server.data.score={...server.data.score,value:null,grade:'collecting',confidence:'collecting',sample_count:0};server.data.network.rounds_completed=0;server.data.network.route_generation=2;server.data.network.node_changed_at=epoch();
    await page.locator('#healthCheckButton').click();await page.waitForFunction(()=>document.getElementById('healthScoreProgress').textContent.includes('0/6'));
    assert.equal(await page.locator('#healthScoreValue').innerText(),'—');assert.equal(await page.locator('#healthBadgeValue').innerText(),'—');assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('data-score-level'),'unknown');
    server.data=diagnostics();
    server.data.activity.output_tokens_per_min=0;server.data.activity.quiet_tasks=0;server.data.assessment={level:'notice',code:'waiting'};
    await page.locator('#healthCheckButton').click();await page.waitForFunction(()=>document.getElementById('healthOutputRate').textContent==='0');
    server.data.activity.output_tokens_per_min=null;await page.locator('#healthCheckButton').click();await page.waitForFunction(()=>document.getElementById('healthOutputRate').textContent==='—');
    server.fail=true;await page.locator('#healthCheckButton').click();await page.locator('#healthCheckError').waitFor({state:'visible'});
    assert.equal(await page.locator('#runtimeHealth').getAttribute('data-level'),'unknown');assert.equal(await page.locator('#healthBadgeValue').innerText(),'—');assert.equal(await page.locator('#healthRuntimeAlert').isVisible(),true);
    server.fail=false;server.data=diagnostics();server.data.official={state:'degraded',checked_at:epoch(),incidents:[{name:'<img src=x onerror=alert(1)> API elevated errors'}]};
    await page.locator('#healthCheckButton').click();await page.waitForFunction(()=>document.getElementById('healthOfficial').textContent.includes('<img'));
    assert.equal(await page.locator('#healthOfficial img').count(),0);assert.equal(await page.locator('#healthCheckError').isHidden(),true);
    server.data.network.blocked=true;server.data.network.checking=false;
    await page.locator('#healthCheckButton').click();await page.waitForFunction(()=>document.getElementById('healthCheckButton').disabled&&document.getElementById('healthCheckButton').getAttribute('aria-busy')==='false');
    assert.match(await page.locator('#healthCheckTime').innerText(),lang==='en'?/timed out/:/超时/);
    await page.evaluate(()=>{const banner=document.getElementById('systemBanner');banner.hidden=false;banner.textContent='Connection retry '.repeat(40);window.dispatchEvent(new Event('resize'));});
    layouts.push({lang,width,state:'banner',...await geometry(page)});
    await context.close();
  }
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'qa.json'),JSON.stringify({passed:true,errors,layouts},null,2));
  console.log('PASS: bilingual 300/344 px pixel-heart badges with 13 px numbers, independent runtime alerts, anchored details, task list >=40 px, zero/100/unknown/stale, probe recovery, disclosure coordination, safe text and no task writes.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
