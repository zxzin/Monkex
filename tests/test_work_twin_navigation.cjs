const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const TaskNavigation=require('../shell/task-navigation.js');
const card=(id='a',extra={})=>({id,unread:true,status:'result_ready',pending_result_version:'v1',...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(setImmediate);
function fixture(cards=[card()]){
  const f={cards,calls:[],errors:[],opened:[],read:[],rewards:[],busy:[],armed:[],connected:true};
  f.api=async(url,body)=>({ok:true});
  f.nav=new TaskNavigation({
    getCard:id=>f.cards.find(c=>c.id===id),isConnected:()=>f.connected,
    api:async(url,body)=>{f.calls.push({url,body});return f.api(url,body);},
    onPending:id=>f.busy.push(id),onOpened:id=>f.opened.push(id),
    onRead:id=>f.read.push(id),onError:error=>f.errors.push(error),
    readPlay:{arm:c=>f.armed.push(c.id),cancel(){},confirm:r=>f.rewards.push(r)},
  });return f;
}
async function run(){
  let f=fixture(),gate=deferred();
  f.api=async url=>url.endsWith('/open')?gate.promise:{ok:true};
  const opening=f.nav.navigate('a');
  assert.equal(f.nav.navigate('a'),opening,'duplicate clicks share one request');
  await tick();
  assert.deepEqual(f.calls,[{url:'/api/threads/a/open',body:{}}]);
  assert.equal(f.cards[0].unread,true,'opening never marks a result early');
  gate.resolve({ok:true});assert.equal(await opening,true);
  assert.deepEqual(f.calls[1],{url:'/api/threads/a/ack',body:{version:'v1'}});
  assert.deepEqual(f.opened,['a']);assert.deepEqual(f.read,['a']);
  assert.deepEqual(f.rewards,[{threadId:'a',version:'v1'}]);
  assert.equal(f.cards[0].status,'result_ready','reading never accepts a project');
  await f.nav.navigate('a');
  assert.equal(f.calls.filter(c=>c.url.endsWith('/ack')).length,1,'read cards only navigate');
  assert.equal(f.busy.at(-1),null);

  for(const failure of [()=>{throw Error('offline');},()=>({ok:false}),()=>({})]){
    f=fixture();f.api=failure;assert.equal(await f.nav.navigate('a'),false);
    assert.equal(f.calls.length,1);assert.equal(f.cards[0].unread,true);
    assert.equal(f.rewards.length,0);assert.equal(f.errors.length,1);
    f.api=async()=>({ok:true});await f.nav.navigate('a');
    assert.equal(f.cards[0].unread,false,'failed navigation can be retried');
  }
  f=fixture();f.connected=false;await f.nav.navigate('a');
  assert.equal(f.calls.length,0);assert.equal(f.cards[0].unread,true);
  for(const fail of [()=>{throw Error('offline');},()=>({ok:false})]){
    f=fixture();f.api=async url=>url.endsWith('/ack')?fail():{ok:true};
    await f.nav.navigate('a');assert.equal(f.cards[0].unread,true);
    assert.equal(f.rewards.length,0);assert.match(f.errors[0],/已读标记未保存/);
  }
  f=fixture([card('running',{status:'running'})]);await f.nav.navigate('running');
  assert.equal(f.calls.length,1);assert.equal(f.cards[0].status,'running');
  assert.equal(f.cards[0].unread,true,'an older result stays pending while a turn is running');
  assert.equal(f.armed.length,0);assert.equal(f.rewards.length,0);

  // A new result arriving during opening or acknowledgement remains unread.
  for(const step of ['open','ack']){
    f=fixture();gate=deferred();f.api=async url=>url.endsWith('/'+step)?gate.promise:{ok:true};
    const work=f.nav.navigate('a');await tick();
    f.cards[0]=card('a',{pending_result_version:'v2'});
    gate.resolve({ok:true});await work;
    assert.equal(f.cards[0].pending_result_version,'v2');assert.equal(f.cards[0].unread,true);
    assert.equal(f.rewards.length,0);
    if(step==='open')assert.equal(f.calls.length,1);
  }
  f=fixture();gate=deferred();f.api=async()=>gate.promise;
  const resumed=f.nav.navigate('a');await tick();f.cards[0].status='running';
  gate.resolve({ok:true});await resumed;assert.equal(f.calls.length,1);assert.equal(f.rewards.length,0);

  // An in-flight dispatch finishes before the newest queued target; intermediate clicks are skipped.
  f=fixture([card('a'),card('b'),card('c')]);gate=deferred();
  f.api=async url=>url==='/api/threads/a/open'?gate.promise:{ok:true};
  const first=f.nav.navigate('a');await tick();
  const middle=f.nav.navigate('b'),last=f.nav.navigate('c');gate.resolve({ok:true});
  await Promise.all([first,middle,last]);
  assert.deepEqual(f.calls.map(c=>c.url),['/api/threads/a/open','/api/threads/c/open','/api/threads/c/ack']);
  assert.deepEqual(f.opened,['c']);assert.equal(f.cards[0].unread,true);assert.equal(f.cards[1].unread,true);
  assert.equal(f.cards[2].unread,false);assert.equal(f.busy.at(-1),null);
  f=fixture([card('a'),card('b')]);await Promise.all([f.nav.navigate('a'),f.nav.navigate('b')]);
  assert.equal(f.calls[0].url,'/api/threads/b/open','queued stale intent never dispatches');

  const root=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
  const config=JSON.parse(read('desktop_shell/src-tauri/tauri.conf.json'));
  assert.deepEqual(config.app.windows.map(w=>w.label),['main']);
  assert.deepEqual(JSON.parse(read('desktop_shell/src-tauri/capabilities/default.json')).windows,['main']);
  for(const file of ['shell/index.html','shell/app.js','desktop_shell/src-tauri/src/lib.rs']){
    const source=read(file);
    for(const obsolete of ['detailView','open_task_detail','close_task_detail','get_detail_target','DetailState','panel=detail']){
      assert.ok(!source.includes(obsolete),file+' removes '+obsolete);
    }
  }
  const source=read('shell/app.js');
  assert.ok(source.includes('state.navigation.navigate(id)'));
  assert.ok(read('shell/index.html').includes('/shell/task-navigation.js'));
  for(const route of ['/messages','/interrupt','/respond','/api/pending'])assert.ok(!source.includes(route),'task replies and approvals stay in Codex');
  console.log('PASS: exact navigation, success-before-read, duplicates, failures, new-result races, latest target ordering and single native window');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
