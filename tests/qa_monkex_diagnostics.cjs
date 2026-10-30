// Synthetic browser acceptance: compact display, disclosure, error recovery and no task writes.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/qa-monkex-diagnostics');
fs.mkdirSync(out,{recursive:true});
const epoch=()=>Math.floor(Date.now()/1000);
const tiers=[
  {min:95,max:100,key:'excellent',zh:'极佳',en:'Prime'},
  {min:85,max:94,key:'smooth',zh:'流畅',en:'Smooth'},
  {min:70,max:84,key:'steady',zh:'平稳',en:'Steady'},
  {min:60,max:69,key:'mixed',zh:'波动',en:'Mixed'},
  {min:0,max:59,key:'poor',zh:'不稳',en:'Poor'}
];
const spritePath='/shell/assets/monkex-health-2026-10-30/clever-monkey-expressions.png';
const facePositions={excellent:'6.4% 9.1%',smooth:'49.9% 9.1%',steady:'93.4% 9.2%',mixed:'6.4% 84.5%',poor:'49.9% 84.5%',unknown:'93.4% 84.4%'};
const verifiedSpritePages=new WeakSet();
async function verifySpritePixels(page){
  if(verifiedSpritePages.has(page))return;
  const sprite=await page.evaluate(async source=>{
    const image=new Image();
    await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('Monkey expression sprite failed to load'));image.src=source;});
    const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(image,0,0);
    const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
    const width=canvas.width/3,height=canvas.height/2,frames=[];
    for(let row=0;row<2;row++)for(let column=0;column<3;column++){
      let black=0,white=0,opaque=0,hash=2166136261;
      for(let y=row*height;y<(row+1)*height;y++)for(let x=column*width;x<(column+1)*width;x++){
        const offset=(y*canvas.width+x)*4,luminance=Math.round(.2126*pixels[offset]+.7152*pixels[offset+1]+.0722*pixels[offset+2]);
        if(luminance<16)black++;if(luminance>220)white++;if(pixels[offset+3]===255)opaque++;
        hash=Math.imul(hash^luminance,16777619)>>>0;
      }
      frames.push({black,white,opaque,hash});
    }
    return {width:canvas.width,height:canvas.height,frames};
  },spritePath);
  assert.deepEqual([sprite.width,sprite.height],[1536,1024],'the approved image is a three-column, two-row square-cell sprite');
  assert.equal(sprite.frames.length,6);
  assert.ok(sprite.frames.every(frame=>frame.black>0&&frame.white>0&&frame.opaque===512*512),'every expression has real white line work and an opaque black background: '+JSON.stringify(sprite.frames));
  assert.equal(new Set(sprite.frames.map(frame=>frame.hash)).size,6,'the six expression cells contain distinct luminance silhouettes');
  verifiedSpritePages.add(page);
}
async function tierReading(page,value,lang,pending){
  const tier=value===null?null:tiers.find(item=>Math.round(value)>=item.min&&Math.round(value)<=item.max);
  const expression=tier?tier.key:'unknown';
  assert.equal(await page.locator('#healthFace').getAttribute('data-expression'),expression,'the face matches the visible rounded score');
  const face=await page.locator('#healthFace').evaluate(element=>{
    const style=getComputedStyle(element);return {tag:element.tagName,children:element.childElementCount,hidden:element.getAttribute('aria-hidden'),
      image:style.maskImage,webkitImage:style.webkitMaskImage,size:style.maskSize,repeat:style.maskRepeat,mode:style.maskMode,
      position:style.maskPosition.replace(/\b0px\b/g,'0%'),background:style.backgroundColor,color:style.color};
  });
  assert.equal(face.tag,'SPAN');assert.equal(face.children,0);assert.equal(face.hidden,'true');
  assert.equal(await page.locator('#runtimeHealthToggle svg,#runtimeHealthToggle [data-face]').count(),0,'the selected image is rendered without an added outline SVG');
  assert.ok(face.image.includes(spritePath)&&face.webkitImage.includes(spritePath),'the standard and WebKit masks use the approved image asset: '+JSON.stringify(face));
  assert.equal(face.size,'360% 240%');assert.equal(face.repeat,'no-repeat');assert.equal(face.mode,'luminance');
  assert.equal(face.position,facePositions[expression],'exactly the selected image cell fills the health face');
  assert.equal(face.background,face.color,'the image luminance mask inherits the connection semantic color');
  await verifySpritePixels(page);
  assert.equal(await page.locator('#healthBadgeTier').innerText(),tier?tier[lang]:pending);
  assert.equal(await page.locator('#healthTierRange').innerText(),tier?tier.min+'–'+tier.max+(lang==='en'?' points':' 分'):'');
  assert.deepEqual(await page.locator('#healthTierScale>li').evaluateAll(rows=>rows.map(row=>row.dataset.tier)),tiers.map(item=>item.key));
  assert.deepEqual(await page.locator('#healthTierScale>[aria-current="true"]').evaluateAll(rows=>rows.map(row=>row.dataset.tier)),tier?[tier.key]:[]);
  if(lang==='en')assert.doesNotMatch(await page.locator('#runtimeHealth').textContent(),/[\u3400-\u9fff]/,'English health details contain no untranslated Chinese');
}
function diagnostics(){const now=epoch();return {observed_at:now,data_state:'current',running_tasks:5,
  score:{value:86,grade:'good',confidence:'short_check',sample_count:18,round_count:6,success_percent:100,p50_ms:420,p95_ms:900,jitter_ms:480,components:{reliability:60,latency:19,stability:7},notes:['public_path_only','short_check_only'],scope:'public_path',codex_observed:true},
  operational:{state:'quiet',level:'notice',code:'quiet',affected_tasks:4,active_tasks:1,quiet_tasks:4,unknown_tasks:0,tool_tasks:1,starting_tasks:3,issue_tasks:0,evidence:['recent_runtime_activity','runtime_quiet','tool_pending'],score_scope:'public_path'},
  activity:{state:'quiet',last_activity_at:now-4,quiet_tasks:4,total_tokens_per_min:12800,output_tokens_per_min:420},
  tasks:[{id:'demo-a',name:'Prepare launch assets',phase:'response',activity_age_seconds:4,signal:'active',output_tokens_per_min:420,report_age_seconds:8},...Array.from({length:4},(_,i)=>({id:'demo-quiet-'+i,name:i===0?'Run regression checks':'Waiting for first response '+i,phase:i===0?'tool':'starting',pending_tools:i===0?1:0,activity_age_seconds:240,signal:'quiet',output_tokens_per_min:0,report_age_seconds:240}))],
  network:{checked_at:now,route:'system_proxy',exit:{state:'observed',country_code:'JP',edge_code:'NRT',checked_at:now},rounds_completed:6,rounds_planned:6,checks:[{id:'general',state:'reachable',latency_ms:43,median_ms:44},{id:'codex',state:'reachable',latency_ms:420,median_ms:450},{id:'api',state:'reachable',latency_ms:400},{id:'auth',state:'reachable',latency_ms:390}]},
  official:{state:'operational',checked_at:now,components:[{name:'Codex',status:'operational'}],incidents:[]},assessment:{level:'notice',code:'quiet'}};}
function feed(){const now=epoch();return {observed_at:now,health:{app_server:'online',usage:{weekly:{available:true,remaining_percent:65,observed_at:now,resets_at:now+86400},details:{observed_at:now,credit_balance:{available:true,balance:'12345.67'},reset_cards:{available:true,available_count:3,expirations:[{count:3,expires_at:now+86400}]},windows:[{window_minutes:10080,resets_at:now+86400}]}}},threads:[
  {id:'demo-a',name:'Prepare launch assets',summary:'Editing visual examples',project_label:'Demo project',status:'running',updated_at:now,runtime:{phase:'response',activity_at:now-4,pending_tools:0,observation_available:true},tokens:{ready:true,tokens_per_min:12800,last_report_at:now-4}},
  {id:'demo-b',name:'Run regression checks',summary:'Waiting for tool response',project_label:'Demo project',status:'running',updated_at:now,runtime:{phase:'tool',activity_at:now-240,pending_tools:1,observation_available:true},tokens:{ready:true,tokens_per_min:0,last_report_at:now-240}},
  {id:'demo-c',name:'Publish notes',summary:'Release notes ready for review',project_label:'Demo project',status:'idle',unread:true,updated_at:now-500}
]};}
async function geometry(page){
  const g=await page.evaluate(()=>{const box=element=>{const r=(typeof element==='string'?document.getElementById(element):element).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,width:r.width,height:r.height,bottom:r.bottom};};return {width:innerWidth,overflow:document.documentElement.scrollWidth,app:box('appShell'),health:box('runtimeHealth'),body:box('runtimeHealthBody'),list:box('taskList'),badge:box('runtimeHealthToggle'),face:box('healthFace'),reading:box(document.querySelector('.health-reading')),number:box('healthBadgeValue'),numberFont:getComputedStyle(document.getElementById('healthBadgeValue')).fontSize,alert:box('healthRuntimeAlert'),caption:box(document.querySelector('.health-caption')),captionFont:getComputedStyle(document.querySelector('.health-caption')).fontSize,captionOverflow:document.getElementById('healthBadgeTier').scrollWidth,scale:box('healthTierScale'),scaleSteps:[...document.querySelectorAll('#healthTierScale>li')].map(row=>({...box(row),overflow:row.scrollWidth,label:row.textContent})),quota:box('weeklyQuota'),coin:box('quotaCoinButton'),pin:box('pinButton'),title:box('viewHeading'),anchor:Number.parseFloat(document.getElementById('runtimeHealth').style.getPropertyValue('--health-anchor-x'))};});
  assert.ok(g.overflow<=g.width&&g.list.height>=40&&g.app.bottom<=421,JSON.stringify(g));
  const overlaps=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
  assert.ok(!overlaps(g.badge,g.coin)&&!overlaps(g.badge,g.pin)&&!overlaps(g.coin,g.pin),JSON.stringify(g));
  assert.ok(g.title.right<=g.badge.left&&g.badge.right<=g.quota.left&&g.title.width>=45,'brand, health and quota stay in order: '+JSON.stringify(g));
  const narrow=g.width<=320,faceSize=narrow?18:20;
  assert.ok(Math.abs(g.badge.width-(narrow?42:44))<=1&&Math.abs(g.badge.height-(narrow?30:32))<=1,'the selected monkey badge leaves room for three score digits: '+JSON.stringify(g));
  assert.ok(Math.abs(g.face.width-faceSize)<=1&&Math.abs(g.face.height-faceSize)<=1,'the selected image face stays compact: '+JSON.stringify(g));
  assert.ok(g.face.right<=g.reading.left&&g.number.left>=g.badge.left&&g.number.right<=g.badge.right,'face and number have distinct readable space: '+JSON.stringify(g));
  assert.ok(Math.abs(g.face.top+g.face.height/2-g.reading.top-g.reading.height/2)<=1,'the face and numeric reading align vertically: '+JSON.stringify(g));
  assert.equal(g.numberFont,'13px','the numeric reading uses the smaller selected type size, including 100');assert.equal(g.captionFont,'8px');
  if(g.alert.width)assert.ok(!overlaps(g.alert,g.number)&&!overlaps(g.alert,g.face),'the independent task marker stays clear of the score and face: '+JSON.stringify(g));
  assert.ok(g.caption.left>=g.badge.left&&g.caption.right<=g.badge.right&&g.caption.bottom<=g.badge.bottom&&g.captionOverflow<=Math.ceil(g.caption.width),'the connection tier fits its control');
  assert.ok(!overlaps(g.caption,g.number)&&!overlaps(g.caption,g.face),'the full-width tier label has its own row below the face and number');
  if(g.health.height){assert.ok(g.health.left>=0&&g.health.right<=g.width&&g.health.bottom<=g.app.bottom,JSON.stringify(g));assert.ok(Math.abs(g.health.top-g.badge.bottom-10)<=2,'popover starts below its badge');assert.ok(Math.abs(g.health.left+g.anchor-(g.badge.left+g.badge.width/2))<=2,'arrow points to the badge');assert.ok(g.scale.left>=g.body.left&&g.scale.right<=g.body.right,'the five-band scale stays within the disclosure');assert.ok(g.scaleSteps.every(row=>row.left>=g.scale.left&&row.right<=g.scale.right&&row.overflow<=Math.ceil(row.width)),'all translated scale labels and score ranges fit their cells: '+JSON.stringify(g.scaleSteps));}
  return g;
}
async function exitGeometry(page){
  const geometry=await page.locator('.health-exit').evaluate(section=>{
    const box=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,height:r.height,overflow:element.scrollWidth};};
    return {section:box(section),label:box(section.querySelector('span')),value:box(section.querySelector('#healthExitRegion'))};
  });
  assert.ok(geometry.section.overflow<=Math.ceil(geometry.section.width),'the observed exit stays within its row: '+JSON.stringify(geometry));
  assert.ok(geometry.label.right<=geometry.value.left&&geometry.value.right<=geometry.section.right+1,'exit label and region occupy separate readable spaces');assert.ok(geometry.value.overflow<=Math.ceil(geometry.value.width),'translated exit regions fit the available width');return geometry;
}
async function exitMetadataCleared(page){
  assert.doesNotMatch(await page.locator('#healthExitRegion').textContent(),/日本|Japan|\bJP\b/,'stale, failed and resetting observations clear the previous exit region');
  assert.equal(await page.locator('#healthExitRegion').getAttribute('title'),'');
}
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.MONKEX_QA_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),errors=[],layouts=[];
  try{for(const lang of ['zh','en'])for(const width of [344,300]){
    const context=await browser.newContext({viewport:{width,height:420},locale:lang==='en'?'en-US':'zh-CN',deviceScaleFactor:2,reducedMotion:'reduce'});const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    const server={data:diagnostics(),feed:feed(),checks:0,writes:[],fail:false};
    await page.route('http://monkex.test/**',async route=>{
      const req=route.request(),pathname=new URL(req.url()).pathname;
      if(pathname==='/api/events')return route.fulfill({status:200,contentType:'text/event-stream',body:'event: ready\ndata: {}\n\n'});
      if(pathname.startsWith('/api/diagnostics')){if(req.method()==='POST'){server.checks++;assert.deepEqual(req.postDataJSON(),{reset:true},'current-node retest starts a fresh sample session');if(server.hold)await new Promise(resolve=>{server.release=resolve;});}if(server.fail)return route.fulfill({status:503,json:{error:'Unavailable'}});return route.fulfill({json:server.data});}
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
    await tierReading(page,86,lang);assert.equal(await page.locator('#runtimeHealthToggle #healthBadgeValue').count(),1);assert.equal(await page.locator('#runtimeHealth #healthScoreValue').count(),1);
    assert.equal(await page.locator('.health-heart,.health-ring,#healthStatusSymbol').count(),0);
    layouts.push({lang,width,state:'collapsed',...await geometry(page)});
    await page.screenshot({path:path.join(out,`${lang}-${width}-collapsed.png`)});
    await page.locator('#runtimeHealthToggle').click();
    await page.locator('#runtimeHealth').waitFor({state:'visible'});
    assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('aria-expanded'),'true');
    await page.waitForFunction(()=>document.getElementById('taskList').getBoundingClientRect().height>=40);
    const initialScoreVisible=await page.locator('#healthScoreValue').evaluate(score=>{const bounds=score.getBoundingClientRect(),body=document.getElementById('runtimeHealthBody').getBoundingClientRect(),exit=document.querySelector('.health-exit').getBoundingClientRect();return bounds.top>=body.top&&bounds.bottom<=body.bottom&&bounds.right<=body.right&&bounds.bottom<=exit.top&&score.contains(document.elementFromPoint(bounds.left+bounds.width/2,bounds.top+bounds.height/2));});
    assert.equal(initialScoreVisible,true,'the full public score remains visible above the observed exit immediately after expansion');
    layouts.push({lang,width,state:'expanded',initialScoreVisible,exit:await exitGeometry(page),...await geometry(page)});
    assert.equal(await page.locator('#healthExitRegion').innerText(),lang==='en'?'Japan · JP':'日本 · JP');assert.match(await page.locator('#healthExitRegion').getAttribute('title'),/NRT/);assert.match(await page.locator('#healthExitInfo').getAttribute('title'),lang==='en'?/probe.*Codex/i:/检测.*Codex/);
    await page.screenshot({path:path.join(out,`${lang}-${width}-expanded.png`)});
    await page.keyboard.press('Escape');assert.equal(await page.locator('#runtimeHealth').isHidden(),true);
    await page.keyboard.press('Enter');assert.equal(await page.locator('#runtimeHealth').isVisible(),true);
    await page.locator('#healthCloseButton').click();assert.equal(await page.locator('#runtimeHealth').isHidden(),true);
    await page.locator('#runtimeHealthToggle').click();
    await page.locator('#healthCheckButton').click();
    await page.waitForFunction(()=>!document.getElementById('healthCheckButton').disabled);
    assert.equal(server.checks,1);assert.deepEqual(server.writes,[],'health controls do not mark tasks read or refresh their state');
    const updateExit=async()=>{await page.locator('#healthCheckButton').click();await page.waitForFunction(()=>!document.getElementById('healthCheckButton').disabled);await exitGeometry(page);};
    for(const mode of ['network_stale','old_timestamp','feed_stale','exit_stale','exit_unknown','missing']){
      server.data=diagnostics();
      if(mode==='network_stale')server.data.network.stale=true;
      if(mode==='old_timestamp')server.data.network.exit.checked_at=epoch()-301;
      if(mode==='feed_stale')server.data.data_state='stale';
      if(mode==='exit_stale')server.data.network.exit.state='stale';
      if(mode==='exit_unknown')server.data.network.exit.state='unknown';
      if(mode==='missing')delete server.data.network.exit;
      await updateExit();await exitMetadataCleared(page);
    }
    for(const country of ['<img src=x onerror=alert(1)>','JP\n','\u202eJP','jp']){
      server.data=diagnostics();server.data.network.exit.country_code=country;server.data.network.exit.edge_code='<svg onload=alert(1)>';await updateExit();assert.equal(await page.locator('.health-exit img,.health-exit svg').count(),0);assert.doesNotMatch(await page.locator('#healthExitRegion').textContent(),/<|>|JP|日本|Japan|\u202e|\n/);assert.equal(await page.locator('#healthExitRegion').getAttribute('title'),'');
    }
    server.data=diagnostics();await updateExit();if(lang==='en')assert.doesNotMatch(await page.locator('.health-exit').textContent(),/[\u3400-\u9fff]/);
    await page.locator('#healthTaskSummary').click();
    assert.equal(await page.locator('.health-task').count(),5);assert.match(await page.locator('#healthTaskList').innerText(),lang==='en'?/4 min ago/:/4 分钟前/);
    await page.locator('#quotaResetToggle').click();assert.equal(await page.locator('#runtimeHealth').isHidden(),true,'quota disclosure closes health');
    assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('aria-expanded'),'false');
    await page.locator('#runtimeHealthToggle').click();await page.locator('#quotaResetWindows').waitFor({state:'hidden'});
    await page.locator('#greetMonkey').click();await page.locator('#runtimeHealth').waitFor({state:'hidden'});
    await page.locator('#resetCardDetails>summary').click();
    assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('aria-expanded'),'false');
    await page.locator('#runtimeHealthToggle').click();await page.waitForFunction(()=>!document.getElementById('resetCardDetails').open);
    for(const [value,grade,scoreLevel]of [...[0,59,60,69,70,84,85,94,95,100,94.6].map(value=>[value,value>=85?'good':value>=60?'fair':'poor',value>=85?'ok':value>=60?'notice':'warning']),[null,'collecting','unknown'],[86,'stale','unknown']]){
      server.data.score={...server.data.score,value,grade};await page.locator('#healthCheckButton').click();
      await page.waitForFunction(()=>!document.getElementById('healthCheckButton').disabled);
      const expected=value===null||grade==='stale'?'—':Math.round(value)+' /100';await page.waitForFunction(expected=>document.getElementById('healthScoreValue').textContent===expected,expected);
      assert.equal(await page.locator('#healthBadgeValue').innerText(),expected==='—'?'—':String(Math.round(value)));assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('data-score-level'),scoreLevel);
      await tierReading(page,expected==='—'?null:value,lang,grade==='stale'?(lang==='en'?'Retest':'重测'):(lang==='en'?'Sampling':'采样中'));
      assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('data-level'),'notice','network quality and sampling state do not override quiet tasks');assert.equal(await page.locator('#healthRuntimeAlert').isVisible(),true);assert.equal(await page.locator('#healthRuntimeAlert').getAttribute('data-level'),'notice');
      assert.ok((await page.locator('#runtimeHealthToggle').getAttribute('aria-label')).includes(expected));await geometry(page);
      if(value===100)await page.screenshot({path:path.join(out,`${lang}-${width}-score-100.png`)});
      if([0,60,70,85,95,null].includes(value)||grade==='stale'){
        const expression=await page.locator('#healthFace').getAttribute('data-expression');
        await page.locator('header').screenshot({path:path.join(out,`${lang}-${width}-face-${expression}-${grade}.png`)});
      }
    }
    server.data=diagnostics();server.hold=true;
    await page.locator('#healthCheckButton').click();await page.waitForFunction(()=>document.getElementById('healthBadgeValue').textContent==='—');
    await tierReading(page,null,lang,lang==='en'?'Sampling':'采样中');await geometry(page);
    await exitMetadataCleared(page);
    assert.equal(await page.locator('#healthTierName').innerText(),lang==='en'?'Awaiting score':'等待评分');
    server.hold=false;server.release();await page.waitForFunction(()=>!document.getElementById('healthCheckButton').disabled);await tierReading(page,86,lang);
    for(const [status,level,code,showAlert,renderedLevel]of [['active','ok','active',false,'ok'],['tool_running','ok','tool_running',false,'ok'],['tool_running','notice','tool_wait',true,'notice'],['waiting','notice','awaiting_response',true,'notice'],['unknown','unknown','activity_unconfirmed',true,'unknown'],['error','error','recent_connection_error',true,'warning'],['idle','ok','idle',false,'unknown']]){
      server.data=diagnostics();server.data.score.value=100;server.data.operational={...server.data.operational,state:status,level,code};await page.locator('#healthCheckButton').click();
      await page.waitForFunction(()=>!document.getElementById('healthCheckButton').disabled);assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('data-level'),renderedLevel);assert.equal(await page.locator('#healthScoreValue').innerText(),'100 /100');
      assert.equal(await page.locator('#healthBadgeValue').innerText(),'100');assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('data-score-level'),'ok');assert.equal(await page.locator('#healthRuntimeAlert').isVisible(),showAlert);assert.equal(await page.locator('#healthRuntimeAlert').getAttribute('data-level'),renderedLevel);
      const accessibleName=await page.locator('#runtimeHealthToggle').getAttribute('aria-label');assert.match(accessibleName,/100 \/100/);assert.ok(accessibleName.includes(await page.locator('#healthSummary').innerText()),'the accessible name independently describes runtime status');assert.doesNotMatch(accessibleName,/Short check|短测完成/);await geometry(page);
      await tierReading(page,100,lang);
    }
    server.data=diagnostics();server.data.score={...server.data.score,value:100,notes:['official_codex_outage']};server.data.operational={...server.data.operational,state:'error',level:'error',code:'recent_connection_error'};server.data.official={state:'degraded',checked_at:epoch(),components:[{name:'Codex',status:'major_outage'}],incidents:[]};
    await page.locator('#healthCheckButton').click();await page.waitForFunction(()=>!document.getElementById('healthCheckButton').disabled);await tierReading(page,100,lang);
    assert.equal(await page.locator('#healthRuntimeAlert').isVisible(),true);assert.equal(await page.locator('#runtimeHealthToggle').getAttribute('data-level'),'warning');
    assert.match(await page.locator('#healthScoreReason').innerText(),lang==='en'?/^Official status reports a Codex outage\./:/^官方报告 Codex 服务中断。/,'the official warning precedes the high-score interpretation');
    assert.match(await page.locator('#healthOfficialComponents').innerText(),lang==='en'?/outage/i:/服务中断/);
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
    await tierReading(page,null,lang,lang==='en'?'Sampling':'采样中');
    server.data=diagnostics();
    server.data.activity.output_tokens_per_min=0;server.data.activity.quiet_tasks=0;server.data.assessment={level:'notice',code:'waiting'};
    await page.locator('#healthCheckButton').click();await page.waitForFunction(()=>document.getElementById('healthOutputRate').textContent==='0');
    server.data.activity.output_tokens_per_min=null;await page.locator('#healthCheckButton').click();await page.waitForFunction(()=>document.getElementById('healthOutputRate').textContent==='—');
    server.fail=true;await page.locator('#healthCheckButton').click();await page.locator('#healthCheckError').waitFor({state:'visible'});
    assert.equal(await page.locator('#runtimeHealth').getAttribute('data-level'),'unknown');assert.equal(await page.locator('#healthBadgeValue').innerText(),'—');assert.equal(await page.locator('#healthRuntimeAlert').isVisible(),true);
    await tierReading(page,null,lang,lang==='en'?'Syncing':'同步中');await geometry(page);
    await exitMetadataCleared(page);
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
  console.log('PASS: bilingual 300/344 px approved luminance-mask sprite, six measured expression positions, unknown/recovery states, observed-exit row and freshness; five-band captions, rounded boundaries, 13 px numbers, independent runtime/official warnings and no task writes.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
