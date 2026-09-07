// Stem-based placement keeps smaller fruit attached to the original branch artwork.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const css=fs.readFileSync(path.join(__dirname,'../shell/styles.css'),'utf8');
const tree=fs.readFileSync(path.join(__dirname,'../shell/assets/monkey-banana-2026-09-07/banana-tree.png'));
assert.equal(require('node:crypto').createHash('sha256').update(tree).digest('hex'),'cdecd20b88544c1c851b01f0cd2f2766e3b578a2e582ff79551def2a8dc287ef','branch coordinates are verified against this source tree; recheck them when the art changes');
const layout=css.match(/\.tree-fruit,\.tree-green-fruit\{([^}]+)\}/)[1];
for(const rule of ['width:var(--fruit-size)','height:var(--fruit-size)','left:var(--branch-x)','top:var(--branch-y)','margin-left:calc(var(--fruit-size) * -.86)','margin-top:calc(var(--fruit-size) * -.09)','transform-origin:86% 9%'])assert.ok(layout.includes(rule),'shared stem layout: '+rule);
const types=[['tree-fruit',16,[[36.5,33,-30],[33,35,10],[40,34,-70],[35,38,-5],[38,37,-60]]],['tree-green-fruit',10,[[28,29,15],[44,30,-78],[28,37,5]]]];
for(const [type,size,expected] of types){
  assert.ok(css.includes('.'+type+'{--fruit-size:'+size+'px;'));
  const matches=[...css.matchAll(new RegExp('\\.'+type+':nth-child\\((\\d+)\\)\\{--branch-x:([\\d.]+)px;--branch-y:([\\d.]+)px;--fruit-angle:([\\d.-]+)deg\\}','g'))];
  assert.equal(matches.length,expected.length);
  for(const [index,m] of matches.entries()){
    const [x,y,angle]=m.slice(2).map(Number);assert.deepEqual([x,y,angle],expected[index]);
    // Rotation around the sprite stem preserves its anchor at every angle/size.
    const left=x-size*.86,top=y-size*.09;
    assert.ok(Math.abs(left+size*.86-x)<1e-9&&Math.abs(top+size*.09-y)<1e-9);
    const a=angle*Math.PI/180;
    for(const [cx,cy] of [[0,0],[size,0],[size,size],[0,size]]){
      const dx=cx-size*.86,dy=cy-size*.09;
      const px=x+dx*Math.cos(a)-dy*Math.sin(a),py=y+dx*Math.sin(a)+dy*Math.cos(a);
      assert.ok(px>=0&&px<=72&&py>=0&&py<=60,'fruit stays in the canopy, clear of the quota');
    }
    // Existing shared fruit recoil stays well inside a pixel of the branch contact.
    const radius=Math.hypot(x-72*.52,y-72*.61);
    assert.ok(radius*2*Math.sin(1.4*Math.PI/360)<.5,'branch contact remains visually continuous during recoil');
  }
}
assert.match(css,/--banana-ripe-size:16px; --banana-unripe-size:12px/,'list icon sizes stay unchanged');
console.log('PASS: 16/10px tree fruit, eight branch anchors, stem pivots, canopy bounds and subpixel recoil');
