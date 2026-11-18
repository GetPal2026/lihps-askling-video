import {median,usable} from './metrics.js';

const joints=['Hip','Knee','Ankle'];
const segments=[
  {name:'Thigh',from:0,to:1},
  {name:'Shank',from:1,to:2},
  {name:'Hip-to-ankle',from:0,to:2}
];

function distance(a,b,aspect) {
  return Math.hypot((a.x-b.x)*aspect,a.y-b.y);
}

export function flagFrames(frames,aspect,braced,fps) {
  const flags=frames.map(()=>[]);
  const add=(index,reason,knee=false)=>flags[index].push({reason,knee});
  const pairs=braced?[segments[2],...segments.slice(0,2)]:segments.slice(0,2);
  const lengths=pairs.map(({from,to})=>frames.map(({points})=>
    usable(points?.[from]) && usable(points?.[to]) ? distance(points[from],points[to],aspect) : null));
  const centers=lengths.map(values=>median(values.filter(Number.isFinite)));
  const reference=braced?centers[0]:centers.reduce((sum,value)=>sum+(value??0),0);
  pairs.forEach(({name},i)=>{
    const center=centers[i];
    if (!(center>0)) return;
    const values=lengths[i].filter(Number.isFinite);
    if (values.length<5) return;
    const deviation=median(values.map(value=>Math.abs(value-center)));
    const threshold=Math.max(3*1.4826*deviation,center*.12);
    for (const [index,value] of lengths[i].entries()) {
      if (value!==null && Math.abs(value-center)>threshold)
        add(index,`${name} length unusually ${value>center?'long':'short'}`,braced && name!=='Hip-to-ankle');
    }
  });
  const gap=Math.max(.04,2.5/(fps||30));
  for (const [i,frame] of frames.entries()) {
    const before=frames[i-1],after=frames[i+1];
    if (before && frame.time-before.time>gap) add(i,'Gap in video timestamps');
    for (const [j,name] of joints.entries()) {
      const point=frame.points?.[j];
      const knee=braced && j===1;
      if (!usable(point)) {
        add(i,`${name} missing or low confidence`,knee);
        continue;
      }
      const a=before?.points?.[j], b=after?.points?.[j];
      if (!(reference>0) || !usable(a) || !usable(b) || frame.time-before.time>gap ||
          after.time-frame.time>gap) continue;
      const fraction=(frame.time-before.time)/(after.time-before.time);
      const expected={x:a.x+(b.x-a.x)*fraction,y:a.y+(b.y-a.y)*fraction};
      if (distance(point,expected,aspect)>reference*.065)
        add(i,`${name} jumps between frames`,knee);
    }
  }
  return flags;
}

export function flagSignature(flags) {
  return flags.map(flag=>flag.reason).join('|');
}

export function reviewGroups(flags,reviewed) {
  const groups=[];
  let current=null;
  flags.forEach((list,index)=>{
    if (!list.length || reviewed.get(index)===flagSignature(list)) {
      current=null;
      return;
    }
    const knee=list.every(flag=>flag.knee);
    if (!current || current.knee!==knee) {
      current={start:index,end:index,knee,reasons:new Set()};
      groups.push(current);
    }
    current.end=index;
    for (const {reason} of list) current.reasons.add(reason);
  });
  return groups.sort((a,b)=>Number(a.knee)-Number(b.knee)||a.start-b.start);
}

export function nextGroup(groups,index) {
  const current=groups.findIndex(group=>group.start<=index && index<=group.end);
  if (current>=0) return groups[(current+1)%groups.length];
  return groups.find(group=>!group.knee && group.start>index) ?? groups[0];
}
