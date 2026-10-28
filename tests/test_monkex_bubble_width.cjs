// Full-content measurements determine the compact native bubble width.
const assert=require('node:assert/strict');
const {reminderContentWidth}=require('../shell/reminders.js');
assert.equal(typeof reminderContentWidth,'function');
for(const [widths,expected]of [
  [[],152],[[0],152],[[30],152],[[86],152],[[86.1],154],
  [[100],166],[[100.1],168],[[129],196],[[130],196],[[400],196],
  [[45,100,88],166],[[130,20],196],[[40,40],152]
])assert.equal(reminderContentWidth(widths),expected,JSON.stringify(widths));
for(let width=0;width<=220;width+=.25){
  const result=reminderContentWidth([width]);
  assert.ok(result>=152&&result<=196);assert.equal(result%2,0);
  assert.ok(result>=Math.min(196,width+66),'content fits until the deliberate maximum width');
}
console.log('PASS: adaptive reminder width uses visible content, 66px chrome, 2px rounding, and 152–196px bounds.');
