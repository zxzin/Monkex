// Execute the production detail renderer with a minimal DOM and synthetic account data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),source=fs.readFileSync(path.join(root,'shell/app.js'),'utf8');
class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.attributes={};this._text='';this.hidden=false;}
  set textContent(text){this._text=String(text);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this._text='';this.children=[...nodes];}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
}
const elements=new Map(),$=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
const now=1792555200;
const initial=()=>({observed_at:now,refresh_pending:false,credit_balance:{available:true,balance:'12345.6789000000',unlimited:false},reset_cards:{available:true,available_count:3,expirations:[{count:1,expires_at:now+86400},{count:1,expires_at:null}],unlisted_count:1},windows:[{window_minutes:10080,remaining_percent:65,resets_at:now+3*86400},{window_minutes:300,remaining_percent:42,resets_at:now+3600}]});
const state={usageDetails:initial()};let resizes=0;const resizeArgs=[];
const context={state,$,Date,Number,document:{getElementById:$,createElement:tag=>new Element(tag),createTextNode:text=>{const e=new Element('#text');e.textContent=text;return e;}},syncBoardSize:(...args)=>{resizes++;resizeArgs.push(args);}};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('function quotaDetailsState('),source.indexOf('function renderQuotaFlow(')),context);
if(typeof context.setQuotaResetExpanded!=='function'){
  const start=source.indexOf('function setQuotaResetExpanded('),end=source.indexOf('\nfunction ',start+1);
  assert.ok(start>=0,'reset disclosure has a canonical state setter');
  vm.runInContext(source.slice(start,end<0?source.length:end),context);
}
const render=()=>context.renderQuotaDetails(now);
context.setQuotaResetExpanded(false);
render();assert.equal($('creditBalanceValue').textContent,'12,345.68');assert.equal($('resetCardCount').textContent,'3');
assert.equal($('quotaResetWindows').hidden,true,'reset times begin collapsed');
assert.equal($('quotaResetToggle').getAttribute('aria-expanded'),'false');assert.match($('quotaResetToggle').title,/展开.*重置/);
const beforeExpand=resizes;context.setQuotaResetExpanded(true);
assert.equal($('quotaResetWindows').hidden,false);assert.equal($('quotaResetToggle').getAttribute('aria-expanded'),'true');
assert.match($('quotaResetToggle').title,/收起.*重置/);assert.ok(resizes>beforeExpand,'expanded reset times recalculate the native board height');
assert.deepEqual(resizeArgs.at(-1),[false,false],'disclosure resizing preserves native focus');
render();assert.equal($('quotaResetWindows').hidden,false,'quota refresh preserves disclosure state');
context.setQuotaResetExpanded(false);render();assert.equal($('quotaResetWindows').hidden,true,'rendering preserves the collapsed state');
assert.equal($('quotaDetails').dataset.state,'current');assert.equal($('quotaDetailsStatus').hidden,true);
assert.equal($('quotaResetWindows').children.length,2);assert.match($('quotaResetWindows').textContent,/周额度重置/);assert.match($('quotaResetWindows').textContent,/5 小时额度重置/);
assert.equal($('quotaResetWindows').children[0].children[1].children[0].dateTime,new Date((now+3*86400)*1000).toISOString());
assert.equal($('resetCardExpirations').children.length,3);assert.match($('resetCardExpirations').textContent,/无到期时间/);assert.match($('resetCardExpirations').textContent,/有效期待同步/);
assert.equal($('resetCardNextExpiry').textContent,'到期 '+context.quotaLocalTime(now+86400),'inline expiry uses a compact prefix and date');
assert.equal($('resetCardNextExpiry').title,'最近到期 '+context.quotaLocalTime(now+86400,true),'full expiry timestamp remains available in the tooltip');
state.usageDetails.credit_balance.balance='0';state.usageDetails.reset_cards={available:true,available_count:0,expirations:[],unlisted_count:0};render();
assert.equal($('creditBalanceValue').textContent,'0');assert.equal($('resetCardCount').textContent,'0');assert.match($('resetCardNextExpiry').textContent,/暂无可用/);
state.usageDetails.credit_balance={available:true,balance:null,unlimited:true};render();assert.equal($('creditBalanceValue').textContent,'不限额');
state.usageDetails=initial();state.usageDetails.credit_balance.available=false;state.usageDetails.reset_cards.available=false;render();
assert.equal($('creditBalanceValue').textContent,'—');assert.equal($('resetCardCount').textContent,'—');
assert.equal($('resetCardNextExpiry').textContent,'待同步','unknown card counts retain an explicit sync hint');
for(const value of [null,undefined,'',true,12,-1,'-1','Infinity','NaN','1e3','<script>1</script>'])assert.equal(context.formatQuotaBalance(value),null,`reject invalid balance ${value}`);
assert.equal(context.formatQuotaBalance('0.005'),'0.01');assert.equal(context.formatQuotaBalance('1000000'),'1,000,000');
for(const observed of [now-91,now+31,NaN,Infinity,'1792555200',null]){
  state.usageDetails={...initial(),observed_at:observed};render();
  assert.equal($('creditBalanceValue').textContent,'—');assert.equal($('resetCardCount').textContent,'—');assert.equal($('quotaDetails').dataset.state,'unknown');
  assert.equal($('quotaResetWindows').children.length,1);assert.match($('quotaResetWindows').textContent,/待同步/);
}
for(const observed of [now-90,now+30])assert.equal(context.quotaDetailsState({...initial(),observed_at:observed},now).fresh,true);
state.usageDetails=initial();state.usageDetails.refresh_pending=true;render();
assert.equal($('creditBalanceValue').textContent,'12,345.68');assert.equal($('quotaDetailsStatus').hidden,false);assert.equal($('quotaDetails').dataset.state,'pending');assert.match($('quotaDetailsStatus').textContent,/正在重试同步/);
state.usageDetails=initial();state.usageDetails.windows.push({window_minutes:60,resets_at:now+3600});render();assert.equal($('quotaResetWindows').children.length,2,'only known core windows shown');
state.usageDetails.reset_cards={available:true,available_count:5,expirations:[{count:2,expires_at:now+86400}],unlisted_count:3};render();
assert.equal($('resetCardCount').textContent,'5');assert.equal($('resetCardExpirations').children.length,2);assert.match($('resetCardExpirations').children[1].textContent,/×3有效期待同步/,'capped detail list does not replace total card count');
state.usageDetails.reset_cards={available:true,available_count:1,expirations:[{count:1,expires_at:null}],unlisted_count:0};render();assert.equal($('resetCardNextExpiry').textContent,'无到期时间');
state.usageDetails=null;render();assert.equal($('creditBalanceValue').textContent,'—');assert.equal($('resetCardCount').textContent,'—');
assert.equal(context.quotaCountdown(now,now),'等待重置同步');assert.equal(context.quotaCountdown(now+1,now),'1 分钟后');assert.equal(context.quotaCountdown(now+3600,now),'1 小时后');assert.equal(context.quotaCountdown(now+86400,now),'1 天 0 小时后');
assert.ok(resizes>0,'detail rendering recalculates board height');
const html=fs.readFileSync(path.join(root,'shell/index.html'),'utf8');
assert.match(html,/<details id="resetCardDetails"/);assert.match(html,/<summary(?:\s[^>]*)?>/);assert.match(html,/id="resetCardExpirations"/);
const weeklyHtml=html.slice(html.indexOf('id="weeklyQuota"'),html.indexOf('id="pinButton"'));
const toggleHtml=weeklyHtml.match(/<button\b[^>]*id="quotaResetToggle"[^>]*>[\s\S]*?<\/button>/)?.[0];
assert.ok(toggleHtml,'weekly remaining amount has its own native disclosure button');
assert.match(toggleHtml,/aria-expanded="false"/);assert.match(toggleHtml,/aria-controls="quotaResetWindows"/);assert.match(toggleHtml,/id="weeklyRemaining"/);
assert.ok(!toggleHtml.includes('quotaCoinButton'),'coin refresh is a sibling button, preserving independent action targets');
assert.match(weeklyHtml.slice(weeklyHtml.indexOf(toggleHtml)+toggleHtml.length),/id="quotaCoinButton"/);
assert.match(html,/<div\b[^>]*id="quotaResetWindows"[^>]*\bhidden(?:\s|>)/,'reset time rows stay hidden before JavaScript starts');
assert.ok(html.indexOf('id="quotaResetWindows"')<html.indexOf('id="resetCardDetails"'),'reset rows belong above the balance and card disclosure');
const detailsHtml=html.slice(html.indexOf('<details id="resetCardDetails"'),html.indexOf('</details>'));
const expiryPosition=detailsHtml.indexOf('id="resetCardNextExpiry"'),overviewPosition=detailsHtml.indexOf('class="reset-card-overview"'),headingPosition=detailsHtml.indexOf('class="reset-card-heading"');
assert.ok(overviewPosition<expiryPosition&&expiryPosition<headingPosition&&headingPosition<detailsHtml.indexOf('</summary>'),'nearest expiry precedes the reset count in the compact summary');
assert.equal((detailsHtml.match(/id="resetCardNextExpiry"/g)||[]).length,1,'summary owns one expiry hint without duplicate expanded content');
const toggleBinding=source.split('\n').find(line=>line.includes('$("quotaResetToggle").onclick'));
assert.ok(toggleBinding&&toggleBinding.includes('setQuotaResetExpanded'),'disclosure button uses the canonical state setter');
assert.ok(!toggleBinding.includes('refresh'),'opening reset times performs no refresh request');
vm.runInContext(toggleBinding,context);
context.setQuotaResetExpanded(false);$('quotaResetToggle').onclick();assert.equal($('quotaResetWindows').hidden,false,'first click expands reset times');
$('quotaResetToggle').onclick();assert.equal($('quotaResetWindows').hidden,true,'second click collapses reset times');
assert.ok(!/consume_usage_reset|redeem|purchase/.test(source),'display-only additions cannot spend reset cards or purchase credits');
console.log('PASS: quota balance/card/reset rendering, default-collapsed reset disclosure, ARIA, independent coin refresh, preserved view state and adaptive height.');
