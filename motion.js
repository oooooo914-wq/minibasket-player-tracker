// Pyramidal Lucas–Kanade feature chains. Images and feature counts stay bounded.
import jsfeat from './vendor/jsfeat.js';
const median=a=>a.length?[...a].sort((x,y)=>x-y)[a.length>>1]:0;
const inside=(p,b,pad=0)=>p.x>b.originX-pad&&p.x<b.originX+b.width+pad&&p.y>b.originY-pad&&p.y<b.originY+b.height+pad;
const empty=()=>({camera:{reliable:false,dx:0,dy:0,scale:1},local:{reliable:false,dx:0,dy:0,scale:1,points:0,continuity:false}});
function corners(data,w,h,box,excluded,limit,step){
  const cells=new Map(),cell=box?4:28;
  const r=box||{originX:5,originY:5,width:w-10,height:h-10};
  const x0=Math.max(5,Math.ceil(r.originX)),y0=Math.max(5,Math.ceil(r.originY));
  for(let y=y0;y<Math.min(h-5,r.originY+r.height);y+=step)for(let x=x0;x<Math.min(w-5,r.originX+r.width);x+=step){
    if(excluded.some(b=>inside({x,y},b,3)))continue;
    let xx=0,xy=0,yy=0;
    for(let j=-1;j<=1;j++)for(let i=-1;i<=1;i++){
      const p=(y+j)*w+x+i,gx=data[p+1]-data[p-1],gy=data[p+w]-data[p-w];xx+=gx*gx;xy+=gx*gy;yy+=gy*gy;
    }
    const score=(xx+yy-Math.hypot(xx-yy,2*xy))/2;
    if(score<150)continue;
    const key=Math.floor(x/cell)+','+Math.floor(y/cell),old=cells.get(key);
    if(!old||score>old.score)cells.set(key,{x,y,score});
  }
  const chosen=[];
  for(const p of [...cells.values()].sort((a,b)=>b.score-a.score)){
    if(chosen.every(q=>Math.hypot(p.x-q.x,p.y-q.y)>=(box?3:12)))chosen.push(p);
    if(chosen.length===limit)break;
  }
  return chosen;
}
function patchDifference(a,b,w,p,q){
  const x=Math.round(p.x),y=Math.round(p.y),u=Math.round(q.x),v=Math.round(q.y);
  let offset=0,error=0;
  for(let j=-2;j<=2;j++)for(let i=-2;i<=2;i++)offset+=a[(y+j)*w+x+i]-b[(v+j)*w+u+i];
  offset/=25;
  for(let j=-2;j<=2;j++)for(let i=-2;i<=2;i++)error+=Math.abs(a[(y+j)*w+x+i]-b[(v+j)*w+u+i]-offset);
  return error/25;
}
export function fitCamera(vectors,w,h){
  if(vectors.length<12)return {reliable:false,dx:0,dy:0,scale:1};
  let best=[];
  for(let i=0;i<Math.min(100,vectors.length*2);i++){
    const p=vectors[i%vectors.length],q=vectors[(i*17+11)%vectors.length],x=q.x-p.x,y=q.y-p.y,d=x*x+y*y;
    if(d<900)continue;
    const u=q.u-p.u,v=q.v-p.v,a=(x*u+y*v)/d,b=(x*v-y*u)/d,scale=Math.hypot(a,b);
    if(scale<.8||scale>1.25||Math.abs(Math.atan2(b,a))>.2)continue;
    const tx=p.u-a*p.x+b*p.y,ty=p.v-b*p.x-a*p.y;
    const keep=vectors.filter(r=>Math.hypot(a*r.x-b*r.y+tx-r.u,b*r.x+a*r.y+ty-r.v)<2);
    if(keep.length>best.length)best=keep;
  }
  if(best.length<12||best.length/vectors.length<.6)return {reliable:false,dx:0,dy:0,scale:1};
  const xs=best.map(p=>p.x),ys=best.map(p=>p.y);
  if(Math.max(...xs)-Math.min(...xs)<w*.3||Math.max(...ys)-Math.min(...ys)<h*.25)return {reliable:false,dx:0,dy:0,scale:1};
  const mean=k=>best.reduce((s,p)=>s+p[k],0)/best.length,x=mean('x'),y=mean('y'),u=mean('u'),v=mean('v');
  let numA=0,numB=0,den=0;
  for(const p of best){const px=p.x-x,py=p.y-y,pu=p.u-u,pv=p.v-v;numA+=px*pu+py*pv;numB+=px*pv-py*pu;den+=px*px+py*py;}
  const a=numA/den,b=numB/den,tx=u-a*x+b*y,ty=v-b*x-a*y;
  return {reliable:true,a,b,tx,ty,scale:Math.hypot(a,b),dx:(a-1)*w/2-b*h/2+tx,dy:b*w/2+(a-1)*h/2+ty,points:best.length};
}
export class FeatureMotion {
  constructor(){this.reset();}
  reset(){this.previous=null;this.spare=null;this.points=[];this.seedCount=0;this.width=0;this.height=0;this.time=null;this.chain=false;}
  pyramid(gray,w,h){
    const p=this.spare||new jsfeat.pyramid_t(Math.min(w,h)>=160?4:Math.min(w,h)>=80?3:2);
    if(!this.spare)p.allocate(w,h,jsfeat.U8_t|jsfeat.C1_t);
    p.data[0].data.set(gray);p.build(p.data[0],true);return p;
  }
  seed(box,time,excluded=[]){
    if(!this.previous)return;
    const torso={originX:box.originX+box.width*.18,originY:box.originY+box.height*.12,width:box.width*.64,height:box.height*.7};
    this.points=corners(this.previous.data[0].data,this.width,this.height,torso,excluded,48,2);
    this.seedCount=this.points.length;this.seedTime=time;this.chain=this.seedCount>=6;
  }
  update(gray,w,h,time,box=null,excluded=[]){
    if(w!==this.width||h!==this.height){this.reset();this.width=w;this.height=h;}
    if(time===this.time)return empty();
    const current=this.pyramid(gray,w,h),result=empty();
    if(this.previous&&time>this.time&&time-this.time<=.55){
      const background=corners(this.previous.data[0].data,w,h,null,excluded,120,4);
      const all=[...background,...(this.chain?this.points:[])],n=all.length;
      if(n){
        const from=new Float32Array(n*2),to=new Float32Array(n*2),back=new Float32Array(n*2),ok=new Uint8Array(n),reverse=new Uint8Array(n);
        all.forEach((p,i)=>{from[i*2]=p.x;from[i*2+1]=p.y;});
        jsfeat.optical_flow_lk.track(this.previous,current,from,to,n,15,30,ok,.02,.001);
        jsfeat.optical_flow_lk.track(current,this.previous,to,back,n,15,30,reverse,.02,.001);
        const valid=[];
        for(let i=0;i<n;i++){
          const p=all[i],q={x:to[i*2],y:to[i*2+1]};
          if(!ok[i]||!reverse[i]||q.x<4||q.y<4||q.x>w-5||q.y>h-5||Math.hypot(p.x-back[i*2],p.y-back[i*2+1])>1.2)continue;
          if(patchDifference(this.previous.data[0].data,current.data[0].data,w,p,q)>25)continue;
          valid.push({x:p.x,y:p.y,u:q.x,v:q.y,target:i>=background.length});
        }
        result.camera=fitCamera(valid.filter(p=>!p.target),w,h);
        const local=valid.filter(p=>p.target),dx=median(local.map(p=>p.u-p.x)),dy=median(local.map(p=>p.v-p.y));
        const keep=local.filter(p=>Math.hypot(p.u-p.x-dx,p.v-p.y-dy)<Math.max(2,box?.height*.08||2));
        const spanX=keep.length?Math.max(...keep.map(p=>p.x))-Math.min(...keep.map(p=>p.x)):0;
        const spanY=keep.length?Math.max(...keep.map(p=>p.y))-Math.min(...keep.map(p=>p.y)):0;
        const reliable=!!box&&keep.length>=6&&keep.length/Math.max(1,this.points.length)>.65&&keep.length/Math.max(1,this.seedCount)>.45&&spanX>=Math.min(5,box.width*.2)&&spanY>=Math.min(8,box.height*.2);
        result.local={dx,dy,scale:1,reliable,continuity:reliable,points:keep.length,seedPoints:this.seedCount,age:time-this.seedTime};
        this.chain=reliable;this.points=reliable?keep.map(p=>({x:p.u,y:p.v})):[];
      }
    }else {this.chain=false;this.points=[];}
    this.spare=this.previous;this.previous=current;this.time=time;
    return result;
  }
  // Only feature points followed from a verified selection count. Points that
  // could belong to either overlapping box provide no identity evidence.
  support(candidates,ratio=1){
    const hits=candidates.map(()=>0),total=this.points.length;
    if(!this.chain)return candidates.map(()=>({unique:0,total,continuity:false}));
    for(const p of this.points){
      const q={x:p.x/ratio,y:p.y/ratio},owners=[];
      candidates.forEach((d,i)=>{if(inside(q,d.boundingBox))owners.push(i);});
      if(owners.length===1)hits[owners[0]]++;
    }
    return hits.map(unique=>({unique,total,continuity:true}));
  }
}
