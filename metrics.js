const deg = r => r * 180 / Math.PI;
const wrap = v => ((v + 180) % 360 + 360) % 360 - 180;
const usable = p => p && [p.x,p.y,p.score].every(Number.isFinite) && p.score >= .5 &&
  p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
const median = xs => {
  const a = [...xs].sort((x,y) => x-y);
  return a.length ? (a[Math.floor((a.length-1)/2)] + a[Math.floor(a.length/2)])/2 : null;
};
const delta = (a,b) => [b.x-a.x,b.y-a.y];
const length = ([x,y]) => Math.hypot(x,y);
const mean = xs => xs.reduce((a,b) => a+b,0) / xs.length;
const maxOf = (frames, key) => frames.reduce((best, row) => row[key] > best[key] ? row : best);
export const fields = [
  ['thigh', 'Thigh ROM', '°'],
  ['thighSpeed', 'Peak thigh speed', '°/s'],
  ['kneeAtPeak', 'Knee flexion at peak', '°'],
  ['kneeMax', 'Max knee flexion', '°'],
  ['shank', 'Shank ROM', '°'],
  ['shankSpeed', 'Peak shank speed', '°/s'],
  ['leg', 'Hip-to-ankle ROM', '°'],
  ['legSpeed', 'Peak hip-to-ankle speed', '°/s']
];

function geometry(frame, aspect) {
  if (!frame.points?.every(usable)) return null;
  const [h,k,a] = frame.points.map(p => ({x:p.x * aspect,y:p.y}));
  return {thigh:delta(h,k), shank:delta(k,a), leg:delta(h,a)};
}

export function analyze(frames, aspect, practice = false) {
  const empty = {suggestions:[], hz:null, flaggedFrames:0, frameCount:frames.length, reps:[]};
  if (frames.length < 8) return {...empty,suggestions:['Too few decoded frames.']};
  const steps = frames.slice(1).map((r,i) => r.time-frames[i].time);
  if (steps.some(dt => !(dt>0))) throw new Error('Frame timestamps are out of order.');
  const step = median(steps), hz = 1/step, gap = Math.max(.04, 2.5*step);
  const suggestions = hz < 100 ? ['Low decoded frame rate. Peak speeds are preliminary.'] : [];
  const vectors = frames.map(frame => geometry(frame,aspect));
  const rest = vectors.filter((v,i) => v && frames[i].time-frames[0].time <= .5);
  if (rest.length < 5) return {...empty,hz,suggestions:[...suggestions,'Could not establish a starting pose.']};
  const direction = Math.sign(median(rest.map(v => v.leg[0])));
  const angle = ([x,y]) => deg(Math.atan2(-y,x*direction));
  const keys = ['thigh','shank','leg'];
  const base = Object.fromEntries(keys.map(k => [k,median(rest.map(v => angle(v[k])))]));
  const lengths = Object.fromEntries(['thigh','shank'].map(k => [k,median(rest.map(v => length(v[k])))]));
  if (!direction || Math.abs(base.leg)>35 || lengths.thigh < .025 || lengths.shank < .025 ||
      median(rest.map(v => Math.abs(wrap(angle(v.leg)-base.leg)))) > 5) {
    return {...empty,hz,suggestions:[...suggestions,'Start with the leg extended, still and approximately horizontal. Check rotation.']};
  }
  const rows = vectors.map((v,i) => {
    const frame = frames[i];
    if (!v) return {...frame, valid:false};
    const [a,b,c] = keys.map(k => angle(v[k]));
    const sizeChange = ['thigh','shank'].some(k => {
      const ratio = length(v[k])/lengths[k];
      return ratio < .50 || ratio > 1.50;
    });
    return {...frame, thigh:wrap(a-base.thigh), shank:wrap(b-base.shank), leg:wrap(c-base.leg),
      knee:wrap(a-b), valid:!sizeChange};
  });

  // Symmetric time window. Smooth within each continuous run only.
  const half = Math.max(.038, 3.05*step);
  const traces = rows.map((r,i) => {
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
    // Local quadratic intercept preserves peaks better than a box average.
    const x = group.map(p => (p.time-r.time)/half);
    const s2 = x.reduce((s,v) => s+v*v,0), s3 = x.reduce((s,v) => s+v**3,0);
    const s4 = x.reduce((s,v) => s+v**4,0), s1 = x.reduce((s,v) => s+v,0);
    const w = x.map(v => s2*s4-s3*s3 + (s2*s3-s1*s4)*v + (s1*s3-s2*s2)*v*v);
    const total = w.reduce((s,v)=>s+v,0);
    const fitted = k => Math.abs(total)>1e-9 ? group.reduce((s,v,j)=>s+v[k]*w[j],0)/total : r[k];
    return {...r,...Object.fromEntries([...keys,'knee'].map(k => [k,fitted(k)]))};
  });

  const reps = [];
  let lastRest = null, start = null;
  function complete(end, returned) {
    const window = traces.slice(start,end+1);
    const good = window.filter(r => r.valid);
    if (!good.length) return;
    const peak = maxOf(good,'thigh');
    if (peak.thigh < 20) return;
    const issues = [];
    if (!returned) issues.push('No return to baseline');
    if (window.some((r,i) => !r.valid || (i && r.time-window[i-1].time>gap))) issues.push('Tracking or timing gap');
    if (window.some((r,i) => i && r.valid && window[i-1].valid &&
      keys.some(k => Math.abs(wrap(r[k]-window[i-1][k])) > 4 + 950*(r.time-window[i-1].time)))) {
      issues.push('Abrupt landmark change');
    }
    const estimated = Object.fromEntries(keys.flatMap(k => {
      const top = maxOf(good,k);
      let speed = 0;
      for (let i=1; i<window.length-1 && window[i].time<=top.time; i++) {
        const a = window[i-1], b = window[i+1];
        if (a.valid && b.valid) speed = Math.max(speed, (b[k]-a[k])/(b.time-a.time));
      }
      return [[k,top[k]],[k+'Speed',issues.length || !speed ? null : speed]];
    }));
    const edited = window.some(r => r.edited);
    reps.push({...estimated, kneeAtPeak:peak.knee, kneeMax:maxOf(good,'knee').knee,
      peakTime:peak.time, start:window[0].time, end:window.at(-1).time,
      practice:practice && reps.length===0, issues, edited});
  }
  traces.forEach((r,i) => {
    if (!r.valid) return;
    if (Math.abs(r.thigh)<=7) {
      if (start!==null) complete(i,true);
      start=null;
      lastRest=i;
    } else if (start===null && lastRest!==null && r.thigh>=12) {
      start=lastRest;
      lastRest=null;
    } else if (start!==null && r.time-traces[start].time>5) {
      complete(i,false);
      start=null;
    }
  });
  if (start!==null) complete(traces.length-1,false);
  return {suggestions,hz,reps,frameCount:frames.length,flaggedFrames:rows.filter(r => !r.valid).length};
}

export function summarize(result) {
  const accepted = result?.reps.filter(r => !r.practice && !r.issues.length) ?? [];
  return {count:accepted.length, metrics:Object.fromEntries(fields.map(([key]) => {
    const values=accepted.map(r => r[key]).filter(Number.isFinite);
    return [key,values.length ? mean(values) : null];
  }))};
}

export function ratio(left,right) {
  return Number.isFinite(left) && Number.isFinite(right) && right>0 ? 100*left/right : null;
}
