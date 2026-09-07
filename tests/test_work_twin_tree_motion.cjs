// One physical canopy and one cycle keep landings, branch load and fruit response in sync.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8'),css=read('shell/styles.css');
assert.match(css,/--banana-tree-image:url\('[^']*banana-tree.png'\)/);
assert.match(css,/@supports\(clip-path:polygon\(0 0,100% 0,100% 100%\)\)\{\s*\.banana-tree-art>img\{clip-path:/,'unsupported browsers keep the intact tree');
assert.match(css,/\.tree-canopy\{[^}]*pointer-events:none;[^}]*transform-origin:52% 61%/);
assert.match(css,/\.banana-tree-art\{[^}]*--tree-cycle:9s/);
for(const animation of ['branch-load','branch-peek','branch-pose','harvest-settle'])assert.ok(css.includes('animation:'+animation+' var(--tree-cycle)'),animation+' shares the master cycle');
for(const obsolete of ['tree-working','canopy-breeze','fruit-sway','--fruit-delay'])assert.ok(!css.includes(obsolete),'remove independent clock '+obsolete);
function keyframes(name){const start=css.indexOf('@keyframes '+name+'{');assert.ok(start>=0);let depth=1,i=css.indexOf('{',start)+1,body='';for(;depth&&i<css.length;i++){const c=css[i];if(c==='{')depth++;if(c==='}')depth--;if(depth)body+=c;}return body;}
const movement=keyframes('branch-peek'),load=keyframes('branch-load'),fruit=keyframes('harvest-settle'),pose=keyframes('branch-pose');
assert.match(movement,/46%\{transform:translate\(38px,4px\)/);
assert.match(load,/46%\{transform:rotate\(2.2deg\)/,'right landing loads the branch in the same frame');
assert.match(fruit,/48%\{transform:rotate\(1.4deg\)/,'fruit follows right landing by 180ms');
assert.match(movement,/88%\{transform:translate\(5px,4px\)/);
assert.match(load,/88%\{transform:rotate\(-2.2deg\)/,'left landing loads the branch in the same frame');
assert.match(fruit,/90%\{transform:rotate\(-1.4deg\)/,'fruit follows left landing by 180ms');
assert.match(pose,/34%,46%,74%,88%\{background-position:-28px 0\}/,'crouch frame covers takeoff and impact');
assert.match(css,/\.tree-fruit,\.tree-green-fruit\{[^}]*transform:rotate\(var\(--fruit-angle\)\)/,'newly visible fruit inherits the live group response without restarting it');
for(const selector of ['html[data-page-hidden=true] :is(.tree-canopy,.tree-harvest,.tree-growth)','.pet-mode[data-mode=compact] :is(.tree-canopy,.tree-harvest,.tree-growth)'])assert.ok(css.includes(selector),'pause path: '+selector);
assert.match(css,/@media\(prefers-reduced-motion:reduce\)\{\*,\*::before,\*::after\{animation:none!important/);
assert.match(css,/\.tree-harvest\[data-connected=true\] \.tree-fruit::before\{[^}]*animation:fruit-ready/,'the unread glow remains independent of runtime');
assert.equal((css.match(/--fruit-angle:[^;}]*/g)||[]).length,8,'each bounded fruit has a static angle');
assert.match(read('shell/index.html'),/class="tree-canopy">\s*<span class="tree-companion"/,'monkey is attached to the moving canopy');
console.log('PASS: shared canopy/cycle, matched left/right landings, delayed fruit response, pauses and static fallbacks');
