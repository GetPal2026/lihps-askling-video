import {analyze,median} from './metrics.js';
import {applyBraceEdits} from './brace.js';
import {flagFrames} from './review.js';

export function timedFrames(data,captureFps=null) {
  if (captureFps!==null && (!Number.isFinite(captureFps) || captureFps<1 || captureFps>1000))
    throw new Error('Enter a capture rate between 1 and 1000 fps.');
  return data.frames.map((frame,index)=>({
    ...frame,time:captureFps===null?frame.time:index/captureFps
  }));
}

export function calculate(data,{practice=false,braced=false,captureFps=null,excluded=[],referenceIndex=null,propagate=false}={}) {
  const frames=applyBraceEdits(timedFrames(data,captureFps),data.aspect,!!data.braceSeed && propagate);
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
  result.propagatedFrames=frames.filter(frame=>frame.propagated).length;
  result.braceAssisted=!!data.braceSeed;
  return {result,flags,frames};
}

// Match edits by source timestamp so a fresh model pass preserves examiner work.
export function preserveEdits(previous,next) {
  const edits=new Map(previous?.frames.filter(frame=>frame.edited).map(frame=>[frame.time,frame]) ?? []);
  next.frames=next.frames.map(frame=>{
    const edited=edits.get(frame.time);
    if (!edited) return frame;
    const points=edited.manualJoints ? (frame.points ?? [null,null,null]).map((point,joint)=>
      edited.manualJoints.includes(joint)?edited.points[joint]:point) : edited.points;
    return {...frame,original:frame.points,points:structuredClone(points),edited:true,manualJoints:edited.manualJoints};
  });
  return next;
}
