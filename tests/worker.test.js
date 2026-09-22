// Real worker message handling with only the detector/canvas boundary replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import * as tracking from '../tracker.js';
import * as motion from '../motion.js';
const source=fs.readFileSync(new URL('../detector-worker.js',import.meta.url),'utf8').replaceAll('import(','load(');
function workerHarness(gpuFails=false){
 const messages=[],options=[],calls=[];let clock=1,currentDelegate='';
 const detections=[{boundingBox:{originX:70,originY:30,width:30,height:70},categories:[{categoryName:'person',score:.8}]},
 {boundingBox:{originX:190,originY:30,width:30,height:70},categories:[{categoryName:'person',score:.7}]},
 {boundingBox:{originX:240,originY:30,width:30,height:70},categories:[{categoryName:'person',score:.22}]}];
 const detector={detectForVideo(input){calls.push(input);if(gpuFails==='warmup'&&currentDelegate==='GPU')throw Error('GPU warm-up failed');return {detections};},close(){}};
 const vision={FilesetResolver:{forVisionTasks:async()=>({})},ObjectDetector:{createFromOptions:async (files,o)=>{options.push(o);currentDelegate=o.baseOptions.delegate;if(gpuFails===true&&o.baseOptions.delegate==='GPU')throw Error('GPU unsupported');return detector;}}};
 class Canvas {
   constructor(w,h){this.width=w;this.height=h;}
   getContext(type){if(type==='webgl2')return {};return {drawImage(){},getImageData(x,y,w,h){const data=new Uint8ClampedArray(w*h*4);for(let i=0;i<data.length;i+=4){data[i]=255;data[i+3]=255;}return {data};}};}
 }
 const self={postMessage:m=>messages.push(m)},sandbox={self,OffscreenCanvas:Canvas,ImageData:class{},performance:{now:()=>clock++},
 load:async path=>path==='./tracker.js'?tracking:path==='./motion.js'?motion:path==='./ai-config.js'?{AI_BASE:'mock',MODEL_URL:'mock-model'}:vision};
 vm.runInNewContext(source,sandbox);
 return {messages,options,calls,send:m=>self.onmessage({data:m}),frame:time=>({type:'frame',time,epoch:1,force:true,fps:7,holdSeconds:2,bitmap:{width:320,height:180,close(){}}})};
}
test('GPU initialization failure falls back to CPU before reporting readiness',async()=>{
 const h=workerHarness(true);await h.send({type:'init'});
 assert.deepEqual(h.options.map(o=>o.baseOptions.delegate),['GPU','CPU']);
 assert.equal(h.messages.at(-1).type,'ready');assert.equal(h.messages.at(-1).backend,'CPU');assert.equal(h.calls.length,1);
});
test('worker selection excludes weak boxes, integrates feature matching and keeps one inference per detection',async()=>{
 const h=workerHarness();await h.send({type:'init'});await h.send(h.frame(0));
 assert.equal(h.messages.at(-1).detections.length,2);assert.equal(h.options[0].scoreThreshold,.18);
 await h.send({type:'select',index:0,time:0,epoch:1});assert.equal(h.messages.at(-1).type,'selected');
 const before=h.calls.length;await h.send(h.frame(.1));const r=h.messages.at(-1);
 assert.equal(r.type,'result');assert.equal(r.state,'tracking');assert.equal(r.diagnostic.code,'confirmed');
 assert.equal(h.calls.length,before+1);assert.equal(r.diagnostic.backend,'GPU');
 assert.ok(Number.isFinite(r.diagnostic.flowMs));assert.ok(Number.isFinite(r.diagnostic.inferenceMs));
 await h.send({type:'reset'});await h.send(h.frame(.2));assert.equal(h.messages.at(-1).state,'idle');
});

test('a GPU that initializes but fails inference is closed and retried on CPU',async()=>{
 const h=workerHarness('warmup');await h.send({type:'init'});
 assert.equal(h.calls.length,2);assert.equal(h.messages.at(-1).type,'ready');assert.equal(h.messages.at(-1).backend,'CPU');
});
