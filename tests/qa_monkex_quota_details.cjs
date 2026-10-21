// Browser acceptance against the shipped frontend and synthetic account data only.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/qa-monkex-quota-details');
fs.mkdirSync(out,{recursive:true});
const epoch=()=>Math.floor(Date.now()/1000);
function accountDetails(now=epoch()){
  return {observed_at:now,refresh_pending:false,
    credit_balance:{available:true,balance:'12345.6789000000',unlimited:false},
    reset_cards:{available:true,available_count:3,expirations:[{count:1,expires_at:now+86400},{count:1,expires_at:now+7*86400},{count:1,expires_at:null}],unlisted_count:0},
    windows:[{window_minutes:10080,remaining_percent:65,resets_at:now+3*86400},{window_minutes:300,remaining_percent:42,resets_at:now+3600}]};
}
function snapshot(details=accountDetails()){
  const now=epoch();
  return {observed_at:now,health:{app_server:'online',usage:{weekly:{available:true,remaining_percent:65,observed_at:now,resets_at:now+3*86400},details}},coverage:{external_runtime:'local_events'},weekly_harvest:{count:12,week_start:require('../shell/read-play.js').localWeekStart(Date.now())},threads:[
    {id:'demo-result',name:'Product launch page',summary:'Layout and accessibility checks complete',project_label:'Demo project',status:'idle',unread:true,updated_at:now-600,pending_result_version:'v1'},
    {id:'demo-running',name:'Build release package',summary:'Preparing the desktop bundle',project_label:'Demo project',status:'running',unread:false,updated_at:now,tokens:{ready:true,tokens_per_min:124800,last_report_at:now}},
    {id:'demo-read',name:'Regression checks',summary:'API response edge cases verified',project_label:'Demo project',status:'idle',unread:false,updated_at:now-8000},
  ]};
}
async function routeApp(page,server){
  await page.route('http://monkex.test/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    if(pathname==='/api/events')return route.fulfill({status:200,contentType:'text/event-stream',body:'event: ready\ndata: {}\n\n'});
    if(pathname.startsWith('/api/')){
      if(pathname==='/api/refresh'){
        server.refreshes++;
        if(server.pauseRefresh){server.pauseRefresh=false;await new Promise(resolve=>server.resumeRefresh=resolve);}
      }
      return route.fulfill({json:server.current});
    }
    const file=path.join(root,pathname==='/'?'shell/index.html':pathname);
    if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:'Missing'});
    return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'image/png',body:fs.readFileSync(file)});
  });
}
async function refresh(page){
  await page.locator('#quotaCoinButton').click();
  await page.waitForFunction(()=>document.getElementById('quotaCoinButton').getAttribute('aria-busy')!=='true');
}
async function visibleText(page,selector,expected){
  await page.waitForFunction(({selector,expected})=>document.querySelector(selector)?.textContent.trim()===expected,{selector,expected});
}
async function geometry(page){
  const result=await page.evaluate(()=>{
    const box=id=>{const r=document.getElementById(id).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    return {viewport:innerWidth,scroll:document.documentElement.scrollWidth,app:box('appShell'),quota:box('quotaDetails'),list:box('taskList'),coin:box('quotaCoinButton'),pin:box('pinButton')};
  });
  assert.ok(result.scroll<=result.viewport,`horizontal overflow: ${JSON.stringify(result)}`);
  assert.ok(result.app.right<=result.viewport+1,'board remains inside the viewport');
  assert.ok(result.quota.right<=result.app.right+1,'quota area remains inside board');
  assert.ok(result.list.height>=40,`task area remains usable: ${JSON.stringify(result)}`);
  assert.ok(result.coin.right<=result.pin.left,'coin and pin remain distinct');
  return result;
}
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:process.env.MONKEX_QA_CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const errors=[],checks=[],layouts=[];
  try{
    for(const lang of ['zh','en'])for(const width of [344,300]){
      const context=await browser.newContext({viewport:{width,height:420},locale:lang==='en'?'en-US':'zh-CN',timezoneId:'Asia/Shanghai',deviceScaleFactor:2});
      const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
      const server={current:snapshot(),refreshes:0};await routeApp(page,server);
      await page.goto(`http://monkex.test/shell/index.html?pet=1&expanded=1&lang=${lang}`);
      await page.locator('#quotaDetails').waitFor();
      await page.waitForFunction(()=>document.getElementById('creditBalanceValue').textContent.includes('12,345'));
      assert.match(await page.locator('#creditBalanceValue').innerText(),/^12,345\.68$/,'credit balance is a number, not an invented token allowance');
      assert.match(await page.locator('#resetCardCount').innerText(),/3/);
      const resetToggle=page.locator('#quotaResetToggle');
      assert.equal(await page.locator('#quotaResetWindows').isHidden(),true,'reset times start collapsed');
      assert.equal(await resetToggle.getAttribute('aria-expanded'),'false');
      const refreshesBeforeToggle=server.refreshes;
      await resetToggle.click();assert.equal(await page.locator('#quotaResetWindows').isVisible(),true);
      assert.equal(await resetToggle.getAttribute('aria-expanded'),'true');
      const resetText=await page.locator('#quotaResetWindows').innerText();
      assert.match(resetText,lang==='en'?/Weekly/i:/周/);assert.match(resetText,/5/);
      assert.equal(server.refreshes,refreshesBeforeToggle,'reset disclosure is independent of coin refresh');
      await resetToggle.click();assert.equal(await page.locator('#quotaResetWindows').isHidden(),true);
      assert.equal(await page.locator('#quotaDetails').evaluate(e=>/token/i.test(e.innerText)),false);
      if(lang==='en')assert.equal(await page.locator('#quotaDetails').evaluate(e=>/\p{Script=Han}/u.test(e.innerText)),false,'English quota strings are fully translated');
      layouts.push({lang,width,expanded:false,...await geometry(page)});
      await page.locator('#appShell').screenshot({path:path.join(out,`${lang}-${width}-board.png`)});
      const disclosure=page.locator('#resetCardDetails summary');
      await disclosure.click();
      await page.waitForFunction(()=>document.getElementById('resetCardDetails').open);
      assert.equal(await page.locator('#resetCardDetails').getAttribute('open'),'');
      assert.equal(await page.locator('#resetCardExpirations li').count(),3);
      assert.match(await page.locator('#resetCardExpirations').innerText(),lang==='en'?/No exp|Never exp/i:/无到期|不过期/);
      layouts.push({lang,width,expanded:true,...await geometry(page)});
      await page.locator('#appShell').screenshot({path:path.join(out,`${lang}-${width}-cards-open.png`)});
      const expandedBounds=await page.evaluate(()=>{
        const quota=document.getElementById('quotaDetails').getBoundingClientRect(),list=document.getElementById('resetCardExpirations').getBoundingClientRect();
        const styles=getComputedStyle(document.getElementById('resetCardExpirations'));
        return {quotaWidth:quota.width,listWidth:list.width,display:styles.display,columns:styles.gridTemplateColumns.split(' ').length};
      });
      assert.ok(expandedBounds.listWidth>=expandedBounds.quotaWidth-40,'expiry disclosure spans both summary columns');
      assert.equal(expandedBounds.display,'grid');assert.equal(expandedBounds.columns,3,'three expiry tiles remain in one compact row');
      await disclosure.click();await page.waitForFunction(()=>!document.getElementById('resetCardDetails').open);
      await disclosure.focus();await disclosure.press('Enter');await page.waitForFunction(()=>document.getElementById('resetCardDetails').open);
      assert.equal(await disclosure.evaluate(e=>document.activeElement===e),true,'keyboard expansion retains focus');
      await disclosure.press('Space');await page.waitForFunction(()=>!document.getElementById('resetCardDetails').open);
      assert.equal(await disclosure.evaluate(e=>document.activeElement===e),true,'keyboard disclosure retains focus');
      const crowded=snapshot();
      crowded.threads=Array.from({length:9},(_,index)=>({...crowded.threads[index%2],id:`demo-crowded-${index}`,name:`Task ${index+1}`,updated_at:epoch()-index*60}));
      server.current=crowded;await refresh(page);
      layouts.push({lang,width,expanded:false,crowded:true,...await geometry(page)});
      await disclosure.click();
      layouts.push({lang,width,expanded:true,crowded:true,...await geometry(page)});
      await disclosure.click();
      const many=accountDetails();many.reset_cards={available:true,available_count:30,expirations:Array.from({length:30},(_,index)=>({count:1,expires_at:epoch()+(index+1)*86400})),unlisted_count:0};
      server.current={...crowded,health:{...crowded.health,usage:{...crowded.health.usage,details:many}}};await refresh(page);await disclosure.click();
      assert.equal(await page.locator('#resetCardExpirations li').count(),30);
      const scrollbox=await page.locator('#resetCardExpirations').evaluate(e=>({client:e.clientHeight,scroll:e.scrollHeight,overflow:getComputedStyle(e).overflowY}));
      assert.ok(scrollbox.client<=104,'many expiries retain a bounded disclosure height');
      assert.ok(scrollbox.scroll>scrollbox.client&&['auto','scroll'].includes(scrollbox.overflow),'all expiry rows remain accessible through internal scrolling');
      layouts.push({lang,width,expanded:true,crowded:true,manyExpirations:true,...await geometry(page)});
      await page.locator('#appShell').screenshot({path:path.join(out,`${lang}-${width}-many-cards.png`)});
      await page.locator('#resetCardExpirations').evaluate(e=>{e.scrollTop=e.scrollHeight;});
      assert.ok(await page.locator('#resetCardExpirations').evaluate(e=>e.scrollTop>0),'expiry history scrolls without growing the native window');
      await disclosure.click();
      const zero=accountDetails();zero.credit_balance.balance='0';zero.reset_cards={available:true,available_count:0,expirations:[],unlisted_count:0};
      server.current=snapshot(zero);await refresh(page);await visibleText(page,'#creditBalanceValue','0');
      assert.match(await page.locator('#resetCardCount').innerText(),/0/,'zero cards is distinct from unknown');
      const unlimited=accountDetails();unlimited.credit_balance={available:true,balance:null,unlimited:true};
      server.current=snapshot(unlimited);await refresh(page);
      assert.match(await page.locator('#creditBalanceValue').innerText(),lang==='en'?/Unlimited|∞/i:/不限|无限|∞/);
      const capped=accountDetails();capped.reset_cards={available:true,available_count:5,expirations:[{count:2,expires_at:epoch()+86400}],unlisted_count:3};
      server.current=snapshot(capped);await refresh(page);await page.locator('#resetCardDetails summary').click();
      assert.match(await page.locator('#resetCardCount').innerText(),/5/);
      const cappedText=await page.locator('#resetCardExpirations').innerText();
      assert.match(cappedText,/3/);assert.match(cappedText,lang==='en'?/sync|pending/i:/同步/);
      await page.locator('#resetCardDetails summary').click();
      const stale=accountDetails(epoch()-91);server.current=snapshot(stale);await refresh(page);await visibleText(page,'#creditBalanceValue','—');
      assert.match(await page.locator('#resetCardCount').innerText(),/—/);
      const pending=accountDetails();pending.refresh_pending=true;server.current=snapshot(pending);await refresh(page);
      assert.match(await page.locator('#creditBalanceValue').innerText(),/12,345/);
      assert.match(await page.locator('#quotaDetailsStatus').innerText(),lang==='en'?/retry|sync|last/i:/同步|重试/);
      server.current=snapshot();await refresh(page);
      await resetToggle.click();assert.equal(await page.locator('#quotaResetWindows').isVisible(),true);
      server.pauseRefresh=true;await page.locator('#quotaCoinButton').click();
      await visibleText(page,'#creditBalanceValue','—');
      assert.match(await page.locator('#resetCardCount').innerText(),/—/,'full refresh clears previous account cards while request is pending');
      const next=accountDetails();next.credit_balance.balance='128';next.reset_cards={available:false,available_count:null,expirations:[],unlisted_count:0};
      server.current=snapshot(next);server.resumeRefresh();await visibleText(page,'#creditBalanceValue','128');
      assert.match(await page.locator('#resetCardCount').innerText(),/—/,'new account missing fields do not retain prior values');
      assert.equal(await page.locator('#quotaResetWindows').isVisible(),true,'manual refresh preserves expanded reset times');
      assert.equal(await resetToggle.getAttribute('aria-expanded'),'true');await resetToggle.click();
      server.current=snapshot(null);await refresh(page);await visibleText(page,'#creditBalanceValue','—');
      assert.match(await page.locator('#resetCardCount').innerText(),/—/);
      checks.push(`${lang} ${width}px: balance, zero, unlimited, unknown, stale, cached retry, default-collapsed week/5h reset, independent reset toggle and coin, preserved disclosure view, full-width expiry disclosure, keyboard Enter/Space, bounded30cardlist, crowded task room, capped list, forced account refresh`);
      await context.close();
    }
    assert.deepEqual(errors,[]);
    const beforeFile=path.join(out,'layout-before.json');
    const before=fs.existsSync(beforeFile)?JSON.parse(fs.readFileSync(beforeFile,'utf8')).layouts:[];
    const comparisons=layouts.filter(item=>!item.crowded).map(after=>{
      const prior=before.find(item=>item.lang===after.lang&&item.width===after.width&&item.expanded===after.expanded&&!item.crowded);
      return prior?{lang:after.lang,width:after.width,expanded:after.expanded,quotaBefore:prior.quota.height,quotaAfter:after.quota.height,quotaSaved:prior.quota.height-after.quota.height,tasksBefore:prior.list.height,tasksAfter:after.list.height}:null;
    }).filter(Boolean);
    const crowdedFile=path.join(out,'layout-before-crowded.json');
    const crowdedBefore=fs.existsSync(crowdedFile)?JSON.parse(fs.readFileSync(crowdedFile,'utf8')).layouts:[];
    const crowdedComparisons=layouts.filter(item=>item.crowded&&!item.manyExpirations).map(after=>{
      const prior=crowdedBefore.find(item=>item.lang===after.lang&&item.width===after.width&&item.expanded===after.expanded);
      return prior?{lang:after.lang,width:after.width,expanded:after.expanded,quotaBefore:prior.quotaDetails,quotaAfter:after.quota.height,quotaSaved:prior.quotaDetails-after.quota.height,tasksBefore:prior.taskList,tasksAfter:after.list.height,tasksGained:after.list.height-prior.taskList}:null;
    }).filter(Boolean);
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({status:'passed',checks,layouts,comparisons,crowdedComparisons,errors},null,2));
    console.log('PASS: quota details browser acceptance in Chinese/English at 344px and 300px.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
