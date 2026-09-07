const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const root=require('node:path').join(__dirname,'..'),read=p=>fs.readFileSync(require('node:path').join(root,p),'utf8');
const source=read('shell/app.js'),html=read('shell/index.html'),native=read('desktop_shell/src-tauri/src/lib.rs');
for(const obsolete of ['newTaskButton','newTaskDialog','startTask','openNew','workspaceType','categoryFilter','/api/tasks','/api/route','work-twin-new-task']){
  assert.ok(!(html+source).includes(obsolete),'remove obsolete entry '+obsolete);
}
assert.ok(!native.includes('pet-new-task'));assert.ok(!native.includes('set_pet_expanded'));
const config=JSON.parse(read('desktop_shell/src-tauri/tauri.conf.json'));
assert.equal(config.productName,'Monkex');
assert.equal(config.app.windows[0].title,'Monkex');
assert.equal(config.identifier,'com.zin.work-twin','rename preserves app data identity');
assert.match(html,/<title>Monkex<\/title>/);
assert.match(html,/id="viewHeading"[^>]*>Monkex<\/span>/);
assert.match(html,/id="petShell"[^>]*aria-label="Monkex"/);
assert.ok(native.includes('"退出 Monkex"'));
const brandSurfaces=[html,native,JSON.stringify(config)];
for(const surface of brandSurfaces) assert.ok(!surface.includes('猴克斯'),'product surfaces use the single Monkex name');
assert.ok(config.bundle.icon.includes('icons/monkex-giant-banana-v2/icon.icns'),'desktop launcher uses the leafy monkey hugging one giant banana');
const iconData=fs.readFileSync(require('node:path').join(root,'desktop_shell/src-tauri/icons/monkex-giant-banana-v2/128x128.png'));
assert.equal(iconData.readUInt32BE(16),128);assert.equal(iconData.readUInt32BE(20),128);
assert.ok(html.includes('/gold-chain-monkey.png'),'dashboard portrait keeps its existing artwork');
assert.ok(html.includes('/banana-tree.png'),'live tree keeps its existing artwork');
for(const icon of config.bundle.icon) assert.ok(fs.existsSync(require('node:path').join(root,'desktop_shell/src-tauri',icon)));
const reopen=native.slice(native.indexOf('if matches!(event, tauri::RunEvent::Reopen'));
assert.match(reopen,/set_window_mode\(&window, true\)/,'reopening the app expands the existing board');
assert.match(reopen,/expanded: true/);assert.match(reopen,/window\.set_focus\(\)/);
assert.ok(!html.includes('feed-footer'),'footer controls are removed');
assert.match(html,/id="pinButton"[^>]*aria-pressed="false"[^>]*><svg/);
assert.match(html,/id="boardSettings"[^>]*hidden/);
const elements=new Map(),styles={},timers=new Map(),modes=[],writes=[],calls=[];let timerId=0;
const $=id=>{if(!elements.has(id))elements.set(id,{hidden:true,value:'',offsetHeight:112,focus(){this.focused=true;},setAttribute(k,v){this[k]=v;}});return elements.get(id);};
const state={mode:'compact',petMode:true,pinned:false,boardSize:0,selectionRevision:0,navigation:{pending:null,navigate:async()=>true}};
const ctx={state,$,clearTimeout:id=>timers.delete(id),setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},
  document:{documentElement:{style:{setProperty:(k,v)=>styles[k]=v}}},localStorage:{setItem:(...args)=>writes.push(args)},
  filtered:()=>Array.from({length:3}),renderList(){},mode:value=>{state.mode=value;modes.push(value);},
  invokeDesktop:(name,args)=>{calls.push({name,args});return Promise.resolve();}};
vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('function boardHeight('),source.indexOf('function bind(')),ctx);
(async()=>{
  assert.equal(ctx.boardHeight(0),180);assert.equal(ctx.boardHeight(3),230);
  assert.equal(ctx.boardHeight(7),414);assert.equal(ctx.boardHeight(100),420);
  assert.equal(ctx.boardHeight(3,112),342);
  ctx.syncBoardSize();assert.equal(styles['--board-height'],'230px');
  assert.equal(calls[0].args.height,230);ctx.syncBoardSize();assert.equal(calls.length,1,'unchanged size has no native IPC');
  ctx.setSettings(true);assert.equal($('boardSettings').hidden,false);assert.equal($('searchInput').focused,true);
  $('searchInput').value='synthetic';ctx.setSettings(false);assert.equal($('searchInput').value,'','closing search restores full time scope');
  ctx.togglePin();assert.equal($('pinButton')['aria-pressed'],'true');assert.match($('pinButton').title,/拔起/);
  assert.deepEqual(writes[0],['twin-pinned','true']);
  await ctx.selectThread('a');assert.equal(timers.size,0,'pinned board stays expanded');
  ctx.togglePin();await ctx.selectThread('a');assert.equal(timers.size,1);
  const [id,timer]=[...timers][0];assert.equal(timer.ms,1200);timers.delete(id);timer.fn();
  assert.equal(modes.at(-1),'collapsed');
  state.mode='compact';await ctx.selectThread('a');ctx.togglePin();assert.equal(timers.size,0,'pin cancels an armed collapse');
  ctx.togglePin();state.navigation.navigate=async()=>false;await ctx.selectThread('a');assert.equal(timers.size,0,'failed open stays visible');
  state.navigation.navigate=async()=>true;$('systemBanner').hidden=false;
  await ctx.selectThread('a');assert.equal(timers.size,0,'failed read receipt stays visible');
  $('systemBanner').hidden=true;await ctx.selectThread('a');ctx.setSettings(true);
  assert.equal(timers.size,0,'opening settings cancels collapse');ctx.setSettings(false);
  state.petMode=false;await ctx.selectThread('a');assert.equal(timers.size,0,'browser preview stays open');
  console.log('PASS: observer-only entry, graphic pin, bounded adaptive sizing, settings, collapse timing and failure preservation');
})().catch(error=>{console.error(error);process.exitCode=1;});
