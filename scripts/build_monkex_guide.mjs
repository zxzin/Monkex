import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const template=fs.readFileSync(path.join(root,'docs/monkex-guide/index.template.html'),'utf8');
// Embed the canonical product motion, including its shared branch/fruit phase.
const styles=fs.readFileSync(path.join(root,'shell/styles.css'),'utf8');
const motion=styles.slice(styles.indexOf('.banana-tree-art{isolation:'),styles.indexOf('.banana-tree-art[data-frame=peek]'));
if(!motion.includes('@keyframes branch-peek')||!motion.includes('@keyframes harvest-settle'))throw Error('Product tree motion missing');
const motionCss=motion.replace(/url\('\/([^']+\.png)'\)/g,"url('{{asset:$1}}')");
const result=template.replace('{{tree-motion-css}}',motionCss).replace(/\{\{asset:([^}]+)\}\}/g,(_,asset)=>{
  const full=path.resolve(root,asset);
  if(!full.startsWith(root+path.sep)||!asset.endsWith('.png'))throw Error('Invalid guide asset');
  return 'data:image/png;base64,'+fs.readFileSync(full).toString('base64');
});
const output=path.join(root,fs.existsSync(path.join(root,'docs/guide.html'))?'docs/guide.html':'releases/Monkex/docs/guide.html');
fs.mkdirSync(path.dirname(output),{recursive:true});
fs.writeFileSync(output,result);
console.log(`Built standalone guide: ${output} (${Math.round(Buffer.byteLength(result)/1024)} KB)`);
