const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const language of ['', 'en/']) {
  const html = fs.readFileSync(path.join(__dirname, `../shell/${language}index.html`), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, `../shell/${language}app.js`), 'utf8');
  const watchdog = html.match(/<script>\s*(\(\(\) => \{[\s\S]*?\}\)\(\);)\s*<\/script>/)?.[1];
  assert.ok(watchdog, `${language || 'zh/'} boot watchdog is inline and independent of external scripts`);

  let timeout;
  let replaced = '';
  const values = new Map();
  const root = {dataset: {}};
  const banner = {textContent: '', hidden: true};
  const context = {
    document: {documentElement: root, getElementById: id => id === 'systemBanner' ? banner : null},
    sessionStorage: {getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value)},
    location: {href: 'http://127.0.0.1:8766/?pet=1', replace: value => { replaced = value; }},
    URL,
    Date: {now: () => 1234},
    window: {setTimeout: callback => { timeout = callback; }},
  };
  vm.runInNewContext(watchdog, context);
  assert.equal(root.dataset.monkexBoot, 'starting');
  timeout();
  assert.match(replaced, /[?&]_boot=1234/);
  assert.equal(values.get('monkex-boot-retry'), '1');

  replaced = '';
  vm.runInNewContext(watchdog, context);
  timeout();
  assert.equal(replaced, '', 'a failed retry does not loop forever');
  assert.equal(banner.hidden, false, 'persistent startup failure becomes visible');
  assert.match(source, /dataset\.monkexBoot="ready"/);
  assert.match(source, /sessionStorage\.removeItem\("monkex-boot-retry"\)/);
}

console.log('PASS: one-shot boot recovery, loop guard, visible failure and ready-state reset');
