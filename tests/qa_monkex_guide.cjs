const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const english=process.env.MONKEX_GUIDE_LANG==='en';
const root=path.join(__dirname,'..'),out=path.join(root,english?'build/qa-monkex-guide-en':'build/qa-monkex-guide');
fs.mkdirSync(out,{recursive:true});
(async()=>{
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
page.on('pageerror',e=>errors.push(e.message));
const external=[];page.on('request',r=>{if(/^https?:/.test(r.url()))external.push(r.url());});
const guideDir=fs.existsSync(path.join(root,'docs/guide.html'))?'docs':'releases/Monkex/docs';
await page.goto(pathToFileURL(path.join(root,guideDir,english?'guide.en.html':'guide.html')).href);
await page.waitForFunction(()=>document.querySelector('h1'));
const routes=['overview','tree','states','board','harvest','quota','pin','design','install','privacy','faq'];
async function go(route){await page.locator(`.nav a[href="#${route}"]`).click();await page.waitForFunction(r=>location.hash==='#'+r,route);}
for(const viewport of [{width:1366,height:768},{width:1440,height:900},{width:1920,height:1080},{width:390,height:844}]){
 await page.setViewportSize(viewport);
 for(const route of routes){await go(route);await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`no horizontal overflow ${route} ${viewport.width}`);assert.equal(await page.locator('img').evaluateAll(imgs=>imgs.every(img=>img.complete&&img.naturalWidth>0)),true,`assets ${route}`);
 if(english)assert.equal(await page.evaluate(()=>/\p{Script=Han}/u.test(document.body.innerText+Array.from(document.querySelectorAll('[aria-label],[title]')).map(e=>(e.title||'')+(e.getAttribute('aria-label')||'')).join(''))),false,`English content ${route}`);
 if(viewport.width===1440||viewport.width===390)await page.screenshot({path:path.join(out,`${viewport.width}-${route}.png`),fullPage:true});}
}
await page.setViewportSize({width:1440,height:900});
await go('overview');
const phases=[];
for(const phase of [.22,.40,.48,.81,.90]){
 const frame=await page.locator('.tree-unit').evaluate((tree,phase)=>{
  const animations=tree.getAnimations({subtree:true});
  animations.forEach(a=>{a.pause();a.currentTime=phase*9000;});
  const style=s=>getComputedStyle(tree.querySelector(s));
  return {monkey:style('.tree-companion').transform,pose:style('.tree-monkey-sprite').backgroundPosition,canopy:style('.tree-canopy').transform,fruit:style('.tree-harvest').transform,atlas:style('.tree-monkey-sprite').backgroundImage,cycles:animations.filter(a=>['branch-peek','branch-pose','branch-load','harvest-settle'].includes(a.animationName)).map(a=>a.effect.getTiming().duration)};
 },phase);
 assert.ok(frame.atlas.startsWith('url("data:image/png;base64,'),'runner atlas embedded');
 assert.equal(frame.cycles.length,5,'monkey pose, travel, canopy and two fruit layers animate');
 assert.ok(frame.cycles.every(duration=>duration===9000),'shared 9 second cycle');
 phases.push(frame);
 await page.locator('.hero-art').screenshot({path:path.join(out,`tree-motion-${Math.round(phase*100)}.png`)});
}
assert.ok(new Set(phases.map(f=>f.monkey)).size>=3,'monkey visits different branch positions');
assert.ok(new Set(phases.map(f=>f.pose)).size>=3,'sprite poses change across jumps');
assert.ok(new Set(phases.map(f=>f.canopy)).size>=3,'canopy responds to landings');
assert.ok(new Set(phases.map(f=>f.fruit)).size>=3,'fruit settles after landings');
await page.emulateMedia({reducedMotion:'reduce'});
assert.equal(await page.locator('.tree-canopy').evaluate(el=>getComputedStyle(el).animationName),'none');
await page.emulateMedia({reducedMotion:'no-preference'});
await go('tree');let box=await page.locator('#drag-tree').boundingBox();await page.mouse.move(box.x+70,box.y+80);await page.mouse.down();await page.mouse.move(box.x+135,box.y+100,{steps:10});await page.mouse.up();let moved=await page.locator('#drag-tree').boundingBox();assert.ok(moved.x>box.x+50,'tree follows drag');assert.equal(await page.locator('.board').count(),0,'drag does not open board');
await page.locator('#drag-tree').click();assert.equal(await page.locator('.board').count(),1);await page.locator('[data-action=collapse]').click();await page.locator('[data-action=tree-menu]').click();await page.locator('[data-action=exit-tree]').click();assert.equal(await page.locator('[data-action=restart-tree]').count(),1);await page.locator('[data-action=restart-tree]').click();
await go('states');await page.locator('[data-action=state][data-state=read]').click();assert.equal(await page.locator('.state-feature h2').textContent(),english?'Already collected':'已经收走');
await go('board');await page.locator('[data-action=tab][data-tab=recent]').click();assert.equal(await page.locator('.task').first().getAttribute('data-state'),'unread');await page.locator('[data-action=open-task][data-id="1"]').click();assert.equal(await page.locator('[role=dialog]').count(),1);await page.locator('[data-action=confirm-read]').click();assert.equal(await page.locator('[data-action=open-task][data-id="1"]').getAttribute('data-state'),'read');await page.locator('[data-action=tab][data-tab=history]').click();assert.equal(await page.locator('.task').count(),1);
await go('harvest');await page.locator('[data-action=collect][data-id="1"]').click();await page.waitForTimeout(850);assert.equal(await page.locator('#harvest-number').textContent(),'14');assert.equal(await page.locator('[data-action=collect][data-id="1"]').isDisabled(),true);
await go('quota');await page.locator('#quota-range').fill('18');assert.equal(await page.locator('#quota-display').getAttribute('data-tone'),'low');await page.locator('[data-action=quota-mode][data-mode=retry]').click();assert.equal(await page.locator('#quota-value').textContent(),'18%');await page.locator('[data-action=quota-mode][data-mode=expired]').click();assert.equal(await page.locator('#quota-value').textContent(),'—');await page.locator('[data-action=quota-refresh]').click();await page.waitForTimeout(800);assert.equal(await page.locator('#quota-value').textContent(),'18%');
await go('pin');await page.locator('[data-action=outside]').click();assert.equal(await page.locator('[data-action=restore-board]').count(),1);await page.locator('[data-action=restore-board]').click();await page.locator('[data-action=pin]').click();await page.locator('[data-action=outside]').click();assert.equal(await page.locator('.board').count(),1);
await go('install');await page.locator('[data-action=os][data-os=windows]').click();assert.match(await page.locator('.steps').textContent(),/WebView2/);await page.locator('[data-action=copy-prompt]').click();await page.waitForFunction(()=>/已复制|已选中|Copied|Text selected/.test(document.querySelector('#copy-result').textContent));
await go('faq');await page.locator('summary').first().click();assert.equal(await page.locator('details').first().getAttribute('open'),'');
await page.emulateMedia({reducedMotion:'reduce'});await go('harvest');await page.locator('[data-action=collect][data-id="2"]').click();assert.equal(await page.locator('.flying').count(),0);await go('quota');assert.equal(await page.locator('.coin-button img').evaluate(el=>getComputedStyle(el).animationName),'none');
await page.locator('#reset').click();assert.equal(await page.locator('#quota-value').textContent(),'68%');assert.equal(external.length,0,'offline guide makes no HTTP requests');assert.deepEqual(errors,[]);
fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({routes:routes.length,viewports:4,errors,externalRequests:external,checks:'drag tap context menu state filters navigation harvest quota pin install copy accordion reduced-motion reset',status:'passed'},null,2));
console.log('PASS: 11 routes × 4 viewports, offline assets, all feature interactions and reduced motion');await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
