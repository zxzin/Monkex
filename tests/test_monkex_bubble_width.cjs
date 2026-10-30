// Full-content measurements determine the compact native bubble width.
const assert=require('node:assert/strict');
const {reminderContentWidth}=require('../shell/reminders.js');
assert.equal(typeof reminderContentWidth,'function');
for(const [widths,expected]of [
  [[],152],[[0],152],[[30],152],[[78],152],[[78.1],154],
  [[86],160],[[100],174],[[100.1],176],[[121],196],[[122],196],[[400],196],
  [[45,100,88],174],[[130,20],196],[[40,40],152]
])assert.equal(reminderContentWidth(widths),expected,JSON.stringify(widths));
for(let width=0;width<=220;width+=.25){
  const result=reminderContentWidth([width]);
  assert.ok(result>=152&&result<=196);assert.equal(result%2,0);
  assert.ok(result>=Math.min(196,width+74),'content fits until the deliberate maximum width');
}
console.log('PASS: adaptive reminder width uses visible content, 74px chrome, 2px rounding, and 152–196px bounds.');
