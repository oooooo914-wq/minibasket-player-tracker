// Exercise the real app event handlers with a fake media/Worker boundary.
// These are lifecycle regressions, not a browser or real AI accuracy test.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8').replaceAll('import.meta.url',"'https://example.test/minibasket-player-tracker/app.js'");
function harness() {
  const ctx2d=new Proxy({},{get:()=>()=>{}}),nodes=new Map(),timers=new Map();let timer=0,worker;
  class Element {
    constructor(id='') {this.id=id;this.listeners={};this.children=[];this.value='';this.width=640;this.height=360;this.style={};this.classList={toggle(){}};this.textContent='';this.src='';this.paused=true;this.readyState=0;this.currentTime=0;this.duration=1800;this.videoWidth=1280;this.videoHeight=720;this.seeking=false;}
    addEventListener(e,f){(this.listeners[e]??=[]).push(f);}
    emit(e,arg={}){return Promise.all((this.listeners[e]||[]).map(f=>f(arg)));}
    getContext(){return ctx2d;}getBoundingClientRect(){return {left:0,top:0,width:640,height:360};}
    matches(){return false;}replaceChildren(){this.children=[];}append(b){this.children.push(b);}setAttribute(){}
    removeAttribute(k){if(k==='src')this.src='';}load(){}pause(){const was=this.paused;this.paused=true;if(!was)this.emit('pause');}
    async play(){this.paused=false;await this.emit('play');}
  }
  const get=id=>{if(!nodes.has(id))nodes.set(id,new Element(id));return nodes.get(id);};
  get('speed').value='.5';get('detectFps').value='7';
  const document={hidden:false,getElementById:get,createElement:tag=>new Element(tag),querySelectorAll:()=>[],addEventListener(){}};
  class FakeWorker {constructor(){worker=this;this.messages=[];}postMessage(m){this.messages.push(m);}terminate(){}reply(m){this.onmessage({data:m});}}
  const sandbox={document,window:{devicePixelRatio:1,Worker:FakeWorker,OffscreenCanvas:class{},createImageBitmap:async()=>({close(){}}),addEventListener(){}},
    navigator:{},URL,Worker:FakeWorker,performance:{now:()=>1000},createImageBitmap:async()=>({close(){}}),
    setTimeout:f=>{timers.set(++timer,f);return timer;},clearTimeout:id=>timers.delete(id),requestAnimationFrame:()=>1,cancelAnimationFrame(){}};
  vm.runInNewContext(source,sandbox);
  return {get,async ready(){const p=get('loadAiBtn').emit('click');worker.reply({type:'ready'});await p;return worker;}};
}
const box={originX:100,originY:50,width:30,height:70};
const flush=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
async function selected(h) {
  const w=await h.ready(),v=h.get('video');v.src='blob:test';v.readyState=2;
  await h.get('detectBtn').emit('click');await flush();
  const f=w.messages.findLast(m=>m.type==='frame');
  const result={type:'result',epoch:f.epoch,time:0,width:768,height:432,detected:true,detections:[{boundingBox:box}],box:null,state:'idle',ms:30};
  w.reply(result);await h.get('playerChoices').children[0].emit('click');w.reply({type:'selected',epoch:f.epoch,box});
  return {w,v,result};
}
test('worker lost result immediately pauses playback and blocks automatic resume',async()=>{
  const h=harness(),{w,v,result}=await selected(h);
  await h.get('playBtn').emit('click');assert.equal(v.paused,false);
  w.reply({...result,state:'lost',box,reason:'選手を再指定してください。'});
  assert.equal(v.paused,true);assert.equal(h.get('targetInfo').textContent,'再指定が必要');
  await h.get('playBtn').emit('click');assert.equal(v.paused,true);
});
test('seeking rejects an in-flight result and cannot preserve the old player',async()=>{
  const h=harness(),{w,v,result}=await selected(h);
  await v.emit('seeking');
  w.reply({...result,state:'tracking',box});
  assert.equal(h.get('targetInfo').textContent,'未選択');assert.equal(h.get('playerChoices').children.length,0);
});
test('AI failure keeps the retry button and video controls usable',async()=>{
  const h=harness(),w=await h.ready();w.reply({type:'error',message:'model unavailable'});
  assert.equal(h.get('loadAiBtn').disabled,false);assert.match(h.get('status').textContent,/再試行/);
  h.get('video').src='blob:test';await h.get('playBtn').emit('click');assert.equal(h.get('video').paused,false);
});
