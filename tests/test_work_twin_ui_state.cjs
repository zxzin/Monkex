// Run the real list renderer against a tiny DOM fixture; no Codex connection.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../shell/app.js'),'utf8');
class Element {
  constructor(tag){this.tag=tag;this.children=[];this.dataset={};this.scrollTop=12;this.style={setProperty(){}};}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  get firstElementChild(){return this.children[0];}
  querySelectorAll(){return this.children.filter(c=>c.dataset.threadId);}
  setAttribute(key,value){(this.attributes||={})[key]=value;}
  addEventListener(){}
}
const list=new Element('div');
const state={threads:[{id:'a',name:'A',status:'running'},{id:'b',name:'B',status:'running'}],filter:'running',connected:true,listBusy:false};
const ctx={state,Set,document:{createElementNS:(ns,tag)=>new Element(tag)},$:()=>list,node:(tag,cls,text)=>Object.assign(new Element(tag),{className:cls,textContent:text}),relativeTime:()=>'',selectThread:()=>{},filtered:()=>state.threads.filter(t=>state.filter!=='running'||t.status==='running')};
ctx.syncBoardSize=()=>{};
vm.createContext(ctx);
vm.runInContext(source.slice(source.indexOf('function activityTime('),source.indexOf('function boardSets(')),ctx);
vm.runInContext(source.slice(source.indexOf('function shortStatus('),source.indexOf('async function api(')),ctx);
vm.runInContext(source.slice(source.indexOf('function renderList('),source.indexOf('async function refresh(')),ctx);
ctx.renderList();
assert.equal(list.children.length,2);
state.listBusy=true;
state.threads.reverse();
ctx.renderList();
assert.equal(list.children[0].dataset.threadId,'a','hover preserves ordering');
state.threads.find(t=>t.id==='a').status='completed';
ctx.renderList();
assert.equal(list.children.length,1,'completed task leaves running filter while hovered');
assert.equal(list.children[0].dataset.threadId,'b');
state.filter='all';
ctx.renderList(true);
state.threads.find(t=>t.id==='b').status='interrupted';
ctx.renderList();
assert.equal(list.children.find(t=>t.dataset.threadId==='b').dataset.status,'read','non-running badge follows its read receipt');
for(const status of ['waiting_user','result_ready','completed','failed','interrupted','unknown']){
  assert.equal(ctx.shortStatus({status,unread:true}),'未读');
  assert.equal(ctx.shortStatus({status,unread:false}),'已读');
}
assert.equal(ctx.shortStatus({status:'running',unread:false}),'进行中','reading an active task retains its running state');
assert.equal(ctx.shortStatus({status:'running',unread:true}),'进行中','current runtime takes precedence over an older unread result');
state.connected=false;
assert.equal(ctx.shortStatus({status:'running',unread:true}),'未读','disconnected runtime is not presented as actively running');
state.connected=true;
state.threads[0].activity_excerpt='PRIVATE_BODY_SHOULD_ONLY_APPEAR_EXPANDED';
ctx.renderList(true);
assert.ok(!JSON.stringify(list).includes('PRIVATE_BODY_SHOULD_ONLY_APPEAR_EXPANDED'),'compact rows omit body entirely');
state.threads[0].task_brief='修订住房报告中的五类角色诉求';
state.threads[0].brief_status='ready';
const originalName=state.threads[0].name;
ctx.renderList(true);
const summaryRow=list.children.find(t=>t.dataset.threadId===state.threads[0].id);
assert.equal(summaryRow.children[1].children[0].children[0].textContent,originalName,'original Codex title remains visible and unchanged');
assert.equal(summaryRow.children[1].children[1].children[0].textContent,state.threads[0].task_brief,'second line explains the specific task');
assert.equal(summaryRow.children[1].children.length,2,'AI explanation keeps the compact two-line row');
assert.ok(summaryRow.title.includes('AI 摘要'),'AI source is available on hover');
assert.equal(ctx.rateText({ready:true,tokens_per_min:12000}),'12k /min');
state.connected=false;
assert.equal(ctx.rateText({ready:true,tokens_per_min:12000}),'—','offline rate is never shown as current');
assert.equal(ctx.fanPeriod(0),0);
assert.equal(ctx.fanPeriod(NaN),0);
assert.ok(ctx.fanPeriod(1000000)<ctx.fanPeriod(10000),'greater use spins faster');
assert.ok(ctx.fanPeriod(1e10)>=.55,'fan speed is visually bounded');
const fan=new Element('span'),sample={ready:true,tokens_per_min:12000};
ctx.renderTokenFan(fan,sample,true);
assert.equal(fan.dataset.spinning,'false','offline fan stops');
state.connected=true;ctx.renderTokenFan(fan,sample,true);
assert.equal(fan.dataset.spinning,'true');
ctx.renderTokenFan(fan,sample,false);
assert.equal(fan.dataset.spinning,'false','finished tasks stop even with recent usage');
ctx.renderTokenFan(fan,{ready:true,tokens_per_min:0},true);
assert.equal(fan.dataset.spinning,'false','zero usage stops without changing runtime');
ctx.renderTokenFan(fan,{ready:false,tokens_per_min:12000},true);
assert.equal(fan.dataset.spinning,'false','unknown usage stays still');
assert.equal(fan.children.length,1,'refresh reuses fan artwork');
assert.equal(fan.firstElementChild.tag,'svg','use a centered vector fan');
const [rim,rotor,hub]=fan.firstElementChild.children;
assert.equal(rim.tag,'circle');assert.equal(hub.tag,'circle');
assert.equal(rotor.attributes.class,'fan-rotor','only the blades rotate');
assert.deepEqual(rotor.children.map(b=>b.attributes.transform),['rotate(0 12 12)','rotate(120 12 12)','rotate(240 12 12)'],'three identical balanced blades');
assert.ok(!source.includes('🍌')&&!source.includes('renderBananaFan'),'superseded emoji implementation is removed');
const html=fs.readFileSync(require('node:path').join(__dirname,'../shell/index.html'),'utf8');
assert.ok(!html.includes('tokenChart')&&!source.includes('drawTokenBars'),'bar-chart presentation is removed');
assert.ok(!html.includes('suggestionSection')&&!source.includes('suggestion'),'recommendation markup, rendering and send path are removed');
assert.ok(!html.includes('id="messageInput"')&&!html.includes('id="detailView"'),'reading and replies live in Codex');
assert.ok(summaryRow.title.includes('点击在 Codex 中打开'),'rows announce their direct navigation');
assert.ok(!html.includes('编辑上面的建议'),'composer copy refers only to user input');
console.log('PASS: hover ordering, completion removal, live badges, compact AI summaries, rates, centered yellow fan and direct navigation affordance');
