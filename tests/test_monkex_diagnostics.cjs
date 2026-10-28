// Exercise the shipped health renderer with synthetic reports and no Codex access.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'shell/app.js'),'utf8');
class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this._text='';this.hidden=false;this.scrollTop=0;}
  set textContent(text){this._text=String(text);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this._text='';this.children=[...nodes];}
  setAttribute(name,value){this.attributes[name]=String(value);}
}
const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
const now=1792641600,fixture=()=>({observed_at:now,data_state:'current',running_tasks:5,
  score:{value:86,grade:'good',confidence:'short_check',sample_count:18,round_count:6,success_percent:100,p50_ms:120,p95_ms:220,jitter_ms:100,components:{reliability:60,latency:20,stability:6},notes:['public_path_only','short_check_only'],scope:'public_path',codex_observed:true},
  operational:{state:'quiet',level:'notice',code:'quiet',affected_tasks:4,active_tasks:1,quiet_tasks:4,unknown_tasks:0,tool_tasks:1,starting_tasks:3,issue_tasks:0,evidence:['recent_runtime_activity','runtime_quiet','tool_pending'],score_scope:'public_path'},
  activity:{state:'quiet',last_activity_at:now-4,quiet_tasks:4,total_tokens_per_min:12000,output_tokens_per_min:400},
  tasks:[{name:'Active task',phase:'thinking',activity_age_seconds:4,signal:'active',output_tokens_per_min:400,report_age_seconds:10},...Array.from({length:4},(_,i)=>({name:'Quiet task '+i,phase:i===0?'tool':'starting',pending_tools:i===0?1:0,activity_age_seconds:240,signal:'quiet',output_tokens_per_min:0,report_age_seconds:240}))],
  network:{checked_at:now,route:'system_proxy',exit:{state:'observed',country_code:'JP',edge_code:'NRT',checked_at:now},rounds_completed:6,rounds_planned:6,checks:[{id:'general',state:'reachable',latency_ms:41},{id:'codex',state:'reachable',latency_ms:158},{id:'api',state:'reachable',latency_ms:126},{id:'auth',state:'reachable',latency_ms:115}]},
  official:{state:'operational',checked_at:now,components:[],incidents:[]},assessment:{level:'notice',code:'quiet'}});
const state={diagnostics:fixture(),diagnosticsFailed:false,diagnosticsBusy:false};let resizes=0;
const context={state,$,Date,Number,document:{createElement:tag=>new Element(tag)},syncBoardSize:()=>resizes++};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function node('),source.indexOf('function shortStatus(')),context);
vm.runInContext(source.slice(source.indexOf('function formatRate('),source.indexOf('function rateText(')),context);
vm.runInContext(source.slice(source.indexOf('function healthAge('),source.indexOf('function activityTime(')),context);
const render=()=>context.renderDiagnostics(now);
const tiers=[
  {min:95,max:100,key:'excellent',label:'极佳',name:'极佳连接'},
  {min:85,max:94,key:'smooth',label:'流畅',name:'流畅连接'},
  {min:70,max:84,key:'steady',label:'平稳',name:'平稳连接'},
  {min:60,max:69,key:'mixed',label:'波动',name:'连接有波动'},
  {min:0,max:59,key:'poor',label:'不稳',name:'连接不稳定'}
];
const tierReading=(value,pending)=>{
  const tier=value===null?null:tiers.find(item=>Math.round(value)>=item.min&&Math.round(value)<=item.max);
  assert.equal($('healthBadgeTier').textContent,tier?tier.label:pending);
  assert.equal($('healthTierRange').textContent,tier?tier.min+'–'+tier.max+' 分':'');
  if(tier)assert.equal($('healthTierName').textContent,tier.name);
  const rows=$('healthTierScale').children;
  assert.deepEqual(rows.map(row=>row.dataset.tier),tiers.map(item=>item.key),'all five score bands stay in descending order');
  assert.deepEqual(rows.map(row=>row.textContent),tiers.map(item=>item.label+item.min+'–'+item.max));
  assert.deepEqual(rows.filter(row=>row.attributes['aria-current']==='true').map(row=>row.dataset.tier),tier?[tier.key]:[],'only the current rounded-score band is highlighted');
};
const connectionScore=(value,scoreLevel=value===null?'unknown':{good:'ok',fair:'notice',poor:'warning'}[state.diagnostics?.score?.grade])=>{
  assert.equal($('healthScoreValue').textContent,value===null?'—':value+' /100');
  assert.equal($('healthBadgeValue').textContent,value===null?'—':String(value),'the compact header keeps the numeric public-path reading visible');
  assert.equal($('runtimeHealthToggle').dataset.scoreLevel,scoreLevel,'connection color follows its own score');
  assert.ok($('runtimeHealthToggle').attributes['aria-label'].includes('公共连接质量 · '+(value===null?'—':value+' /100')),'the accessible name includes the connection reading');
};
const operational=(level,showAlert,label)=>{
  assert.equal($('runtimeHealth').dataset.level,level);assert.equal($('runtimeHealthToggle').dataset.level,level);
  assert.equal($('healthRuntimeAlert').hidden,!showAlert,'task concerns retain a separate visible marker');
  assert.equal($('healthRuntimeAlert').dataset.level,level);
  assert.ok($('runtimeHealthToggle').attributes['aria-label'].includes('Codex 健康度 · '+$('healthSummary').textContent),'the accessible name independently includes the runtime state');
  if(label)assert.match($('healthSummary').textContent,label);
};
render();
operational('notice',true,/待确认|静默/);connectionScore(86);
tierReading(86);assert.match($('healthScoreReason').textContent,/持续交互.*任务活动/);
assert.match($('healthOperationalReason').textContent,/任务|活动|静默/);assert.doesNotMatch($('runtimeHealthToggle').attributes['aria-label'],/短测完成/,'sampling confidence stays in the details');
assert.match($('healthTaskSummary').textContent,/4 项静默/,'a busy task must not hide four quiet tasks');
assert.equal($('healthTotalRate').textContent,'12k');
assert.match($('healthAssessment').textContent,/部分任务/);assert.equal($('healthTaskList').children.length,5);
assert.match($('healthTaskList').textContent,/工具活动/);assert.match($('healthTaskList').textContent,/4 分钟前/);
assert.match($('healthGeneralNetwork').textContent,/可达 · 41 ms/);assert.match($('healthCheckTime').title,/系统代理/);
state.diagnostics.activity.output_tokens_per_min=0;render();assert.equal($('healthOutputRate').textContent,'0','measured zero remains zero');
state.diagnostics.activity.output_tokens_per_min=null;render();assert.equal($('healthOutputRate').textContent,'—','unknown output remains unknown');connectionScore(86);operational('notice',true);
state.diagnostics={...fixture(),data_state:'stale'};render();assert.equal($('healthTotalRate').textContent,'—');connectionScore(86);operational('unknown',true);
for(const overrides of [{observed_at:now-31},{observed_at:now+31},{observed_at:null}]){
  state.diagnostics={...fixture(),...overrides};render();connectionScore(null);assert.equal($('healthTotalRate').textContent,'—');operational('unknown',true);
}
for(const [value,grade]of [[0,'poor'],[65,'fair'],[100,'good']]){state.diagnostics=fixture();state.diagnostics.score={...state.diagnostics.score,value,grade};render();connectionScore(value);operational('notice',true);}
for(const value of [0,59,60,69,70,84,85,94,95,100,94.6]){
  state.diagnostics=fixture();state.diagnostics.score={...state.diagnostics.score,value,grade:value>=85?'good':value>=60?'fair':'poor'};
  render();connectionScore(Math.round(value));tierReading(value);operational('notice',true);
}
for(const value of [-1,101,NaN,Infinity,'86']){state.diagnostics=fixture();state.diagnostics.score.value=value;render();connectionScore(null);operational('notice',true);}
for(const [status,level,code,showAlert,label]of [['active','ok','active',false,/健康|正常|活跃/],['tool_running','ok','tool_running',false,/工具/],['tool_running','notice','tool_wait',true,/等待工具/],['waiting','notice','awaiting_response',true,/等待|待响应/],['unknown','unknown','activity_unconfirmed',true,/待同步|待确认|未知/],['error','error','recent_connection_error',true,/异常|故障/],['idle','ok','idle',false,/空闲|待机/]]){
  state.diagnostics=fixture();state.diagnostics.score.value=100;state.diagnostics.operational={...state.diagnostics.operational,state:status,level,code};render();connectionScore(100);operational(status==='error'?'warning':status==='idle'?'unknown':level,showAlert,label);
}
state.diagnostics=fixture();state.diagnostics.score.value=null;state.diagnostics.score.grade='collecting';state.diagnostics.score.confidence='collecting';render();connectionScore(null);tierReading(null,'采样中');assert.equal($('healthTierName').textContent,'等待评分');operational('notice',true);
state.diagnostics.network.stale=true;state.diagnostics.network.checked_at=null;render();operational('notice',true);assert.doesNotMatch($('healthScoreReason').textContent,/过期/,'a first check has no expired observation');
state.diagnostics=fixture();state.diagnostics.score.grade='stale';render();connectionScore(null);tierReading(null,'重测');assert.equal($('healthTierName').textContent,'采样已过期');operational('notice',true);assert.match($('healthScoreReason').textContent,/过期/);
state.diagnostics.network.stale=true;state.diagnosticsResetting=true;render();connectionScore(null);tierReading(null,'采样中');assert.equal($('healthTierName').textContent,'等待评分');assert.doesNotMatch($('healthScoreReason').textContent,/过期/);assert.match($('healthScoreProgress').textContent,/新一轮/);state.diagnosticsResetting=false;
state.diagnostics.network.route_generation=2;state.diagnostics.network.node_changed_at=now;state.diagnostics.score={...state.diagnostics.score,value:null,grade:'collecting',sample_count:0,round_count:0};state.diagnostics.network.rounds_completed=0;render();assert.equal($('healthScoreValue').textContent,'—');assert.match($('healthScoreProgress').textContent,/0\/6.*统计已重置/);
state.diagnostics=fixture();state.diagnosticsFailed=true;render();connectionScore(null);tierReading(null,'同步中');operational('unknown',true,/待同步|待确认|未知/);
state.diagnosticsFailed=false;state.diagnostics.network.checking=true;render();assert.equal($('healthCheckButton').disabled,true);
state.diagnostics.network.checking=false;render();assert.equal($('healthCheckButton').disabled,false);
state.diagnostics.network.blocked=true;render();assert.equal($('healthCheckButton').disabled,true);assert.equal($('healthCheckButton').attributes['aria-busy'],'false');assert.match($('healthCheckTime').textContent,/检测超时/);
state.diagnostics.network.blocked=false;
state.diagnostics.official={state:'degraded',stale:true,incidents:[{name:'<img src=x onerror=alert(1)>'}]};
state.diagnostics.tasks[0].name='<script>alert(1)</script>';render();
assert.match($('healthOfficial').textContent,/<img src=x onerror=alert\(1\)>/);assert.match($('healthTaskList').textContent,/<script>/,'external strings remain inert text nodes');
assert.equal(context.healthPhase('response'),'输出');assert.equal(context.healthPhase('starting'),'启动');assert.equal(context.healthPhase('unrecognized'),'类型未知');
assert.match(context.healthNetworkText({state:'http_error',http_status:403,latency_ms:81}),/HTTP 响应.*403/,'HTTP denial is a response, not a speed result');
assert.equal(context.healthNetworkText(null),'未检测');assert.equal(context.healthAge(null),'未知');
state.diagnostics=fixture();state.diagnostics.assessment={level:'notice',code:'endpoint_response'};state.diagnostics.official.components=[{name:'Codex',status:'degraded_performance'}];render();
assert.match($('healthAssessment').textContent,/连接已建立.*HTTP/);assert.equal($('healthOfficialComponents').textContent,'Codex · 性能下降');
state.diagnostics=fixture();state.diagnostics.score={...state.diagnostics.score,value:100,notes:['official_codex_outage']};state.diagnostics.operational={...state.diagnostics.operational,state:'error',level:'error',code:'recent_connection_error'};state.diagnostics.official={state:'degraded',components:[{name:'Codex',status:'major_outage'}],incidents:[]};render();
connectionScore(100);tierReading(100);operational('warning',true,/异常/);assert.match($('healthScoreReason').textContent,/^官方报告 Codex 服务中断。.*模型排队、思考和工具执行/s,'official trouble appears before the high-score interpretation');assert.match($('healthOfficial').textContent,/异常/);assert.equal($('healthOfficialComponents').textContent,'Codex · 服务中断');
state.diagnostics=null;render();connectionScore(null);tierReading(null,'同步中');operational('unknown',true,/待同步|待确认|未知/);assert.equal($('healthCheckButton').disabled,false);
assert.ok(resizes>0);
const html=fs.readFileSync(path.join(root,'shell/index.html'),'utf8');
assert.match(html,/<section id="runtimeHealth"[^>]*\bhidden(?:\s|>)/,'health details begin hidden');
const healthToggle=html.match(/<button\b[^>]*id="runtimeHealthToggle"[^>]*>/)?.[0];
assert.ok(healthToggle,'health opens through a native button');assert.match(healthToggle,/aria-expanded="false"/);assert.match(healthToggle,/aria-controls="runtimeHealth"/);
assert.match(html,/<svg\b[^>]*class="health-heart"[^>]*aria-hidden="true"[^>]*>[\s\S]*?<\/svg>/,'the selected pixel-heart treatment uses a dedicated decorative SVG');
assert.match(html,/<span\b[^>]*class="health-reading"[^>]*>[\s\S]*?id="healthBadgeValue"[\s\S]*?<\/span><span id="healthBadgeTier" class="health-caption">同步中</,'the numeric reading and the full-width connection-tier caption remain separate');
assert.match(html,/<ol\b[^>]*id="healthTierScale"[^>]*aria-label="连接分数档位"/,'score interpretation has an accessible ordered scale');
assert.match(html,/id="healthRuntimeAlert"/,'runtime concerns retain their own marker');assert.doesNotMatch(html,/health-eyes|health-ring|healthStatusSymbol/,'superseded eye and ring treatments are removed');
assert.ok(html.indexOf('id="healthBadgeValue"')<html.indexOf('</header>'));assert.ok(html.indexOf('id="healthScoreValue"')>html.indexOf('id="runtimeHealth"'),'the detailed score retains its full scale inside health details');
assert.ok(html.indexOf('id="runtimeHealthToggle"')<html.indexOf('</header>'),'health badge belongs beside the quota in the top bar');
assert.ok(html.indexOf('id="quotaDetails"')<html.indexOf('id="runtimeHealth"')&&html.indexOf('id="runtimeHealth"')<html.indexOf('id="feedView"'));
assert.ok(source.indexOf('refreshDiagnostics();\n  state.diagnosticsTimer')<source.indexOf('  await refresh();'),'diagnostics start independently of task sync');
const healthSource=source.slice(source.indexOf('function healthAge('),source.indexOf('function activityTime('));
assert.doesNotMatch(healthSource,/innerHTML|selectThread|navigate\(|ack|readPlay/,'health monitoring stays read-only toward tasks');
const englishSource=fs.readFileSync(path.join(root,'shell/en/app.js'),'utf8'),englishElements=new Map(),english$=id=>{if(!englishElements.has(id))englishElements.set(id,new Element());return englishElements.get(id);};
const englishState={diagnostics:fixture(),diagnosticsFailed:false,diagnosticsBusy:false};
const englishContext={state:englishState,$:english$,Date,Number,document:{createElement:tag=>new Element(tag)},syncBoardSize:()=>{}};vm.createContext(englishContext);
for(const [start,end]of [['function node(','function shortStatus('],['function formatRate(','function rateText('],['function healthAge(','function activityTime(']])vm.runInContext(englishSource.slice(englishSource.indexOf(start),englishSource.indexOf(end)),englishContext);
for(const [value,label]of [[0,'Poor'],[59,'Poor'],[60,'Mixed'],[69,'Mixed'],[70,'Steady'],[84,'Steady'],[85,'Smooth'],[94,'Smooth'],[95,'Prime'],[100,'Prime'],[94.6,'Prime']]){
  englishState.diagnostics=fixture();englishState.diagnostics.score.value=value;englishContext.renderDiagnostics(now);
  assert.equal(english$('healthBadgeValue').textContent,String(Math.round(value)));assert.equal(english$('healthBadgeTier').textContent,label);
  assert.equal(english$('healthTierScale').children.filter(row=>row.attributes['aria-current']==='true').length,1);
  assert.doesNotMatch([...englishElements.values()].map(element=>element.textContent).join(' '),/[\u3400-\u9fff]/,'English health rendering contains no untranslated Chinese');
}
function verifyExit(runtime,model,select,lang){
  const exitText=()=>select('healthExitRegion').textContent;
  const reset=()=>{model.diagnostics=fixture();model.diagnosticsFailed=false;model.diagnosticsResetting=false;};
  const draw=()=>runtime.renderDiagnostics(now),exitLabel=lang==='en'?'Japan · JP':'日本 · JP';
  reset();draw();
  assert.equal(exitText(),exitLabel);assert.match(select('healthExitRegion').title,/NRT/);assert.match(select('healthExitInfo').title,lang==='en'?/probe.*Codex/i:/检测.*Codex/,'the observed region is scoped to the probe path');
  for(const mutate of [data=>{data.network.stale=true;},data=>{data.network.exit.checked_at=now-301;},data=>{data.network.exit.checked_at=now+31;},data=>{data.observed_at=now-31;},data=>{data.data_state='stale';},data=>{data.network.exit.state='stale';},data=>{data.network.exit.state='unknown';}]){
    reset();mutate(model.diagnostics);draw();assert.doesNotMatch(exitText(),/JP|日本|Japan/,'expired, unknown or unsynchronized exit observations are cleared');assert.equal(select('healthExitRegion').title,'');
  }
  for(const flag of ['diagnosticsFailed','diagnosticsResetting']){
    reset();model[flag]=true;draw();assert.doesNotMatch(exitText(),/JP|日本|Japan/,'failure and retest clear the previous exit immediately');assert.equal(select('healthExitRegion').title,'');
  }
  for(const country of ['<img src=x onerror=alert(1)>','JP\n','\u202eJP','jp',null,123]){
    reset();model.diagnostics.network.exit.country_code=country;model.diagnostics.network.exit.edge_code='<svg onload=alert(1)>';draw();
    assert.doesNotMatch(exitText(),/<|>|JP|日本|Japan|\u202e|\n/,'invalid country codes remain unavailable rather than rendering untrusted content');assert.equal(select('healthExitRegion').children.length,0);assert.equal(select('healthExitRegion').title,'');
  }
  reset();delete model.diagnostics.network.exit;draw();assert.doesNotMatch(exitText(),/JP|日本|Japan|直连|direct connection/i);
  if(lang==='en')assert.doesNotMatch(exitText()+' '+select('healthExitInfo').title,/[\u3400-\u9fff]/);
  reset();draw();
}
verifyExit(context,state,$,'zh');verifyExit(englishContext,englishState,english$,'en');
console.log('PASS: bilingual observed-exit freshness and invalid-code safety, five connection tiers, rounded boundaries, independent runtime/official alerts, recovery semantics and independent polling.');
