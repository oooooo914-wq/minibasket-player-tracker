// Classic Worker intentionally: MediaPipe's WASM loader uses importScripts.
let detector, tracker, sparseFlow, describe, aiBase, frame, frameCtx, small, smallCtx;
let previous=null, candidates=[], lastDetection=-Infinity, lastTime=-Infinity;
let lastStamp=0;
function clear() {tracker.reset();previous=null;candidates=[];lastDetection=-Infinity;lastTime=-Infinity;}
function reply(type,extra={}) {self.postMessage({type,...extra});}
self.onmessage=async ({data:m})=>{
  if(m.type==='init') {
    try {
      const [config,tracking]=await Promise.all([import('./ai-config.js'),import('./tracker.js')]);
      aiBase=config.AI_BASE; sparseFlow=tracking.sparseFlow;describe=tracking.describe;
      tracker=new tracking.PlayerTracker();
      const {FilesetResolver,ObjectDetector}=await import(`${aiBase}/vision_bundle.mjs`);
      const vision=await FilesetResolver.forVisionTasks(`${aiBase}/wasm`);
      // Give MediaPipe a dedicated WebGL canvas; never reuse a 2D capture canvas.
      const inferenceCanvas=new OffscreenCanvas(1,1);
      if(!inferenceCanvas.getContext('webgl2')) throw new Error('このブラウザではAIに必要なWebGL 2を利用できません。AndroidのChromeで開いてください。');
      detector=await ObjectDetector.createFromOptions(vision,{
        canvas:inferenceCanvas,
        baseOptions:{modelAssetPath:config.MODEL_URL,delegate:'CPU'},runningMode:'VIDEO',
        categoryAllowlist:['person'],scoreThreshold:.35,maxResults:30,
      });
      frame=new OffscreenCanvas(1,1);frameCtx=frame.getContext('2d',{willReadFrequently:true});
      small=new OffscreenCanvas(256,144);smallCtx=small.getContext('2d',{willReadFrequently:true});
      // A model download is not proof inference works: warm up before reporting ready.
      lastStamp=performance.now();
      detector.detectForVideo(new ImageData(32,32),lastStamp);
      reply('ready');
    } catch(e) {reply('error',{message:String(e.message||e)});}
    return;
  }
  if(!detector) {m.bitmap?.close(); return;}
  if(m.type==='reset') {clear();return;}
  if(m.type==='select') {
    const candidate=candidates[m.index];
    if(candidate) {tracker.select(candidate,m.time); reply('selected',{epoch:m.epoch,box:tracker.box});}
    return;
  }
  if(m.type!=='frame') return;
  const start=performance.now();
  try {
    if(frame.width!==m.bitmap.width||frame.height!==m.bitmap.height) {
      frame.width=m.bitmap.width;frame.height=m.bitmap.height;clear();
      small.height=Math.max(24,Math.round(frame.height*256/frame.width));
    }
    frameCtx.drawImage(m.bitmap,0,0);m.bitmap.close();
    const w=frame.width,h=frame.height,ratio=256/w;
    smallCtx.drawImage(frame,0,0,256,small.height);
    const rgba=smallCtx.getImageData(0,0,256,small.height).data,gray=new Uint8Array(256*small.height);
    for(let i=0;i<gray.length;i++) gray[i]=(rgba[i*4]*77+rgba[i*4+1]*150+rgba[i*4+2]*29)>>8;
    const scale=b=>({originX:b.originX*ratio,originY:b.originY*ratio,width:b.width*ratio,height:b.height*ratio});
    let motion={};
    if(tracker.state==='tracking' && m.time!==lastTime) {
      motion.camera=sparseFlow(previous,gray,256,small.height,null,candidates.map(d=>scale(d.boundingBox)));
      motion.local=sparseFlow(previous,gray,256,small.height,scale(tracker.box));
      for(const flow of Object.values(motion)){flow.dx/=ratio;flow.dy/=ratio;}
      tracker.advance(m.time,motion);
    }
    const detected=m.force || m.time-lastDetection>=1/m.fps || m.time<lastDetection;
    if(detected) {
      lastStamp=Math.max(lastStamp+1,performance.now());
      const result=detector.detectForVideo(frame,lastStamp);
      const pixels=frameCtx.getImageData(0,0,w,h).data;
      candidates=result.detections.filter(d=>d.categories?.[0]?.categoryName==='person').map(d=>({
        boundingBox:d.boundingBox,score:d.categories[0].score,appearance:describe(pixels,w,h,d.boundingBox),
      }));
      if(tracker.state==='tracking') tracker.match(candidates,m.time);
      lastDetection=m.time;
    }
    previous=gray;lastTime=m.time;
    reply('result',{epoch:m.epoch,time:m.time,width:w,height:h,detected,
      detections:candidates.map(d=>({boundingBox:d.boundingBox,score:d.score})),
      box:tracker.box,state:tracker.state,reason:tracker.reason,
      camera:motion.camera?.reliable?'パン補助あり':'補正未確定',ms:performance.now()-start,
    });
  } catch(e) {m.bitmap.close();reply('error',{epoch:m.epoch,message:String(e.message||e)});}
};
