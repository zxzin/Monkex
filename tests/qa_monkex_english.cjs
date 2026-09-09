const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/qa-monkex-english');
fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
 const errors=[];const page=await browser.newPage({viewport:{width:344,height:420},locale:'en-US',deviceScaleFactor:2});
 page.on('pageerror',e=>errors.push(e.message));
 const now=Date.now()/1000;
 const week=require('../shell/read-play.js').localWeekStart(Date.now());
 const snapshot={observed_at:now,health:{app_server:'online',usage:{weekly:{available:true,remaining_percent:68,observed_at:now,resets_at:now+3600}}},coverage:{external_runtime:'local_events'},weekly_harvest:{count:12},threads:[
 {id:'demo-one',name:'Portfolio homepage',summary:'Responsive layout and project gallery ready',status:'idle',unread:true,updated_at:now-600,pending_result_version:'v1'},
 {id:'demo-two',name:'Release checklist',summary:'Installer notes and guide ready',status:'idle',unread:true,updated_at:now-1200,pending_result_version:'v2'},
 {id:'demo-three',name:'Analytics dashboard',summary:'Building trend charts and filters',status:'running',unread:false,updated_at:now,tokens:{ready:true,tokens_per_min:124800,last_report_at:now}},
 {id:'demo-four',name:'API regression tests',summary:'Success and invalid inputs covered',status:'idle',unread:false,updated_at:now-8000}
 ]};
 snapshot.weekly_harvest.week_start=week;
 let refreshes=0;
 await page.route('http://monkex.test/**',async route=>{
  const pathname=new URL(route.request().url()).pathname;
  if(pathname==='/api/events')return route.fulfill({status:200,contentType:'text/event-stream',body:'event: ready\ndata: {}\n\n'});
  if(pathname.startsWith('/api/')){if(pathname==='/api/refresh')refreshes++;return route.fulfill({json:snapshot});}
  const file=path.join(root,pathname==='/'?'shell/index.html':pathname);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:'Missing'});
  return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'image/png',body:fs.readFileSync(file)});
 });
 await page.goto('http://monkex.test/shell/index.html');
 await page.waitForURL('**/shell/en/index.html');
 await page.locator('.task-button').first().waitFor();
 assert.equal(await page.locator('html').getAttribute('lang'),'en');
 assert.match(await page.locator('#appShell').innerText(),/Weekly.*68%/s);
 assert.equal(await page.locator('.task-button').count(),3);
 assert.equal(await page.locator('#appShell').evaluate(e=>/\p{Script=Han}/u.test(e.innerText)),false);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 const gap=await page.evaluate(()=>{const a=document.getElementById('weeklyQuota').getBoundingClientRect(),b=document.getElementById('pinButton').getBoundingClientRect();return b.left-a.right;});
 assert.ok(gap>=0,'quota and pin do not overlap');
 await page.locator('#appShell').screenshot({path:path.join(out,'english-board.png')});
 await page.locator('#quotaCoinButton').click();assert.ok(refreshes>0);
 snapshot.error='任务同步暂时中断，保留上次观测结果';await page.locator('#quotaCoinButton').click();await page.locator('#systemBanner').getByText('Task sync interrupted. Keeping the last observation.').waitFor();delete snapshot.error;
 await page.locator('#quotaCoinButton').click();
 await page.locator('[data-filter=recent]').click();assert.equal(await page.locator('.task-button').count(),4);assert.match(await page.locator('#taskList').innerText(),/Read/);
 snapshot.threads[0].name='保留原始任务标题';
 await page.locator('#quotaCoinButton').click();await page.waitForFunction(()=>document.getElementById('taskList').innerText.includes('保留原始任务标题'));
 snapshot.threads[0].name='Portfolio homepage';
 await page.goto('http://monkex.test/shell/index.html?pet=1&lang=en');await page.waitForURL('**/en/index.html?pet=1&lang=en');
 await page.locator('#petShell').waitFor({state:'visible'});await page.locator('#petQuotaRemaining').getByText('68%').waitFor();
 await page.locator('#petShell').screenshot({path:path.join(out,'english-tree.png')});
 await page.locator('#petLauncher').click();await page.locator('#appShell').waitFor({state:'visible'});
 await page.locator('#pinButton').click();assert.equal(await page.locator('#pinButton').getAttribute('aria-pressed'),'true');
 await page.goto('http://monkex.test/shell/index.html?lang=zh');await page.locator('[data-filter=board]').getByText('看板').waitFor();
 assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({status:'passed',checks:['auto English','Chinese override','English quota and status','coin refresh','no overlap at 344px','original task text preserved','English tree tap','pin'],errors},null,2));
 await browser.close();console.log('PASS: English product routes, layout, quota refresh, task preservation, tree and pin.');
})().catch(e=>{console.error(e);process.exit(1)});
