// Render the actual bilingual shell with synthetic run evidence; no Codex access.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),out=path.join(root,'build/qa-monkex-frequent');
fs.mkdirSync(out,{recursive:true});
(async()=>{
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const errors=[],checks=[];
  try{
    for(const lang of ['zh','en'])for(const width of [344,300]){
      const page=await browser.newPage({viewport:{width,height:650},deviceScaleFactor:2,locale:lang==='zh'?'zh-CN':'en-US'});
      page.on('pageerror',error=>errors.push(error.message));
      const now=Date.now()/1000;
      const frequency=(count,extra={})=>({source:'codex_run',window_days:7,run_count:count,weighted_score:count*3,
        active_days:1,last_run_at:now-30,observed_at:now,available:true,complete:true,...extra});
      const task=(id,count,extra={})=>({id,name:id,summary:'Synthetic progress',project_label:id,cwd:'/synthetic/'+id,
        status:'result_ready',unread:false,updated_at:now,usage_frequency:frequency(count),...extra});
      const snapshot={observed_at:now,health:{app_server:'online',usage:{}},threads:[
        task('Frequent read',20),task('Unread result',2,{unread:true}),
        task('Running often',12,{status:'running'}),task('Partial history',8,{usage_frequency:frequency(8,{complete:false})}),
        task('One run',1),task('Legacy clicks',99,{usage_frequency:{source:'monkex_open',open_count:99}})
      ]};
      await page.route('http://monkex.test/**',route=>{
        const pathname=new URL(route.request().url()).pathname;
        if(pathname==='/api/events')return route.fulfill({contentType:'text/event-stream',body:'event: ready\ndata: {}\n\n'});
        if(pathname.startsWith('/api/'))return route.fulfill({json:snapshot});
        const file=path.resolve(root,'.'+pathname);
        if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:'Missing'});
        return route.fulfill({contentType:file.endsWith('.html')?'text/html':file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'image/png',body:fs.readFileSync(file)});
      });
      await page.goto(`http://monkex.test/shell/${lang==='en'?'en/':''}index.html?lang=${lang}`);
      await page.locator('.task-button').first().waitFor();
      await page.locator('[data-filter=frequent]').click();
      const names=await page.locator('.task-button .task-title').allTextContents();
      assert.equal(await page.locator('.task-button').count(),4);
      const rows=await page.locator('.task-button').allTextContents();
      assert.ok(rows[0].includes('Unread result'),'completed unread results lead regardless of frequency');
      assert.ok(rows[1].includes('Frequent read')&&rows[2].includes('Running often')&&rows[3].includes('Partial history'));
      assert.equal(await page.locator('.project-heading').count(),0,'frequent is a flat global list');
      assert.match(rows[3],lang==='zh'?/至少8次/:/At least 8 runs/);
      const title=await page.locator('.task-button').first().getAttribute('title');
      assert.match(title,lang==='zh'?/近7天独立运行 2 次/:/Distinct runs in 7 days: 2 runs/);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'compact shell fits viewport');
      await page.locator('#appShell').screenshot({path:path.join(out,`${lang}-${width}.png`)});
      await page.locator('[data-filter=recent]').focus();await page.keyboard.press('Enter');
      await page.locator('[data-filter=frequent]').focus();await page.keyboard.press('Enter');
      assert.equal(await page.locator('.task-button').count(),4,'keyboard tab switching preserves frequency');
      assert.deepEqual(snapshot.threads[0].usage_frequency.run_count,20,'viewing leaves run evidence unchanged');
      checks.push({lang,width,rows:rows.length,names});await page.close();
    }
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({status:'passed',checks,errors},null,2));
    console.log('PASS: bilingual run-frequency rows, lower bounds, unread priority, flat ranking, keyboard and 300/344px layout.');
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
