// Real compact-board filtering and ordering, without Codex or business writes.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../shell/app.js'),'utf8');
const now=Date.parse('2026-09-06T16:01:00Z')/1000,day=86400;
const state={threads:[],filter:'board',connected:true};
const ctx={state,Date:{now:()=>now*1000,parse:Date.parse}};
vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('function weeklyQuotaState('),source.indexOf('function activityTime(')),ctx);
vm.runInContext(source.slice(source.indexOf('function activityTime('),source.indexOf('function renderList(')),ctx);
const card=(id,age,extra={})=>({id,name:id,updated_at:now-age,status:'result_ready',unread:true,category:'work',...extra});
const ids=items=>Array.from(items,t=>t.id);
const quota={available:true,remaining_percent:38,observed_at:now,resets_at:now+100};
assert.equal(ctx.weeklyQuotaState(quota).label,'38%');
assert.equal(ctx.weeklyQuotaState({...quota,remaining_percent:0}).label,'0%');
assert.equal(ctx.weeklyQuotaState({...quota,observed_at:now-91}).label,'—');
assert.equal(ctx.weeklyQuotaState({...quota,resets_at:now-1}).label,'—');
assert.equal(ctx.weeklyQuotaState(null).label,'—');
state.connected=false;assert.equal(ctx.weeklyQuotaState(quota).label,'38%','task health is independent of fresh account quota');state.connected=true;
state.threads=[card('old-unread',8*day),card('today-read',3600,{unread:false}),
  card('today-unread',7200),card('day-edge',day),card('history',day+1),
  card('week-edge',7*day),card('long-running',9*day,{status:'running',unread:false}),
  card('waiting',4000,{status:'waiting_user',unread:false}),card('bad-time',0,{updated_at:null}),
  card('fresh-event',8*day,{runtime_observed_at:now-10})];
assert.deepEqual(ids(ctx.filtered()),['fresh-event','today-unread','day-edge','long-running']);
assert.ok(!ids(ctx.filtered()).includes('waiting'),'viewed waiting tasks leave the board');
const groups=ctx.boardSets();
assert.ok(ids(groups.recent).includes('today-read'),'read results remain in the 24-hour view');
assert.ok(!('history' in groups),'history tab is removed');
assert.ok(!ids(groups.board).includes('old-unread'),'old unread cannot bypass the date limit');
state.filter='recent';
assert.ok(ids(ctx.filtered()).includes('fresh-event'),'actual runtime event advances last activity');
state.connected=false;
assert.ok(ids(ctx.filtered()).includes('long-running'),'transient disconnection preserves a known running card for pending sync');
const longRunning=state.threads.find(t=>t.id==='long-running');
Object.assign(longRunning,{status:'unknown',last_observed_status:'running',sync_pending:true});
assert.ok(ids(ctx.filtered()).includes('long-running'),'explicit pending sync preserves the same card');
Object.assign(longRunning,{status:'result_ready',sync_pending:false});
assert.ok(!ids(ctx.filtered()).includes('long-running'),'authoritative terminal state restores the normal date filter');
Object.assign(longRunning,{status:'running'});
state.connected=true;
assert.equal(ctx.activityTime({updated_at:'2026-09-06T15:00:00Z'}),Date.parse('2026-09-06T15:00:00Z')/1000);
assert.ok(!ids(ctx.boardSets(now+1).recent).includes('day-edge'),'24-hour boundary moves without a new event');
state.threads=Array.from({length:30},(_,i)=>card('run-'+i,i,{status:'running'}));state.filter='board';
assert.equal(ctx.filtered().length,30,'board has no three-row or top-N cutoff');

// Results and waiting tasks lead the board; the running group keeps its own recency order.
state.threads=[card('running-with-old-result',5,{status:'running'}),
  card('older-result',200),card('waiting-for-user',100,{status:'waiting_user',unread:true}),
  card('just-finished',20),card('running',10,{status:'running',unread:false})];
assert.deepEqual(ids(ctx.filtered()),['just-finished','waiting-for-user','older-result','running-with-old-result','running']);
const transitioning=state.threads.find(t=>t.id==='running');
Object.assign(transitioning,{status:'result_ready',unread:true,updated_at:now});
assert.equal(ctx.filtered()[0].id,'running','a newly finished run rises above all active tasks');
transitioning.status='running';
assert.deepEqual(ids(ctx.filtered()),['just-finished','waiting-for-user','older-result','running','running-with-old-result'],
  'a resumed task returns to the running group even with an unread older result');
state.filter='recent';
state.threads.push(card('viewed-result',300,{unread:false}));
assert.deepEqual(ids(ctx.filtered()),['just-finished','waiting-for-user','older-result','viewed-result','running','running-with-old-result'],
  'the 24-hour view puts both unread and read ended tasks above all running tasks');
Object.assign(transitioning,{status:'result_ready',unread:false,updated_at:now});
assert.deepEqual(ids(ctx.filtered()),['just-finished','waiting-for-user','older-result','running','viewed-result','running-with-old-result'],
  '24-hour view ranks unread before newer read results, then active tasks');
state.threads.find(t=>t.id==='just-finished').unread=false;
assert.deepEqual(ids(ctx.filtered()).slice(0,4),['waiting-for-user','older-result','running','just-finished'],
  'confirming a result moves it behind unread results while keeping read recency order');
state.threads.find(t=>t.id==='just-finished').unread=true;
transitioning.status='running';
assert.deepEqual(ids(ctx.filtered()).slice(-2),['running','running-with-old-result'],'resumed tasks return to the running group');
state.filter='board';

state.threads=[card('alpha-new',10,{cwd:'/projects/alpha'}),card('beta',20,{cwd:'/projects/beta'}),card('alpha-run',30,{cwd:'/projects/alpha',status:'running',unread:false})];
assert.deepEqual(ids(ctx.filtered()),['alpha-new','alpha-run','beta'],'project grouping keeps one project contiguous while preserving its internal priority');

const frequency=(count,last=now-10,extra={})=>({source:'codex_run',window_days:7,run_count:count,weighted_score:count*3,active_days:count?1:0,last_run_at:count?last:null,observed_at:now,complete:true,available:true,...extra});
state.filter='frequent';
state.threads=[card('single',1,{usage_frequency:frequency(1)}),card('unknown',2),
  card('read-often',8*day,{unread:false,usage_frequency:frequency(12)}),
  card('busy-once',0,{status:'running',tokens:{tokens_per_min:1e9}}),
  card('unread-twice',2,{usage_frequency:frequency(2)}),
  card('two-old',8*day,{usage_frequency:frequency(2,now-2*day,{weighted_score:4})}),
  card('outside',1,{usage_frequency:frequency(30,now-7*day-1)}),
  card('future',1,{usage_frequency:frequency(50,now+31)}),
  card('tie-b',1,{usage_frequency:frequency(4,now-20)}),
  card('negative',1,{usage_frequency:frequency(-1)}),
];
assert.deepEqual(ids(ctx.filtered()),['tie-b','unread-twice','two-old','read-often'],'completed unread results precede a more-used viewed conversation');
assert.equal(ctx.usageFrequency({usage_frequency:frequency(0)}).count,0,'a known zero differs from unavailable tracking');
assert.ok(!ids(ctx.boardSets(now+7*day).frequent).includes('two-old'),'latest run rolls out of the seven-day window');
assert.equal(ctx.frequencyReady(),false,'unknown tracking differs from zero');
for(const patch of [{source:'monkex_open'},{source:'local_user_events'},{available:false},{run_count:true},{weighted_score:Infinity},{weighted_score:1},{active_days:8},{last_run_at:now-7*day}]){
  assert.equal(ctx.usageFrequency({usage_frequency:frequency(2,now,patch)}),null,'invalid or expired run evidence is rejected');
}
state.connected=false;
assert.equal(ctx.filtered()[0].id,'tie-b','offline view keeps the same recorded priority without adding runs');
state.connected=true;
state.threads=[card('a10',1,{cwd:'/a',usage_frequency:frequency(10)}),card('b8',1,{cwd:'/b',usage_frequency:frequency(8)}),card('a2',1,{cwd:'/a',usage_frequency:frequency(2)})];
assert.deepEqual(ids(ctx.filtered()),['a10','b8','a2'],'frequent is one global list across projects');
assert.equal(ctx.frequencyReady(),true);
const first=ids(ctx.filtered());ctx.filtered();ctx.boardSets();assert.deepEqual(ids(ctx.filtered()),first,'viewing frequency does not increment usage');
state.threads=[card('running-most',1,{status:'running',usage_frequency:frequency(20)}),
  card('reply',1,{input_request:{pending:true},usage_frequency:frequency(3)}),
  card('unread-least',1,{usage_frequency:frequency(2)})];
assert.deepEqual(ids(ctx.filtered()),['unread-least','reply','running-most'],'unviewed completed result first, pending reply second, current runtime last even with an older unread result');
state.threads.find(t=>t.id==='unread-least').unread=false;
assert.deepEqual(ids(ctx.filtered()),['reply','running-most','unread-least'],'viewing a result returns it to frequency order behind pending replies');
state.threads=[card('old-many',1,{status:'running',usage_frequency:frequency(8,now-4*day,{weighted_score:8})}),
  card('recent-fewer',1,{status:'running',usage_frequency:frequency(3,now,{weighted_score:9})}),
  card('middle',1,{status:'running',usage_frequency:frequency(4,now-2*day,{weighted_score:8})})];
assert.deepEqual(ids(ctx.filtered()),['recent-fewer','old-many','middle'],'all-green tasks sort by weighted runs, then active days and count');
state.threads=[card('one-day',1,{status:'running',usage_frequency:frequency(6,now,{weighted_score:12})}),
  card('three-days',1,{status:'running',usage_frequency:frequency(5,now-10,{weighted_score:12,active_days:3})})];
assert.deepEqual(ids(ctx.filtered()),['three-days','one-day'],'active days break equal weighted-run scores');
const html=fs.readFileSync(require('node:path').join(__dirname,'../shell/index.html'),'utf8');
assert.ok(html.includes('data-filter="frequent"')&&!html.includes('data-filter="history"'),'frequent replaces history in navigation');
assert.deepEqual([...html.matchAll(/data-filter="([^"]+)"/g)].map(m=>m[1]),['board','frequent','recent'],'frequency is the middle category');
assert.match(html,/未查看 <span id="boardCount"/);assert.match(html,/常用对话 <span id="frequentCount"/);assert.match(html,/最近记录 <span id="recentCount"/);
console.log('PASS: 24h priority, seven-day weighted runs, global frequent order and no view-side counting');
