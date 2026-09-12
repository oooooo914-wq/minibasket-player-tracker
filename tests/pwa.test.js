import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('subdirectory manifest and every precached path resolves to a committed asset',()=>{
  const base='https://example.github.io/minibasket-player-tracker/';
  const manifest=JSON.parse(read('manifest.webmanifest'));
  assert.equal(new URL(manifest.start_url,base).href,base);
  assert.equal(new URL(manifest.scope,base).href,base);
  assert.equal(manifest.icons.length,2);
  const paths=[...read('sw.js').matchAll(/'\.\/([^']*)'/g)].map(m=>m[1]);
  for(const path of paths)if(path)assert.ok(fs.existsSync(new URL('../'+path,import.meta.url)),path);
  for(const icon of manifest.icons){assert.ok(new URL(icon.src,base).href.startsWith(base));assert.ok(fs.existsSync(new URL('../'+icon.src,import.meta.url)));}
});
test('service worker preserves other applications caches and does not intercept videos or model requests',async()=>{
  const listeners={},deleted=[],cached=[];
  const sandbox={URL,self:{location:{href:'https://example.github.io/minibasket-player-tracker/sw.js'},clients:{claim:async()=>{}},addEventListener:(name,fn)=>listeners[name]=fn},
    caches:{keys:async()=>['other-app','minibasket-tracker-v1','minibasket-tracker-v2.0.1'],delete:async k=>deleted.push(k),open:async()=>({addAll:async p=>cached.push(...p)})}};
  vm.runInNewContext(read('sw.js'),sandbox);
  await new Promise(resolve=>listeners.install({waitUntil:p=>p.then(resolve)}));assert.ok(cached.includes('./detector-worker.js'));
  await new Promise(resolve=>listeners.activate({waitUntil:p=>p.then(resolve)}));assert.deepEqual(deleted,['minibasket-tracker-v1']);
  for(const url of ['blob:https://example.github.io/abc','https://example.github.io/other-app/app.js','https://example.github.io/minibasket-player-tracker/game.mp4','https://cdn.jsdelivr.net/model.wasm']){
    let intercepted=false;listeners.fetch({request:{method:'GET',url},respondWith:()=>{intercepted=true;}});assert.equal(intercepted,false,url);
  }
});
