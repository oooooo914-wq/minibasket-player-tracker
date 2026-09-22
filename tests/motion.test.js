import test from 'node:test';
import assert from 'node:assert/strict';
import {FeatureMotion,fitCamera} from '../motion.js';
const w=320,h=200;
function texture(){
 const a=new Uint8Array(w*h);let seed=42;
 // Non-repeating, spatially smooth random texture with unique corners.
 const grid=new Uint8Array(Math.ceil(w/3)*Math.ceil(h/3));
 for(let i=0;i<grid.length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;grid[i]=seed>>>24;}
 for(let y=0;y<h;y++)for(let x=0;x<w;x++)a[y*w+x]=grid[Math.floor(y/3)*Math.ceil(w/3)+Math.floor(x/3)];
 return a;
}
function shift(a,dx,dy){const b=new Uint8Array(w*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(x-dx>=0&&x-dx<w&&y-dy>=0&&y-dy<h)b[y*w+x]=a[(y-dy)*w+x-dx];return b;}
test('pyramidal feature flow follows a 20px pan outside the old local search radius',()=>{
 const m=new FeatureMotion(),a=texture(),box={originX:100,originY:45,width:70,height:110};
 m.update(a,w,h,0);m.seed(box,0);assert.ok(m.points.length>=6);
 const f=m.update(shift(a,20,4),w,h,.1,box,[box]);
 assert.equal(f.local.reliable,true);assert.ok(Math.abs(f.local.dx-20)<1);assert.ok(Math.abs(f.local.dy-4)<1);
 // A rejected camera estimate must not block a valid local feature chain.
 if(f.camera.reliable)assert.ok(Math.abs(f.camera.dx-20)<1);
});
test('blank occlusion breaks a feature chain and never silently reseeds another person',()=>{
 const m=new FeatureMotion(),a=texture(),box={originX:100,originY:45,width:70,height:110};
 m.update(a,w,h,0);m.seed(box,0);
 assert.equal(m.update(new Uint8Array(w*h),w,h,.1,box).local.reliable,false);
 assert.equal(m.update(a,w,h,.2,box).local.continuity,false);assert.equal(m.points.length,0);
});
test('feature ownership counts overlapping points for neither candidate',()=>{
 const m=new FeatureMotion();m.chain=true;m.points=Array.from({length:10},(_,i)=>({x:100+i,y:80}));
 const box={originX:90,originY:40,width:40,height:90};
 assert.equal(m.support([{boundingBox:box}])[0].unique,10);
 const support=m.support([{boundingBox:box},{boundingBox:{...box,originX:95}}]);
 assert.deepEqual(support.map(s=>s.unique),[0,0]);
});
test('camera similarity recovers pan, zoom and rotation while excluding inconsistent motion',()=>{
 const a=1.03*Math.cos(.025),b=1.03*Math.sin(.025),v=[];
 for(let y=20;y<180;y+=30)for(let x=20;x<300;x+=40)v.push({x,y,u:a*x-b*y+8,v:b*x+a*y-4});
 for(let i=0;i<10;i++)v.push({x:20+i*15,y:50+i*5,u:200-i*7,v:20+i});
 const f=fitCamera(v,w,h);assert.equal(f.reliable,true);assert.ok(Math.abs(f.scale-1.03)<.001);assert.ok(Math.abs(f.tx-8)<.01);assert.ok(Math.abs(f.ty+4)<.01);
});
test('a small moving cluster is not accepted as global camera motion',()=>{
 const v=Array.from({length:20},(_,i)=>({x:100+i%5*3,y:80+Math.floor(i/5)*3,u:104+i%5*3,v:80+Math.floor(i/5)*3}));
 assert.equal(fitCamera(v,w,h).reliable,false);
});

test('background features estimate a modest pan independently of target tracking',()=>{
 const m=new FeatureMotion(),a=texture();m.update(a,w,h,0);
 const f=m.update(shift(a,4,2),w,h,.1);
 assert.equal(f.camera.reliable,true);assert.ok(Math.abs(f.camera.dx-4)<.5);assert.ok(Math.abs(f.camera.dy-2)<.5);
});
