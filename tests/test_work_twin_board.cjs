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
state.connected=false;assert.equal(ctx.weeklyQuotaState(quota).label,'—');state.connected=true;
state.threads=[card('old-unread',8*day),card('today-read',3600,{unread:false}),
  card('today-unread',7200),card('day-edge',day),card('history',day+1),
  card('week-edge',7*day),card('long-running',9*day,{status:'running',unread:false}),
  card('waiting',4000,{status:'waiting_user',unread:false}),card('bad-time',0,{updated_at:null}),
  card('fresh-event',8*day,{runtime_observed_at:now-10})];
assert.deepEqual(ids(ctx.filtered()),['fresh-event','today-unread','day-edge','long-running']);
assert.ok(!ids(ctx.filtered()).includes('waiting'),'viewed waiting tasks leave the board');
const groups=ctx.boardSets();
assert.ok(ids(groups.recent).includes('today-read'),'read results remain in the 24-hour view');
assert.deepEqual(ids(groups.history),['history','week-edge']);
assert.ok(!ids(groups.board).includes('old-unread'),'old unread cannot bypass the date limit');
state.filter='history';
assert.deepEqual(ids(ctx.filtered()),['history','week-edge'],'history contains only records in its date range');
state.filter='recent';
assert.ok(ids(ctx.filtered()).includes('fresh-event'),'actual runtime event advances last activity');
state.connected=false;
assert.ok(!ids(ctx.filtered()).includes('long-running'),'offline state cannot pin stale running tasks');
state.connected=true;
assert.equal(ctx.activityTime({updated_at:'2026-09-06T15:00:00Z'}),Date.parse('2026-09-06T15:00:00Z')/1000);
assert.ok(!ids(ctx.boardSets(now+1).recent).includes('day-edge'),'24-hour boundary moves without a new event');
assert.ok(!ids(ctx.boardSets(now+1).history).includes('week-edge'),'7-day boundary moves without a new event');
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
state.filter='history';
state.threads.push(card('history-old',3*day),card('history-new',2*day,{unread:false}));
assert.deepEqual(ids(ctx.filtered()),['history-new','history-old'],'history retains its date range and descending time order');
state.filter='board';

console.log('PASS: rolling 24h/7d, unread/read/running priority, viewed-result transition and chronological history');
