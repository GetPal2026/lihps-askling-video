const deg = r => r * 180 / Math.PI;
const wrap = v => ((v + 180) % 360 + 360) % 360 - 180;
export const usable = p => p && [p.x,p.y,p.score].every(Number.isFinite) && p.score >= .5 &&
  p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
export const median = xs => {
  const a = [...xs].sort((x,y) => x-y);
  return a.length ? (a[Math.floor((a.length-1)/2)] + a[Math.floor(a.length/2)])/2 : null;
};
const delta = (a,b) => [b.x-a.x,b.y-a.y];
const length = ([x,y]) => Math.hypot(x,y);
const mean = xs => xs.reduce((a,b) => a+b,0) / xs.length;
const maxOf = (frames, key) => frames.reduce((best, row) => row[key] > best[key] ? row : best);
export const fields = [
  ['thigh', 'Hip flexion ROM', '°'],
  ['thighSpeed', 'Peak hip flexion speed', '°/s'],
  ['kneeAtPeak', 'Knee flexion at peak', '°'],
  ['kneeMax', 'Max knee flexion', '°'],
  ['shank', 'Shank ROM', '°'],
  ['shankSpeed', 'Peak shank speed', '°/s'],
  ['leg', 'Whole-leg ROM', '°'],
  ['legSpeed', 'Peak whole-leg speed', '°/s']
];

function geometry(frame, aspect) {
  const [hip,knee,ankle]=frame.points ?? [];
  if (!usable(hip) || !usable(ankle)) return null;
  const [h,a]=[hip,ankle].map(p=>({x:p.x*aspect,y:p.y}));
  const geometry={leg:delta(h,a)};
  if (usable(knee)) {
    const k={x:knee.x*aspect,y:knee.y};
    geometry.thigh=delta(h,k);
    geometry.shank=delta(k,a);
  }
  return geometry;
}

function smooth(rows,keys,half,gap) {
  return rows.map((r,i) => {
    if (!r.valid) return r;
    const group = [r];
    for (const direction of [-1,1]) {
      let j = i + direction;
      while (rows[j]?.valid && Math.abs(rows[j].time-r.time) <= half &&
        Math.abs(rows[j].time-rows[j-direction].time) <= gap) {
        group.push(rows[j]);
        j += direction;
      }
    }
    // Symmetric local quadratic fit, confined to continuous runs.
    const x = group.map(p => (p.time-r.time)/half);
    const s2 = x.reduce((s,v) => s+v*v,0), s3 = x.reduce((s,v) => s+v**3,0);
    const s4 = x.reduce((s,v) => s+v**4,0), s1 = x.reduce((s,v) => s+v,0);
    const w = x.map(v => s2*s4-s3*s3 + (s2*s3-s1*s4)*v + (s1*s3-s2*s2)*v*v);
    const total = w.reduce((s,v)=>s+v,0);
    const fitted = k => Math.abs(total)>1e-9 ? group.reduce((s,v,j)=>s+v[k]*w[j],0)/total : r[k];
    return {...r,...Object.fromEntries(keys.map(k => [k,fitted(k)]))};
  });
}

function gaps(rows,gap) {
  return rows.some((r,i)=>!r.valid || (i && r.time-rows[i-1].time>gap));
}

function jumps(rows,keys) {
  return rows.some((r,i)=>i && r.valid && rows[i-1].valid &&
    keys.some(k=>Math.abs(wrap(r[k]-rows[i-1][k]))>4+950*(r.time-rows[i-1].time)));
}

function measure(rows,key,issues) {
  const top=maxOf(rows.filter(r=>r.valid),key);
  let speed=0;
  for (let i=1;i<rows.length-1 && rows[i].time<=top.time;i++) {
    const a=rows[i-1], b=rows[i+1];
    if (a.valid && b.valid) speed=Math.max(speed,(b[key]-a[key])/(b.time-a.time));
  }
  return {[key]:top[key],[key+'Speed']:issues.length || !speed ? null : speed};
}

export function analyze(frames, aspect, practice = false, braced = false, frameFlags = [], referenceIndex = null) {
  const empty = {suggestions:[], hz:null, flaggedFrames:0, frameCount:frames.length, reps:[],braced};
  if (frames.length < 8) return {...empty,suggestions:['Too few decoded frames.']};
  const steps = frames.slice(1).map((r,i) => r.time-frames[i].time);
  if (steps.some(dt => !(dt>0))) throw new Error('Frame timestamps are out of order.');
  const step=median(steps),hz=1/step,gap=Math.max(.04,2.5*step);
  const suggestions=hz<100?['Low decoded frame rate. Peak speeds are preliminary.']:[];
  const vectors=frames.map(frame=>geometry(frame,aspect));
  let rest=[];
  if (referenceIndex!==null) {
    const chosen=vectors[referenceIndex];
    if (chosen && (braced || chosen.thigh)) rest=[chosen];
  } else {
    const available=vectors.map((v,i)=>({v,i})).filter(({v,i})=>
      v && (braced || v.thigh) && frames[i].time-frames[0].time<=.5);
    const seed=available.filter(({i},index)=>index<5 || frames[i].time-frames[0].time<=.12).map(({v})=>v);
    if (seed.length>=5) {
      const heading=v=>deg(Math.atan2(-v.leg[1],Math.abs(v.leg[0])));
      const initial=median(seed.map(heading));
      for (const {v} of available) {
        if (Math.abs(wrap(heading(v)-initial))>5) break;
        rest.push(v);
      }
    }
  }
  const kneeRest=rest.filter(v=>v.thigh);
  const baseRest=braced?rest:kneeRest;
  if (baseRest.length<(referenceIndex===null?5:1)) return {...empty,hz,suggestions:[...suggestions,'Could not establish a starting pose.']};
  const direction=Math.sign(median(baseRest.map(v=>v.leg[0])));
  const angle=([x,y])=>deg(Math.atan2(-y,x*direction));
  const kneeKeys=['thigh','shank'];
  const baseLeg=median(baseRest.map(v=>angle(v.leg)));
  const base=Object.fromEntries(kneeKeys.map(k=>[k,median(kneeRest.map(v=>angle(v[k])))]));
  const lengths=Object.fromEntries(kneeKeys.map(k=>[k,median(kneeRest.map(v=>length(v[k])))]));
  const legLength=median(baseRest.map(v=>length(v.leg)));
  const kneeBaseline=kneeRest.length>=(referenceIndex===null?5:1) && kneeKeys.every(k=>lengths[k]>=.025);
  if (!direction || Math.abs(baseLeg)>35 || legLength<.05 || (!braced && !kneeBaseline) ||
      median(baseRest.map(v=>Math.abs(wrap(angle(v.leg)-baseLeg))))>5) {
    return {...empty,hz,suggestions:[...suggestions,'Start with the leg extended, still and approximately horizontal. Check rotation.']};
  }
  const rows=vectors.map((v,i)=>{
    const frame=frames[i];
    const invalid={...frame,valid:false};
    if (!v) return {leg:invalid,knee:invalid};
    const leg=wrap(angle(v.leg)-baseLeg);
    const legRatio=length(v.leg)/legLength;
    const legRow={...frame,leg,valid:legRatio>=.5 && legRatio<=1.5};
    if (!kneeBaseline || !v.thigh) return {leg:legRow,knee:invalid};
    const [a,b]=kneeKeys.map(k=>angle(v[k]));
    const valid=kneeKeys.every(k=>{
      const proportion=length(v[k])/lengths[k];
      return proportion>=.50 && proportion<=1.50;
    });
    return {leg:legRow,knee:{...frame,thigh:wrap(a-base.thigh),shank:wrap(b-base.shank),
      leg,knee:wrap(a-b),valid}};
  });

  const half=Math.max(.038,3.05*step);
  const full=smooth(rows.map(r=>r.knee),[...kneeKeys,'leg','knee'],half,gap);
  const traces=braced?smooth(rows.map(r=>r.leg),['leg'],half,gap):full;
  const primary=braced?'leg':'thigh';
  const primaryKeys=braced?['leg']:[...kneeKeys,'leg'];
  const reps=[];
  let lastRest=null,start=null;
  function complete(end,returned) {
    const window=traces.slice(start,end+1);
    const good=window.filter(r=>r.valid);
    if (!good.length) return;
    const peak=maxOf(good,primary);
    if (peak[primary]<20) return;
    const issues=[];
    if (!returned) issues.push('No return to baseline');
    if (gaps(window,gap)) issues.push('Tracking or timing gap');
    if (jumps(window,primaryKeys)) issues.push('Abrupt landmark change');
    const estimated=Object.assign({},...primaryKeys.map(k=>measure(window,k,issues)));
    const kneeWindow=full.slice(start,end+1);
    const kneeIssues=[];
    const kneeFlagged=frameFlags.slice(start,end+1).some(list=>list.some(flag=>flag.knee));
    if (braced && (!kneeBaseline || kneeFlagged || gaps(kneeWindow,gap) || jumps(kneeWindow,kneeKeys))) {
      kneeIssues.push('Knee tracking incomplete or unstable. Thigh, shank and knee values withheld.');
    }
    if (!kneeIssues.length) {
      if (braced) Object.assign(estimated,...kneeKeys.map(k=>measure(kneeWindow,k,issues)));
      estimated.kneeAtPeak=maxOf(kneeWindow.filter(r=>r.valid),'thigh').knee;
      estimated.kneeMax=maxOf(kneeWindow.filter(r=>r.valid),'knee').knee;
    }
    reps.push({...estimated,peakTime:peak.time,start:window[0].time,end:window.at(-1).time,
      practice:practice && reps.length===0,issues,kneeIssues,edited:window.some(r=>r.edited || r.propagated)});
  }
  traces.forEach((r,i) => {
    if (!r.valid) return;
    if (Math.abs(r[primary])<=7) {
      if (start!==null) complete(i,true);
      start=null;
      lastRest=i;
    } else if (start===null && lastRest!==null && r[primary]>=12) {
      start=lastRest;
      lastRest=null;
    } else if (start!==null && r.time-traces[start].time>5) {
      complete(i,false);
      start=null;
    }
  });
  if (start!==null) complete(traces.length-1,false);
  return {suggestions,hz,reps,braced,frameCount:frames.length,flaggedFrames:traces.filter(r=>!r.valid).length};
}

export function selectReps(result) {
  const reps=result?.reps ?? [];
  const key=result?.braced?'leg':'thigh';
  const eligible=reps.map((rep,index)=>({rep,index}))
    .filter(({rep})=>!rep.practice && !rep.excluded && !rep.issues.length &&
      Number.isFinite(rep[key]) && Number.isFinite(rep[key+'Speed']));
  const rank=(entry,metric)=>1+eligible.filter(other=>other.rep[metric]>entry.rep[metric]).length;
  const ranked=eligible.map(entry=>({
    ...entry,score:rank(entry,key)+rank(entry,key+'Speed')
  })).sort((a,b)=>a.score-b.score || b.rep[key]-a.rep[key] ||
    b.rep[key+'Speed']-a.rep[key+'Speed'] || a.index-b.index);
  const selected=new Set(ranked.slice(0,3).map(entry=>entry.index));
  return reps.map((rep,index)=>({
    included:selected.has(index),
    reason:rep.practice?'Practice':rep.excluded?'Excluded by examiner':
      rep.issues.length || !Number.isFinite(rep[key+'Speed'])?'QC excluded':
      selected.has(index)?'Selected':'Below best three',
    rank:ranked.findIndex(entry=>entry.index===index)+1 || null
  }));
}

export function summarize(result) {
  const selection=selectReps(result);
  const accepted=result?.reps.filter((rep,index)=>selection[index].included) ?? [];
  const counts={};
  const metrics=Object.fromEntries(fields.map(([key])=>{
    const values=accepted.map(r=>r[key]).filter(Number.isFinite);
    counts[key]=values.length;
    return [key,values.length?mean(values):null];
  }));
  return {count:accepted.length,metrics,counts,selection};
}

export function ratio(left,right) {
  return Number.isFinite(left) && Number.isFinite(right) && right>0 ? 100*left/right : null;
}
