// Synthetic attention-state coverage. No account, task or reply writes.
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.join(__dirname,'..'),now=Date.now()/1000;
class Element{
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.style={setProperty(){}};this.attributes={};}
  append(...children){this.children.push(...children)}
  replaceChildren(...children){this.children=children}
  setAttribute(k,v){this.attributes[k]=String(v)}
  get firstElementChild(){return this.children[0]}
}
for(const lang of ['zh','en']){
  const source=fs.readFileSync(path.join(root,lang==='en'?'shell/en/app.js':'shell/app.js'),'utf8');
  const state={threads:[],connected:true,filter:'board'};
  const ctx={state,Date,Number,relativeTime:()=>'',document:{createElement:tag=>new Element(tag),createElementNS:(ns,tag)=>new Element(tag)}};
  vm.createContext(ctx);
  for(const [from,to]of [['function node(','async function api('],['function activityTime(','function renderList(']])vm.runInContext(source.slice(source.indexOf(from),source.indexOf(to)),ctx);
  const pending={pending:true,count:2,available:true,observed_at:now,turn_id:'turn-a'};
  const input={id:'input',name:'A very long task title for a pending question',status:'running',latest_turn_id:'turn-a',unread:false,updated_at:now-3600,input_request:pending,summary:'Existing progress stays visible',cwd:'/demo/a'};
  assert.equal(ctx.inputRequestState(input),'waiting');assert.equal(ctx.displayStatus(input),'waiting');
  assert.equal(ctx.inputRequestState({...input,input_request:{...pending,observed_at:now-31}}),'pending');
  assert.equal(ctx.inputRequestState({...input,input_request:{...pending,observed_at:now+31}}),'pending');
  assert.equal(ctx.inputRequestState({...input,input_request:{...pending,available:false}}),'pending');
  assert.equal(ctx.inputRequestState({...input,latest_turn_id:'new-turn'}),'pending','a previous-turn observation never appears current');
  assert.equal(ctx.inputRequestState({...input,latest_turn_id:null}),'pending','a missing turn identity never appears current');
  state.connected=false;assert.equal(ctx.displayStatus(input),'pending');state.connected=true;
  for(const card of [{...input,input_request:{pending:false,available:true}}, {...input,input_request:null}])assert.equal(ctx.displayStatus(card),'running');
  const button=new Element('button');ctx.updateTaskRow(button,input);
  const bubble=button.children[1].children[0].children[1];
  assert.equal(bubble.className,'input-bubble');assert.equal(bubble.textContent,lang==='en'?'Needs reply':'需要你回复');
  assert.ok(button.title.includes(input.name));
  input.tokens={ready:true,tokens_per_min:12340,last_report_at:now};
  input.runtime={phase:'response',observation_available:true,activity_at:now};
  ctx.updateTaskRow(button,input);
  const rate=button.children[1].children[1].children[1];
  assert.equal(rate.className,'row-rate');assert.match(rate.children[1].textContent,/12.3k t\/min/,'async questions preserve current reported activity');
  assert.equal(rate.children[0].dataset.spinning,'true');
  input.tokens={ready:true,tokens_per_min:0,last_report_at:now};input.runtime.phase='waiting_user';
  assert.equal(ctx.taskRunState(input).label,lang==='en'?'Needs reply':'等你回复');
  state.threads=[{id:'run',status:'running',updated_at:now,cwd:'/demo/a'},input,{id:'done',status:'result_ready',unread:true,updated_at:now-7200,cwd:'/demo/a'},
    {id:'old-input',status:'completed',unread:false,updated_at:now-9*86400,input_request:pending,cwd:'/demo/a'}];
  assert.deepEqual(Array.from(ctx.filtered(),card=>card.id),['done','input','old-input','run'],'completed unread results lead, input requests precede normal running within their project');
  assert.ok(Array.from(ctx.boardSets().board,card=>card.id).includes('old-input'),'an open input request remains visible beyond the recent window');
  state.threads[3].input_request={pending:false,available:true,observed_at:now};
  assert.ok(!Array.from(ctx.boardSets().board,card=>card.id).includes('old-input'),'resolved old input leaves the board');
  state.filter='frequent';assert.ok(!Array.from(ctx.filtered(),card=>card.id).includes('input'),'an input request alone does not establish repeated user conversations');
}
console.log('PASS: bilingual input bubbles, fresh/unknown/resolved states, retained token activity, pending membership and priority.');
