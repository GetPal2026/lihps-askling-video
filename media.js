const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.32';
const CONTAINER = 'https://cdn.jsdelivr.net/npm/mediabunny@1.65.2/+esm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task';
const PAUSE = () => new Promise(resolve => setTimeout(resolve,0));

export async function engine() {
  const [{FilesetResolver,PoseLandmarker}] = await Promise.all([
    import(VISION+'/vision_bundle.mjs'), import(CONTAINER)
  ]);
  const files = await FilesetResolver.forVisionTasks(VISION+'/wasm');
  return PoseLandmarker.createFromOptions(files,{
    baseOptions:{modelAssetPath:MODEL,delegate:'CPU'},runningMode:'VIDEO',
    numPoses:1, outputSegmentationMasks:false
  });
}

export async function openVideo(file) {
  if (typeof VideoDecoder === 'undefined') throw new Error('Frame decoding needs WebCodecs. Try current iPhone Safari or desktop Chrome.');
  const {Input,BlobSource,ALL_FORMATS,VideoSampleSink} = await import(CONTAINER);
  const input = new Input({source:new BlobSource(file),formats:ALL_FORMATS});
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('This browser cannot decode the video track. Try an original H.264 MOV or MP4.');
    const start = await track.getFirstTimestamp();
    return {input,start,sink:new VideoSampleSink(track)};
  } catch (error) {
    input.dispose();
    throw error;
  }
}

export function drawFrame(canvas,sample,turn) {
  const width=sample.displayWidth, height=sample.displayHeight;
  const scale=Math.min(1,960/Math.max(width,height));
  const w=Math.round(width*scale), h=Math.round(height*scale);
  const sideways=turn%180!==0;
  const newWidth=sideways?h:w, newHeight=sideways?w:h;
  if (canvas.width!==newWidth) canvas.width=newWidth;
  if (canvas.height!==newHeight) canvas.height=newHeight;
  const context=canvas.getContext('2d');
  context.setTransform(1,0,0,1,0,0);
  context.clearRect(0,0,canvas.width,canvas.height);
  context.save();
  context.translate(canvas.width/2,canvas.height/2);
  context.rotate(turn*Math.PI/180);
  sample.draw(context,-w/2,-h/2,w,h);
  context.restore();
}

export async function scan(file,side,turn,model,signal,update) {
  const {input,start,sink}=await openVideo(file);
  signal.addEventListener('abort', dispose, {once:true});
  function dispose() { input.dispose(); }
  const canvas=document.createElement('canvas');
  const frames=[];
  const indices=side==='left'?[23,25,27]:[24,26,28];
  let previousMs=-1;
  try {
    signal.throwIfAborted();
    for await (const sample of sink.samples()) {
      try {
        signal.throwIfAborted();
        drawFrame(canvas,sample,turn);
        const time=sample.timestamp-start;
        const ms=Math.max(previousMs+1,Math.round(time*1000));
        previousMs=ms;
        const result=model.detectForVideo(canvas,ms).landmarks?.[0];
        const points=result ? indices.map(i => {
          const {x,y,visibility,presence}=result[i];
          return {x,y,score:Math.min(visibility ?? 1,presence ?? 1)};
        }) : null;
        frames.push({time,points});
      } finally { sample.close(); }
      if (frames.length%4===0) {
        update(frames.length,frames.at(-1).time);
        await PAUSE();
      }
    }
    if (!frames.length) throw new Error('No video frames were decoded.');
    return {frames,aspect:canvas.width/canvas.height};
  } finally {
    signal.removeEventListener('abort',dispose);
    input.dispose();
  }
}
