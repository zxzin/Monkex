// Color roles remain independent of task routing and preserve compact readability.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const css=fs.readFileSync(path.join(__dirname,'../shell/styles.css'),'utf8');
for(const [name,hex] of Object.entries({ink:'171512',white:'ffffff',paper:'f7faff',red:'e7372f',yellow:'ffd33d',blue:'2477ff',green:'16b35c'})){
  assert.match(css,new RegExp(`--zinx-${name}:#${hex}`));
}
assert.match(css,/\.weekly-quota\[data-state=low\]\{background:var\(--red-soft\)/);
assert.ok(css.includes('.pin-button[aria-pressed=true] .pin-head{fill:var(--yellow)}'));
assert.match(css,/\.task-button\[data-status=unread\] \.row-status\{color:var\(--yellow-ink\)/);
assert.match(css,/\.task-button\[data-status=running\] \.row-status\{color:var\(--green-ink\)/);
assert.match(css,/\.task-button\[data-status=unread\]\{background:var\(--yellow-soft\)/);
assert.match(css,/\.task-button\[data-status=running\]\{background:var\(--green-soft\)/);
assert.ok(!css.includes('var(--blue'),'active theme uses fruit and leaf roles');
assert.match(css,/--glass:rgba\(242,248,237,\.92\)/);
assert.match(css,/\.pet-quota strong\{[^}]*color:var\(--green-ink\)/);
assert.match(css,/\.task-button\{[^}]*min-height:42px/);
assert.match(css,/--pixel-corners:polygon/);
const ripeSize=Number(css.match(/--banana-ripe-size:(\d+)px/)[1]),unripeSize=Number(css.match(/--banana-unripe-size:(\d+)px/)[1]);
assert.equal(ripeSize,16);assert.equal(unripeSize,12);assert.ok(unripeSize<ripeSize,'growing green bananas are smaller than ripe fruit');
assert.match(css,/--banana-green-image:url\('[^']*pixel-banana-green-v1\.png'\)/);
assert.match(css,/\.task-button\[data-status=running\] \.task-state\{--banana-sprite:var\(--banana-green-image\);--banana-size:var\(--banana-unripe-size\)/);
assert.match(css,/\.task-button\[data-status=running\] \.task-state,\.app-shell \.task-button\[data-status=unread\] \.task-state\{height:16px;margin-top:0\}/);
assert.match(css,/\.task-button\[data-status=running\] \.task-state::before,\.app-shell \.task-button\[data-status=unread\] \.task-state::after\{[^}]*left:50%;top:50%;[^}]*margin-left:calc\(var\(--banana-size\) \* -.5\);margin-top:calc\(var\(--banana-size\) \* -.5\)/);
assert.match(css,/\.task-button\[data-status=running\] \.task-state::before\{[^}]*animation:banana-growing 2.2s steps\(4,end\)/);
assert.match(css,/@keyframes banana-growing\{0%,100%\{transform:translateY\(0\) rotate\(-5deg\)\}35%\{transform:translateY\(-1px\) rotate\(5deg\)/);
assert.ok(!/task-running|hourglass-grain|running-hourglass|energy-work|energy-pixels|running-energy/.test(css),'superseded loaders have no live style path');
const greenBanana=fs.readFileSync(path.join(__dirname,'../shell/assets/monkey-banana-2026-09-07/pixel-banana-green-v1.png'));
assert.equal(greenBanana.subarray(1,4).toString(),'PNG');
assert.equal(greenBanana[25],6,'ImageGen green fruit retains RGBA transparency');
assert.ok(!greenBanana.equals(fs.readFileSync(path.join(__dirname,'../shell/assets/monkey-banana-2026-09-07/pixel-banana-v4-diagonal.png'))),'running green fruit and unread ripe fruit use distinct assets');
assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{\.task-button\[data-status=running\] \.task-state::before\{transform:none\}/);
assert.match(css,/\.task-button\[aria-pressed=true\] \.task-copy strong::before/);
assert.ok(!css.includes('#newTaskButton'));
assert.match(css,/@supports \(backdrop-filter:blur\(1px\)\)/);
assert.match(css,/@media\(prefers-reduced-transparency:reduce\).*background:#fff!important/);
assert.match(css,/@media\(prefers-reduced-motion:reduce\).*animation:none!important/);
const luminance=hex=>hex.match(/../g).map(x=>parseInt(x,16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0);
for(const [fg,bg] of [['23673b','cce8d2'],['725300','ffe89a'],['b32923','ffefed'],['725300','ffd33d'],['183b27','fff6d6'],['183b27','e5f4e8'],['53694e','fff6d6'],['53694e','e5f4e8'],['5b7160','f2f8ed'],['52643a','e7edd7'],['52694f','f2f8ed']]){
  const l=[luminance(fg),luminance(bg)].sort((a,b)=>b-a);
  assert.ok((l[0]+.05)/(l[1]+.05)>=4.5,`${fg} on ${bg} maintains small-text contrast`);
}
const play=fs.readFileSync(path.join(__dirname,'../shell/read-play.js'),'utf8');
assert.ok(play.includes("'--spark-color':['var(--yellow)','var(--green)'"),'harvest particles follow the theme');
console.log('PASS: banana/leaf theme, distinct fruit/running/read roles, small-text contrast, compact scale and accessibility fallbacks');
