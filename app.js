// Extends the original vanilla JS / MediaPipe / canvas MVP.
const $ = id => document.getElementById(id);
const videoInput=$('videoInput'),video=$('video'),overlay=$('overlay'),ctx=overlay.getContext('2d');
const loadAiBtn=$('loadAiBtn'),resetBtn=$('resetBtn'),statusEl=$('status');
const aiInfo=$('aiInfo'),detectInfo=$('detectInfo'),targetInfo=$('targetInfo');
let worker=null,ready=false,initializing=null,epoch=0,busy=false,frameTimer=null,initTimer=null;
let detections=[],target=null,trail=[],state='idle',objectUrl=null,lastVideoTime=-1,lastSent=0;
let analysisWidth=768,analysisHeight=432,rafId=null,selectionTime=-1,selectable=false;
let processingMs=0,lastFrameWall=0,detectionCount=0,rateStart=0,pendingForce=false,installPrompt=null;
let bridging=false,waitingWorker=null,reloadForUpdate=false;
const capture=document.createElement('canvas');
const captureCtx=capture.getContext('2d');
function setStatus(text) {statusEl.textContent=text;statusEl.classList.toggle('warning',state==='lost');}
function syncCanvas() {
  const rect=video.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1);
  const width=Math.max(1,Math.round(rect.width*dpr)),height=Math.max(1,Math.round(rect.height*dpr));
  if(overlay.width!==width||overlay.height!==height){overlay.width=width;overlay.height=height;}
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
function videoToScreen(box) {
  const rect=video.getBoundingClientRect(),sx=rect.width/analysisWidth,sy=rect.height/analysisHeight;
  return {x:box.originX*sx,y:box.originY*sy,width:box.width*sx,height:box.height*sy};
}
function draw() {
  syncCanvas();const rect=video.getBoundingClientRect();ctx.clearRect(0,0,rect.width,rect.height);
  // A short screen-coordinate trail, explicitly not a court path or distance.
  const visible=trail.filter(p=>p.time>=video.currentTime-8);
  if(visible.length>1) {
    ctx.beginPath();visible.forEach((p,i)=>{const s=videoToScreen({originX:p.x,originY:p.y,width:0,height:0});
      if(i===0)ctx.moveTo(s.x,s.y);else ctx.lineTo(s.x,s.y);});ctx.lineWidth=2;ctx.strokeStyle='#fbbf24';ctx.stroke();
  }
  if(video.paused) detections.forEach((d,i)=>{
    const b=videoToScreen(d.boundingBox);ctx.strokeStyle='#60a5fa';ctx.lineWidth=2;ctx.strokeRect(b.x,b.y,b.width,b.height);
    ctx.fillStyle='#172554';ctx.fillRect(b.x,b.y,24,22);ctx.fillStyle='#fff';ctx.font='bold 13px system-ui';ctx.fillText(String(i+1),b.x+6,b.y+16);
  });
  if(target&&state==='tracking') {
    const b=videoToScreen(target);ctx.strokeStyle=bridging?'#fbbf24':'#4ade80';ctx.lineWidth=3;ctx.strokeRect(b.x,b.y,b.width,b.height);
    ctx.fillStyle=bridging?'#fbbf24':'#4ade80';ctx.beginPath();ctx.arc(b.x+b.width/2,b.y+b.height,5,0,Math.PI*2);ctx.fill();
  }
}
function updateTime() {
  const format=t=>`${Math.floor((t||0)/60)}:${String(Math.floor((t||0)%60)).padStart(2,'0')}`;
  $('timeInfo').textContent=`${format(video.currentTime)} / ${format(video.duration)}`;
  if(!$('seek').matches(':active')) $('seek').value=video.currentTime||0;
}
function updatePlayback() {$('playBtn').textContent=video.paused?'▶ 再生':'❚❚ 一時停止';updateTime();draw();}
function clearTracking(message='停止して、青い枠の選手をタップしてください。') {
  epoch++;worker?.postMessage({type:'reset'});state='idle';target=null;trail=[];detections=[];
  bridging=false;$('trackingInfo').textContent='未選択';
  selectable=false;lastVideoTime=-1;targetInfo.textContent='未選択';detectInfo.textContent='0人';
  $('playerChoices').replaceChildren();setStatus(message);draw();
}
function lose(message) {
  if(state==='lost') return;
  state='lost';target=null;trail=[];targetInfo.textContent='再指定が必要';$('stopInfo').textContent=message;video.pause();
  setStatus(message);draw();
}
function failAi(message) {
  const wasTracking=state==='tracking';worker?.terminate();worker=null;ready=false;busy=false;
  clearTimeout(frameTimer);clearTimeout(initTimer);loadAiBtn.disabled=false;aiInfo.textContent='読込・実行エラー';
  if(wasTracking) lose('AIが停止しました。再準備後に選手を再指定してください。');
  video.pause();setStatus(`AIを準備できませんでした。「AIを準備」で再試行してください。${message}`);
}
async function initDetector() {
  if(ready) {requestFrame(true);return;}
  if(initializing) return initializing;
  loadAiBtn.disabled=true;aiInfo.textContent='読込中';setStatus('AIを準備しています。初回は通信が必要です…');
  initializing=new Promise(resolve=>{
    if(!window.Worker||!window.OffscreenCanvas||!window.createImageBitmap) {
      failAi('AndroidのChromeを更新してください。');resolve();return;
    }
    worker=new Worker(new URL('./detector-worker.js',import.meta.url));
    initTimer=setTimeout(()=>{failAi('通信状態を確認してください。');resolve();},90000);
    worker.onerror=()=>{failAi('通信状態とブラウザを確認してください。');resolve();};
    worker.onmessage=({data:m})=>{
      if(m.type==='ready') {
        clearTimeout(initTimer);ready=true;loadAiBtn.disabled=false;aiInfo.textContent='準備完了（端末内）';
        setStatus(video.src?'停止して、青い枠の選手をタップしてください。':'動画を選んでください。');
        resolve();requestFrame(true);return;
      }
      if(m.type==='error') {failAi(m.message);resolve();return;}
      if(m.type==='selected') {
        if(m.epoch!==epoch)return;
        target=m.box;state='tracking';bridging=false;trail=[];targetInfo.textContent='選択済み';$('trackingInfo').textContent='人物検出で確認';
        setStatus('緑の枠を確認し、再生してください。違う場合は停止して選び直せます。');draw();return;
      }
      if(m.type!=='result')return;
      busy=false;clearTimeout(frameTimer);
      if(m.epoch!==epoch) {if(pendingForce)requestFrame(true);return;}
      processingMs=.8*processingMs+.2*m.ms;
      if(video.currentTime-m.time>.35 && !video.paused) {
        if(state==='tracking')lose('処理が動画に追いつきません。再生速度を下げ、選手を再指定してください。');
        requestFrame(true);return;
      }
      analysisWidth=m.width;analysisHeight=m.height;
      detections=m.detections;selectionTime=m.time;selectable=video.paused&&Math.abs(video.currentTime-m.time)<.08;
      detectInfo.textContent=`${detections.length}人`;target=m.box;
      if(m.state==='lost')lose(m.reason);
      else if(state!=='lost')state=m.state;
      bridging=!!m.bridge;
      if(state!=='lost')$('trackingInfo').textContent=m.note||'人物検出で確認';
      if(state==='tracking') {
        targetInfo.textContent=bridging?'一時補間中':'追跡中';const b=m.box;
        if(b)trail.push({x:b.originX+b.width/2,y:b.originY+b.height,time:m.time});
        if(trail.length>600)trail.splice(0,trail.length-600);
      }
      if(m.detected)detectionCount++;
      const now=performance.now();if(!rateStart)rateStart=now;
      if(now-rateStart>1500){$('fpsInfo').textContent=`${(detectionCount*1000/(now-rateStart)).toFixed(1)} 回/秒 · ${Math.round(m.ms)} ms`;rateStart=now;detectionCount=0;}
      $('cameraInfo').textContent=m.camera;
      renderChoices();draw();
      if(pendingForce)requestFrame(true);
    };
    worker.postMessage({type:'init'});
  });
  try {await initializing;} catch(e) {failAi(e.message);} finally {initializing=null;}
}
function renderChoices() {
  const root=$('playerChoices');root.replaceChildren();
  if(!video.paused||!selectable)return;
  detections.forEach((_,i)=>{const b=document.createElement('button');b.type='button';b.textContent=String(i+1);
    b.setAttribute('aria-label',`選手 ${i+1} を選択`);b.addEventListener('click',()=>selectPlayer(i));root.append(b);});
}
function selectPlayer(index) {
  if(!selectable||!video.paused||busy||Math.abs(video.currentTime-selectionTime)>.08){setStatus('停止画面の検出を待ってから、もう一度タップしてください。');requestFrame(true);return;}
  worker.postMessage({type:'select',epoch,index,time:selectionTime});
}
async function requestFrame(force=false) {
  if(!ready||video.readyState<2||video.seeking||document.hidden)return;
  if(busy){pendingForce ||= force;return;}
  if(!force&&video.currentTime===lastVideoTime)return;
  const now=performance.now(),interval=Math.max(1000/15,processingMs*1.15);
  if(!force&&now-lastSent<interval)return;
  busy=true;pendingForce=false;lastSent=now;lastVideoTime=video.currentTime;
  const token=epoch,time=video.currentTime;
  const scale=Math.min(1,768/Math.max(video.videoWidth,video.videoHeight));
  const width=Math.max(1,Math.round(video.videoWidth*scale)),height=Math.max(1,Math.round(video.videoHeight*scale));
  if(capture.width!==width||capture.height!==height){capture.width=width;capture.height=height;}
  try {
    captureCtx.drawImage(video,0,0,width,height);
    const bitmap=await createImageBitmap(capture);
    if(token!==epoch||!worker){bitmap.close();busy=false;if(pendingForce)requestFrame(true);return;}
    frameTimer=setTimeout(()=>failAi('解析が応答しません。再試行してください。'),15000);
    worker.postMessage({type:'frame',bitmap,epoch,time,force,fps:Number($('detectFps').value)},[bitmap]);
  } catch(e){busy=false;failAi(e.message);}
}
function tick(now) {
  rafId=null;
  if(video.paused||video.ended||document.hidden)return;
  if(lastFrameWall&&now-lastFrameWall>1500&&state==='tracking')lose('画面が中断されました。選手を再指定してください。');
  lastFrameWall=now;requestFrame();updateTime();
  if(!video.paused)rafId=requestAnimationFrame(tick);
}
videoInput.addEventListener('change',async event=>{
  const file=event.target.files?.[0];if(!file)return;
  video.pause();clearTracking(`動画を読み込みました：${file.name}`);
  video.removeAttribute('src');video.load();if(objectUrl)URL.revokeObjectURL(objectUrl);
  objectUrl=URL.createObjectURL(file);video.src=objectUrl;video.playbackRate=Number($('speed').value);
  $('fileInfo').textContent=`${file.name} · ${(file.size/1024/1024).toFixed(0)} MB · 端末内のみ`;
  videoInput.value='';await initDetector();
});
loadAiBtn.addEventListener('click',initDetector);
resetBtn.addEventListener('click',()=>{video.pause();clearTracking();requestFrame(true);});
$('detectBtn').addEventListener('click',()=>{video.pause();requestFrame(true);});
$('playBtn').addEventListener('click',async()=>{
  if(!video.src)return;
  if(!video.paused){video.pause();return;}
  if(state==='lost'){setStatus('青い枠から選手を再指定するか、時間を移動してください。');return;}
  try{await video.play();}catch{setStatus('動画を再生できません。MP4（H.264）で試してください。');}
});
function seekTo(time){video.pause();video.currentTime=Math.max(0,Math.min(video.duration||0,time));}
$('seek').addEventListener('input',()=>seekTo(Number($('seek').value)));
$('backBtn').addEventListener('click',()=>seekTo(video.currentTime-1));
$('forwardBtn').addEventListener('click',()=>seekTo(video.currentTime+1));
$('fineBackBtn').addEventListener('click',()=>seekTo(video.currentTime-.1));
$('fineForwardBtn').addEventListener('click',()=>seekTo(video.currentTime+.1));
$('speed').addEventListener('change',()=>{video.playbackRate=Number($('speed').value);});
video.addEventListener('seeking',()=>{clearTracking('移動先を検出しています。選手を選び直してください。');});
video.addEventListener('seeked',()=>{updatePlayback();requestFrame(true);});
video.addEventListener('loadedmetadata',()=>{
  $('seek').max=Number.isFinite(video.duration)?video.duration:0;
  document.querySelectorAll('[data-video-control]').forEach(b=>b.disabled=false);updatePlayback();
});
video.addEventListener('loadeddata',()=>requestFrame(true));
video.addEventListener('error',()=>{video.pause();clearTracking('この動画を再生できません。MP4（H.264）など、Chromeが対応する動画を選んでください。');});
video.addEventListener('play',()=>{selectable=false;renderChoices();lastFrameWall=0;rateStart=0;detectionCount=0;updatePlayback();if(!rafId)rafId=requestAnimationFrame(tick);});
video.addEventListener('pause',()=>{if(rafId)cancelAnimationFrame(rafId);rafId=null;updatePlayback();requestFrame(true);});
video.addEventListener('ended',()=>{updatePlayback();setStatus('動画の終わりです。別の位置で試すには時間を移動してください。');});
video.addEventListener('timeupdate',updateTime);
// Canvas never sits over playback controls: all controls are outside the stage.
// During playback a tap pauses first; selecting is only allowed on a fresh still frame.
overlay.addEventListener('pointerdown',event=>{
  if(!video.paused){video.pause();return;}
  if(!selectable||busy)return;
  const rect=overlay.getBoundingClientRect(),px=(event.clientX-rect.left)*analysisWidth/rect.width,py=(event.clientY-rect.top)*analysisHeight/rect.height;
  const hits=detections.map((d,i)=>({d,i})).filter(({d:{boundingBox:b}})=>px>=b.originX&&px<=b.originX+b.width&&py>=b.originY&&py<=b.originY+b.height);
  if(hits.length===1)selectPlayer(hits[0].i);
  else if(hits.length>1)setStatus('枠が重なっています。下の番号ボタンで選ぶか、時間を少し移動してください。');
});
window.addEventListener('resize',draw);
document.addEventListener('visibilitychange',()=>{if(document.hidden){video.pause();if(state==='tracking')lose('別の画面に移動しました。戻ったら選手を再指定してください。');}else requestFrame(true);});
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('installBtn').hidden=false;});
$('installBtn').addEventListener('click',async()=>{if(installPrompt){await installPrompt.prompt();installPrompt=null;$('installBtn').hidden=true;}});
if('serviceWorker' in navigator) {
  navigator.serviceWorker.register(new URL('./sw.js',import.meta.url),{scope:'./',updateViaCache:'none'}).then(reg=>{
    $('pwaInfo').textContent=reg.active?'ホーム画面追加対応':'オフライン用画面を準備中';
    const update=()=>{waitingWorker=reg.waiting;$('updateBtn').hidden=false;$('pwaInfo').textContent='更新あり：更新ボタンで反映';};
    if(reg.waiting)update();
    reg.addEventListener('updatefound',()=>reg.installing?.addEventListener('statechange',()=>{if(reg.waiting)update();}));
    navigator.serviceWorker.addEventListener('controllerchange',()=>{if(reloadForUpdate){window.location.reload();return;}$('pwaInfo').textContent='ホーム画面追加対応';});
  }).catch(()=>{$('pwaInfo').textContent='ホーム画面追加の準備に失敗。オンラインでは利用できます。';});
}

$('updateBtn').addEventListener('click',()=>{if(waitingWorker){video.pause();reloadForUpdate=true;waitingWorker.postMessage({type:'activateUpdate'});}});
