import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const dictionary=JSON.parse(read('docs/monkex-guide/app-en.json'));
const guideRelative=fs.existsSync(path.join(root,'docs/guide.html'))?'docs/guide.html':'releases/Monkex/docs/guide.html';
export function translate(source,entries,label){
  // One pass prevents a shorter source phrase from changing translated text.
  const keys=Object.keys(entries).sort((a,b)=>b.length-a.length);
  const escaped=keys.map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  const result=source.replace(new RegExp(escaped.join('|'),'g'),match=>entries[match]);
  const remaining=result.split('\n').filter(line=>/\p{Script=Han}/u.test(line));
  if(remaining.length)throw Error(`Untranslated text in ${label}:\n${remaining.join('\n')}`);
  return result;
}
const output=path.join(root,'shell/en');
fs.mkdirSync(output,{recursive:true});
for(const name of ['index.html','app.js','banana-tree.js','read-play.js','task-navigation.js']){
  let result=translate(read('shell/'+name),dictionary,name);
  if(name==='index.html')result=result.replace(/\/shell\/(app|banana-tree|read-play|task-navigation)\.js/g,'/shell/en/$1.js');
  if(name==='app.js'){
    const entries=JSON.parse(read('docs/monkex-guide/errors-en.json'));
    // Translate system diagnostics only. Task titles and progress never pass here.
    const serialized=JSON.stringify(Object.entries(entries).sort((a,b)=>b[0].length-a[0].length)).replace(/[\u007f-\uffff]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
    result=`const englishSystemMessage=value=>${serialized}.reduce((message,[from,to])=>message.split(from).join(to),String(value||''));\n`+result.replace('function banner(message) {','function banner(message) {\n  message=englishSystemMessage(message);');
  }
  fs.writeFileSync(path.join(output,name),result);
}
console.log('Built English Monkex from the canonical product sources.');
if(process.argv.includes('--app-only'))process.exit(0);
const guide=read(guideRelative);
const start=guide.indexOf('const views={'),end=guide.indexOf('function render({focus=false}={})');
if(start<0||end<=start)throw Error('Guide content boundary missing');
const englishViews=read('docs/monkex-guide/views.en.js');
const ui={...dictionary,...JSON.parse(read('docs/monkex-guide/ui-en.json'))};
let english=translate(guide.slice(0,start)+englishViews+'\n'+guide.slice(end),ui,'guide');
english=english.replace('</style>',`html[lang^="en"] h1{letter-spacing:-1.4px}html[lang^="en"] .hero h1{font-size:clamp(38px,3.7vw,58px);letter-spacing:-1.8px}html[lang^="en"] .hero-caption{font-size:9px}html[lang^="en"] .nav a{font-size:12px}html[lang^="en"] .hero-bubble{font-size:11px}html[lang^="en"] .stage-foot{font-size:10px}html[lang^="en"] .stage-foot span:first-child{max-width:78%}@media(max-width:540px){html[lang^="en"] .top{padding-inline:16px}.top .path{gap:7px;font-size:10px}.reset{font-size:10px}html[lang^="en"] .hero h1{font-size:42px}html[lang^="en"] .hero-caption{font-size:8px}html[lang^="en"] .state-buttons{flex-wrap:wrap}}\n</style>`);
fs.writeFileSync(path.join(root,guideRelative.replace('guide.html','guide.en.html')),english);
console.log('Built standalone English handbook.');
