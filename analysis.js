import {analyze,median} from './metrics.js';
import {flagFrames} from './review.js';

export function timedFrames(data,captureFps=null) {
  if (captureFps!==null && (!Number.isFinite(captureFps) || captureFps<1 || captureFps>1000))
    throw new Error('Enter a capture rate between 1 and 1000 fps.');
  return data.frames.map((frame,index)=>({
    ...frame,time:captureFps===null?frame.time:index/captureFps
  }));
}

export function calculate(data,{practice=false,braced=false,captureFps=null,excluded=[],referenceIndex=null}={}) {
  const frames=timedFrames(data,captureFps);
  const step=median(frames.slice(1).map((frame,i)=>frame.time-frames[i].time));
  const flags=flagFrames(frames,data.aspect,braced,step>0?1/step:null);
  const result=analyze(frames,data.aspect,practice,braced,flags,referenceIndex);
  const sourceTime=time=>data.frames[frames.findIndex(frame=>frame.time===time)]?.time;
  for (const rep of result.reps) {
    rep.sourcePeakTime=sourceTime(rep.peakTime);
    rep.sourceStartTime=sourceTime(rep.start);
    rep.excluded=excluded.includes(rep.sourceStartTime);
  }
  result.correctedFrames=data.frames.filter(frame=>frame.edited).length;
  result.captureFps=captureFps;
  result.referenceIndex=referenceIndex;
  return {result,flags};
}

// Match edits by source timestamp so a fresh model pass preserves examiner work.
export function preserveEdits(previous,next) {
  const edits=new Map(previous?.frames.filter(frame=>frame.edited).map(frame=>[frame.time,frame]) ?? []);
  next.frames=next.frames.map(frame=>{
    const edited=edits.get(frame.time);
    return edited ? {...frame,original:frame.points,points:structuredClone(edited.points),edited:true} : frame;
  });
  return next;
}
