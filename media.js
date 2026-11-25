import {seedBrace,startBraceTrack} from './brace.js';
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

async function videoInput(file) {
  const {Input,BlobSource,ALL_FORMATS}=await import(CONTAINER);
  const input=new Input({source:new BlobSource(file),formats:ALL_FORMATS});
  try {
    const track=await input.getPrimaryVideoTrack();
    if (!track) throw new Error('The selected file has no video track.');
    return {input,track};
  } catch (error) {input.dispose();throw error;}
}

export async function inspectVideo(file) {
  const {input,track}=await videoInput(file);
  try {
    const stats=await track.computePacketStats(256);
    const config=await track.getDecoderConfig();
    return {fps:stats.averagePacketRate,codec:config?.codec ?? 'unknown',
      width:await track.getDisplayWidth(),height:await track.getDisplayHeight()};
  } finally {input.dispose();}
}

export async function openVideo(file,software=false) {
  if (typeof VideoDecoder === 'undefined') throw new Error('Frame decoding needs WebCodecs. Try current iPhone Safari or desktop Chrome.');
  const {VideoSampleSink} = await import(CONTAINER);
  const {input,track}=await videoInput(file);
  try {
    if (!track || !(await track.canDecode())) throw new Error('This browser cannot decode the video track. Try an original H.264 MOV or MP4.');
    const start = await track.getFirstTimestamp();
    return {input,start,sink:new VideoSampleSink(track,software?{hardwareAcceleration:'prefer-software'}:{})};
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

export function braceImage(canvas,scratch) {
  const scale=Math.min(1,320/Math.max(canvas.width,canvas.height));
  scratch.width=Math.round(canvas.width*scale);
  scratch.height=Math.round(canvas.height*scale);
  const context=scratch.getContext('2d',{willReadFrequently:true});
  context.drawImage(canvas,0,0,scratch.width,scratch.height);
  return context.getImageData(0,0,scratch.width,scratch.height);
}

export async function scan(file,side,turn,model,signal,update,software=false,braceSeed=null) {
  const {input,start,sink}=await openVideo(file,software);
  signal.addEventListener('abort', dispose, {once:true});
  function dispose() { input.dispose(); }
  const canvas=document.createElement('canvas');
  const scratch=braceSeed?document.createElement('canvas'):null;
  const frames=[];
  let braceTrack=null;
  const limbs=[[23,25,27],[24,26,28]];
  const indices=limbs[side==='left'?0:1];
  let previousMs=-1,stage='decode';
  try {
    signal.throwIfAborted();
    for await (const sample of sink.samples()) {
      try {
        signal.throwIfAborted();
        stage='draw frame';
        drawFrame(canvas,sample,turn);
        const time=sample.timestamp-start;
        if (!Number.isFinite(time) || (frames.length && time<=frames.at(-1).time))
          throw new Error('Source frame timestamps are missing or out of order.');
        const ms=Math.max(previousMs+1,Math.round(time*1000));
        previousMs=ms;
        stage='pose estimation';
        const result=model.detectForVideo(canvas,ms).landmarks?.[0];
        const read=ids=>result ? ids.map(i => {
          const {x,y,visibility,presence}=result[i];
          return {x,y,score:Math.min(visibility ?? 1,presence ?? 1)};
        }) : null;
        if (braceSeed) {
          stage='brace tracking';
          const image=braceImage(canvas,scratch);
          braceTrack ??= startBraceTrack(seedBrace(image,braceSeed),canvas.width/canvas.height);
          braceTrack.add({time},image,limbs.map(read));
          frames.push({time});
        } else frames.push({time,points:read(indices)});
      } finally { sample.close(); }
      stage='decode';
      if (frames.length%4===0) {
        update(frames.length,frames.at(-1).time);
        await PAUSE();
      }
    }
    if (!frames.length) throw new Error('No video frames were decoded.');
    stage='checking brace track backwards';
    const verified=braceTrack ? await braceTrack.finish(signal,PAUSE,(n,total)=>update(n,total,'verify')) : frames;
    if (braceTrack && !verified.some(frame=>frame.points))
      throw new Error('Could not follow the brace. Try selecting a well-lit panel near the middle of the brace.');
    return {frames:verified,aspect:canvas.width/canvas.height,braceSeed};
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(`${stage} at frame ${frames.length+1}: ${error.message || error}`);
  } finally {
    signal.removeEventListener('abort',dispose);
    input.dispose();
  }
}
