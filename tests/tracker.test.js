import test from 'node:test';
import assert from 'node:assert/strict';
import {PlayerTracker,KalmanAxis,sparseFlow,describe,appearanceDistance} from '../tracker.js';
const red=[1,0,0,0],blue=[0,1,0,0];
const person=(x,appearance=red,w=30,h=70)=>({boundingBox:{originX:x,originY:50,width:w,height:h},appearance});
test('follows a moving player and rejects a closer different uniform',()=>{
  const t=new PlayerTracker();t.select(person(100),0);
  t.advance(.14,{local:{dx:8,dy:0,reliable:true}});
  const correct=person(110),wrong=person(95,blue);
  // No geometric overlap with alternate player in this identity test.
  wrong.boundingBox.originY=125;
  assert.equal(t.match([wrong,correct],.14),correct);
  assert.equal(t.state,'tracking');
});
test('missing target latches lost and never automatically reacquires',()=>{
  const t=new PlayerTracker();t.select(person(100),0);
  assert.equal(t.match([], .14),null);assert.equal(t.state,'lost');
  assert.equal(t.match([person(100)],.28),null);
  t.select(person(100),.28);assert.equal(t.state,'tracking');
});
test('ambiguous same uniforms require a new selection',()=>{
  const t=new PlayerTracker();t.select(person(100),0);
  assert.equal(t.match([person(94),person(106)],.14),null);assert.equal(t.state,'lost');
});
test('overlap with a different uniform also stops before an occlusion switch',()=>{
  const t=new PlayerTracker();t.select(person(100),0);
  t.match([person(100),person(110,blue)],.14);assert.equal(t.state,'lost');
});
test('position jump, size jump and wrong appearance are rejected',()=>{
  for(const candidate of [person(500),person(100,red,90,150),person(100,blue)]){
    const t=new PlayerTracker();t.select(person(100),0);t.match([candidate],.14);assert.equal(t.state,'lost');
  }
});
test('seek, discontinuity and detector starvation invalidate track',()=>{
  for(const time of [-1,1]){const t=new PlayerTracker();t.select(person(100),0);t.advance(time,{});assert.equal(t.state,'lost');}
  const t=new PlayerTracker();t.select(person(100),0);
  for(const time of [.2,.4,.6])t.advance(time,{});
  assert.equal(t.state,'lost');t.reset();assert.equal(t.state,'idle');
});
test('Kalman learns velocity and accepts camera translation separately',()=>{
  const k=new KalmanAxis(0);for(let i=1;i<=30;i++){k.predict(.1);k.correct(i*2);}
  assert.ok(k.v>10);const x=k.x;k.predict(.1,15);assert.ok(k.x>x+15);
});
test('sparse optical flow measures a known camera pan and rejects textureless images',()=>{
  const w=160,h=100,a=new Uint8Array(w*h),b=new Uint8Array(w*h);
  let seed=42;
  for(let i=0;i<a.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;a[i]=seed>>>24;}
  for(let y=0;y<h-2;y++)for(let x=0;x<w-4;x++)b[(y+2)*w+x+4]=a[y*w+x];
  const f=sparseFlow(a,b,w,h);assert.equal(f.reliable,true);assert.equal(f.dx,4);assert.equal(f.dy,2);
  assert.equal(sparseFlow(new Uint8Array(w*h),new Uint8Array(w*h),w,h).reliable,false);
});
test('appearance describes torso and shorts without storing image history',()=>{
  const data=new Uint8ClampedArray(40*80*4);for(let i=0;i<data.length;i+=4){data[i]=255;data[i+3]=255;}
  const desc=describe(data,40,80,{originX:-2,originY:0,width:42,height:80});
  assert.equal(desc.length,128);assert.ok(Math.abs(desc.reduce((a,b)=>a+b,0)-1)<1e-6);
  assert.equal(appearanceDistance(desc,desc),0);
});
