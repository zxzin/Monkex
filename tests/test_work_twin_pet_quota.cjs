// Production collapsed/expanded quota rendering shares freshness and account data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const source=read('shell/app.js'),html=read('shell/index.html'),css=read('shell/styles.css');
const elements=new Map();
const $=id=>{if(!elements.has(id))elements.set(id,{dataset:{},children:[],setAttribute(k,v){this[k]=v;}});return elements.get(id);};
const now=Date.now()/1000;
const state={connected:true,weeklyUsage:{available:true,remaining_percent:68,observed_at:now,resets_at:now+3600}};
let unread=2,running=1;
const ctx={state,$,Date,window:{WorkTwinBananaTree:require('../shell/banana-tree.js')},
  displayStatus:t=>t.unread?'unread':'running',boardSets:()=>({board:[...Array.from({length:unread},()=>({unread:true})),...Array.from({length:running},()=>({status:'running'}))],recent:Array.from({length:unread},()=>({unread:true})),history:[]})};
vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('function updateCounts('),source.indexOf('function activityTime(')),ctx);
function verify(value,tone){ctx.updateCounts();assert.equal($('petQuotaRemaining').textContent,value);assert.equal($('weeklyRemaining').textContent,value);assert.equal($('petQuota').dataset.state,tone);assert.equal($('petQuota').title,$('weeklyQuota').title);}
verify('68%','normal');
assert.equal($('petGrowth').dataset.count,'1','production connects running count to green fruit');
assert.match($('petLauncher')['aria-label'],/2 根香蕉待收.*1 项任务进行中.*周剩余 68%/);
unread=0;verify('68%','normal');assert.equal($('petCharacter').dataset.running,'true');assert.equal($('petGrowth').dataset.count,'1');
running=0;verify('68%','normal');assert.equal($('petCharacter').dataset.running,'false');assert.equal($('petGrowth').dataset.count,'0');
state.weeklyUsage.remaining_percent=0;verify('0%','low');
state.weeklyUsage.remaining_percent=100;verify('100%','normal');
state.weeklyUsage.remaining_percent=68;state.weeklyUsage.observed_at=now-91;verify('—','unknown');
state.weeklyUsage.observed_at=now;state.weeklyUsage.resets_at=now-1;verify('—','unknown');
state.weeklyUsage.resets_at=now+3600;running=3;state.connected=false;verify('—','unknown');assert.equal($('petGrowth').dataset.count,'0');
state.connected=true;state.weeklyUsage=null;verify('—','unknown');
for(const obsolete of ['petStateLabel','petUsageValue','pet-state-label','pet-usage'])assert.ok(!(html+source+css).includes(obsolete),'remove obsolete corner marker '+obsolete);
assert.match(html,/id="petQuota" class="pet-quota"/);
assert.match(css,/\.pet-quota\s*\{[^}]*left: 50%;[^}]*bottom: 0;/);
assert.match(css,/\.pet-shell\{[^}]*width:76px;height:76px/);
assert.match(css,/\.tree-harvest\[data-connected=true\] \.tree-fruit::before\{[^}]*animation:fruit-ready 2.8s/);
assert.match(css,/@keyframes fruit-ready\{0%,100%\{opacity:\.35\}50%\{opacity:1\}/);
assert.ok(css.includes('html[data-page-hidden=true] .tree-fruit::before'));
assert.ok(css.includes('.pet-mode[data-mode=compact] .tree-fruit::before'));
assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{animation:none!important/);
console.log('PASS: collapsed quota matches header; 0/100/stale/reset/offline covered, corner markers removed, fruit glow bounded and pausable');
