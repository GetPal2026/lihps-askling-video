import {analyze,fields,median,ratio,summarize} from './metrics.js';
import {flagFrames,flagSignature,nextGroup,reviewGroups} from './review.js';
import {drawFrame,engine,openVideo,scan} from './media.js';

const $ = id => document.getElementById(id);
const sides = ['left','right'];
const title = side => side[0].toUpperCase()+side.slice(1);
const newClip = file => ({file,turn:0,practice:false,braced:false,index:0,
  flags:[],reviewed:new Map()});
const state = Object.fromEntries(sides.map(side => [side,newClip()]));
const canvas=$('preview');
let selected='left', active=null, previewRequest=0, joint=null;
let viewed=null, previewSource=null, previewOpening=null;
let previewQueue=Promise.resolve(), preparing=false;

function report(message,error=false) {
  $('status').textContent=message;
  $('status').classList.toggle('error',error);
}

function closePreview() {
  previewRequest++;
  viewed=null;
  previewSource?.input.dispose();
  previewSource=null;
  previewOpening=null;
}

function controls() {
  for (const side of sides) {
    $(side).disabled=!!active;
    $('show-'+side).setAttribute('aria-pressed',String(side===selected));
  }
  const clip=state[selected];
  const available=sides.filter(side=>state[side].file);
  $('ccw').disabled=$('cw').disabled=!!active || !clip.file;
  $('process').disabled=preparing || !!active || !available.length;
  $('process').textContent=available.length===1 ? `Process ${available[0]} video` : 'Process both videos';
  $('prepare').disabled=preparing || !!active;
  $('cancel').hidden=$('progress').hidden=!active;
  $('practice-option').hidden=!clip.file;
  $('practice').disabled=!!active;
  $('practice').checked=clip.practice;
  $('brace-option').hidden=!clip.file;
  $('braced').disabled=!!active;
  $('braced').checked=clip.braced;
  $('review').hidden=!clip.data || !!active;
  if ($('review').hidden) $('review').open=false;
  $('scrub').hidden=!clip.data || !!active;
  $('position').max=Math.max(0,(clip.data?.frames.length ?? 1)-1);
  $('position').value=clip.index;
  $('frame-controls').hidden=$('scrub').hidden;
  $('previous-frame').disabled=clip.index===0 || !!active;
  $('next-frame').disabled=clip.index>=Number($('position').max) || !!active;
  updateReview(clip);
}

function updateReview(clip) {
  const groups=reviewGroups(clip.flags,clip.reviewed);
  const index=groups.findIndex(g=>g.start<=clip.index && clip.index<=g.end);
  const flags=clip.flags[clip.index] ?? [];
  const acknowledged=flags.length && clip.reviewed.get(clip.index)===flagSignature(flags);
  $('next-flag').disabled=!groups.length || !!active;
  $('mark-reviewed').disabled=index<0 || !!active;
  $('mark-reviewed').textContent=index>=0 && groups[index].start!==groups[index].end
    ? 'Mark stretch reviewed' : 'Mark reviewed';
  const count=groups.length ? `${groups.length} flagged ${groups.length===1?'item':'items'} to review.` : 'No pending flags.';
  const current=index>=0
    ? ` Item ${index+1} of ${groups.length} · ${groups[index].knee?'Knee review · ':''}${flags.map(f=>f.reason).join(' · ')}.`
    : acknowledged?' This frame was marked reviewed.':'';
  $('flag-status').textContent=count+current;
  $('restore').disabled=!clip.data?.frames[clip.index]?.edited || !!active;
}

function overlay(points) {
  const ctx=canvas.getContext('2d');
  const coords=(points ?? []).map(p=> p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.score>=.5
    ? [p.x*canvas.width,p.y*canvas.height] : null);
  ctx.lineWidth=Math.max(2,canvas.width/230);
  ctx.strokeStyle='#24baff';
  for (let i=1;i<coords.length;i++) {
    if (!coords[i-1] || !coords[i]) continue;
    ctx.beginPath();ctx.moveTo(...coords[i-1]);ctx.lineTo(...coords[i]);ctx.stroke();
  }
  for (const point of coords) {
    if (!point) continue;
    ctx.beginPath();ctx.arc(...point,Math.max(3,canvas.width/140),0,Math.PI*2);
    ctx.fillStyle='#fff';ctx.fill();ctx.stroke();
  }
}

async function preview() {
  const serial=++previewRequest;
  viewed=null;
  const side=selected, clip=state[side], index=clip.index;
  $('time').textContent='';
  if (!clip.file || active) {
    canvas.hidden=true;
    $('placeholder').hidden=false;
    $('placeholder').textContent=active?'Processing video frames…':'Select a clip to preview';
    return;
  }
  try {
    if (!previewSource) {
      const pending=previewOpening ??=openVideo(clip.file);
      const source=await pending;
      if (pending!==previewOpening && source!==previewSource) {
        source.input.dispose();
        return;
      }
      previewSource=source;
      if (previewOpening===pending) previewOpening=null;
    }
    if (serial!==previewRequest) return;
    const {start,sink}=previewSource;
    const frame=clip.data?.frames[index];
    const task=previewQueue.then(()=>serial===previewRequest
      ? sink.getSample(start+(frame?.time ?? 0)+1e-7) : null);
    previewQueue=task.catch(()=>null);
    const sample=await task;
    if (serial!==previewRequest) {sample?.close();return;}
    if (!sample) throw new Error('No frame is available at this position.');
    try {
      if (serial!==previewRequest) return;
      drawFrame(canvas,sample,clip.turn);
      overlay(frame?.points);
      if (frame && Math.abs(sample.timestamp-(start+frame.time))>0.00001)
        throw new Error('The decoder returned a different frame. Choose the frame again.');
      $('time').textContent=frame ? `${index+1}/${clip.data.frames.length} · ${frame.time.toFixed(3)} s` : '';
      canvas.hidden=false;
      $('placeholder').hidden=true;
      viewed={side,index};
    } finally {sample.close();}
  } catch (error) {
    if (serial!==previewRequest) return;
    closePreview();
    canvas.hidden=true;
    $('placeholder').hidden=false;
    $('placeholder').textContent='Preview unavailable';
    report(error.message,true);
  }
}

function choose(side,index=state[side].index) {
  if (side!==selected) {
    closePreview();
    $('review').open=false;
  }
  selected=side;
  state[side].index=index;
  controls();
  void preview();
}

const num=(value,unit='')=>Number.isFinite(value)?value.toFixed(1)+unit:'—';
function table(container,head,rows) {
  const t=document.createElement('table');
  const row=t.createTHead().insertRow();
  for (const label of head) {
    const cell=document.createElement('th');
    cell.scope='col';cell.textContent=label;row.append(cell);
  }
  const body=t.createTBody();
  for (const values of rows) {
    const entry=body.insertRow();
    for (const value of values) entry.insertCell().textContent=value;
  }
  container.replaceChildren(t);
}

function recalculate(side) {
  const clip=state[side];
  if (!clip.data) return;
  const {frames,aspect}=clip.data;
  clip.flags=flagFrames(frames,aspect,clip.braced,clip.data.hz);
  const result=analyze(frames,aspect,clip.practice,clip.braced,clip.flags);
  clip.result=result;
  if (side===selected) updateReview(clip);
}

function renderResults() {
  $('summary').hidden=$('repetitions').hidden=!sides.some(s=>state[s].result);
  if ($('summary').hidden) return;
  const [l,r]=sides.map(s=>summarize(state[s].result));
  $('counts').textContent=`Mean of usable scored raises · Left ${l.count} · Right ${r.count}`;
  const formatMetric=(summary,key,unit)=>{
    const value=num(summary.metrics[key],unit);
    const n=summary.counts[key];
    return n && n<summary.count ? `${value} (n=${n})` : value;
  };
  table($('summary-table'),['Measure','Left','Right','L/R'],fields.map(([key,label,unit])=>[
    label,formatMetric(l,key,unit),formatMetric(r,key,unit),
    key.startsWith('knee')?'—':num(ratio(l.metrics[key],r.metrics[key]),'%')
  ]));
  const notes=sides.flatMap(s=>{
    const result=state[s].result;
    if (!result) return [];
    const extra=[...result.suggestions];
    if (result.reps.filter(r=>!r.practice).length!==3) extra.push('Check the detected rep count.');
    if (result.braced) extra.push('Braced mode uses hip-to-ankle elevation to detect raises and select the preview peak.');
    const flags=state[s].flags.filter(list=>list.length).length;
    if (flags) extra.push(`${flags} frames flagged for review.`);
    return [`${title(s)} · ${num(result.hz,' fps')} · ${result.frameCount} frames. ${extra.join(' ')}`];
  });
  $('quality').textContent=notes.join(' ');
  const list=$('rep-list');
  const expanded=new Set([...list.querySelectorAll('details[open]')].map(el=>el.dataset.rep));
  list.replaceChildren();
  for (const side of sides) {
    const result=state[side].result;
    if (!result) continue;
    const heading=document.createElement('h3');
    heading.className='reps-heading';heading.textContent=title(side);list.append(heading);
    if (!result.reps.length) {
      const note=document.createElement('p');note.textContent='No raises detected.';list.append(note);
    }
    let scored=0;
    for (const [i,rep] of result.reps.entries()) {
      const details=document.createElement('details');
      details.className='rep';details.dataset.rep=side+i;details.open=expanded.has(side+i);
      const summary=document.createElement('summary');
      const label=rep.practice?'Practice':`Raise ${++scored}`;
      const key=result.braced?'leg':'thigh';
      const trackIssues=[...rep.issues,...rep.kneeIssues];
      summary.textContent=`${label} · ${num(rep[key],'°')} · ${num(rep[key+'Speed'],'°/s')}${trackIssues.length?' · Check tracking':''}`;
      function showPeak() {
        const frames=state[side].data.frames;
        const index=frames.findIndex(r=>r.time===rep.peakTime);
        choose(side,Math.max(0,index));
      }
      const values=document.createElement('div');
      table(values,['Measure','Value'],fields.map(([key,name,unit])=>[name,num(rep[key],unit)]));
      const qc=document.createElement('p');
      qc.textContent=`Peak at ${rep.peakTime.toFixed(2)} s. `+
        (trackIssues.join(' · ') || 'No repetition-level QC flags.')+(rep.edited?' Includes manual landmark edits.':'');
      const peak=document.createElement('button');
      peak.className='soft';peak.textContent='Show peak frame';
      peak.addEventListener('click',()=>{showPeak();$('viewer').scrollIntoView({block:'center'});});
      details.append(summary,values,qc,peak);
      list.append(details);
    }
  }
}

for (const side of sides) {
  $(side).addEventListener('change',()=>{
    const file=$(side).files[0];
    if (!file) return;
    closePreview();
    state[side]=newClip(file);
    $(side+'-name').textContent=file.name;
    report(sides.every(s=>state[s].file)?'Check each preview, then process both videos.':`Check the preview, then process the ${side} video. You can also add the other leg.`);
    renderResults();choose(side);
  });
  $('show-'+side).addEventListener('click',()=>choose(side));
}
for (const [id,angle] of [['ccw',270],['cw',90]]) {
  $(id).addEventListener('click',()=>{
    const clip=state[selected];
    clip.turn=(clip.turn+angle)%360;
    clip.data=null;clip.result=null;clip.index=0;clip.flags=[];clip.reviewed.clear();
    report('Rotation updated. Process the selected videos to update measurements.');
    renderResults();choose(selected);
  });
}
$('position').addEventListener('input',()=>choose(selected,Number($('position').value)));
$('previous-frame').addEventListener('click',()=>choose(selected,Math.max(0,state[selected].index-1)));
$('next-frame').addEventListener('click',()=>{
  const clip=state[selected];
  choose(selected,Math.min(clip.data.frames.length-1,clip.index+1));
});
$('next-flag').addEventListener('click',()=>{
  const clip=state[selected];
  const group=nextGroup(reviewGroups(clip.flags,clip.reviewed),clip.index);
  if (!group) return;
  $('review').open=true;
  choose(selected,group.start);
});
$('mark-reviewed').addEventListener('click',()=>{
  const clip=state[selected];
  const group=reviewGroups(clip.flags,clip.reviewed).find(g=>g.start<=clip.index && clip.index<=g.end);
  if (!group) return;
  for (let i=group.start;i<=group.end;i++) clip.reviewed.set(i,flagSignature(clip.flags[i]));
  updateReview(clip);
});
$('braced').addEventListener('change',()=>{
  const clip=state[selected];
  clip.braced=$('braced').checked;
  clip.reviewed.clear();
  recalculate(selected);
  renderResults();
});
$('practice').addEventListener('change',()=>{
  state[selected].practice=$('practice').checked;
  recalculate(selected);renderResults();
});
$('prepare').addEventListener('click',async()=>{
  if (active || preparing) return;
  preparing=true;controls();
  report('Downloading the pose model and decoder…');
  let model;
  try {
    if (!navigator.serviceWorker?.controller) throw new Error('Reload this HTTPS page once before preparing offline use.');
    model=await engine();
    report('Model and decoder loaded. Verify offline by reopening the app with networking off.');
  } catch(error) {report(error.message,true);}
  finally {model?.close();preparing=false;controls();}
});

$('process').addEventListener('click',async()=>{
  const available=sides.filter(side=>state[side].file);
  if (active || preparing || !available.length) return;
  active=new AbortController();
  const signal=active.signal;
  closePreview();
  controls();
  void preview();
  $('progress').removeAttribute('value');
  report('Loading MediaPipe Full…');
  for (const side of available) {
    const clip=state[side];clip.data=null;clip.result=null;clip.index=0;clip.flags=[];clip.reviewed.clear();
  }
  renderResults();
  try {
    for (const side of available) {
      signal.throwIfAborted();
      const clip=state[side];
      const model=await engine();
      try {
        const data=await scan(clip.file,side,clip.turn,model,signal,(count,time) =>
          report(`${title(side)} · ${count} frames · ${time.toFixed(1)} s of video`));
        signal.throwIfAborted();
        const intervals=data.frames.slice(1).map((row,i)=>row.time-data.frames[i].time);
        const step=median(intervals);
        clip.data={...data,hz:step>0?1/step:null};
        recalculate(side);
      } finally {model.close();}
    }
    report(available.length===2 ? 'Both videos processed. Review the overlay before using the measurements.' : `${title(available[0])} video processed. Review the overlay before using the measurements.`);
  } catch (error) {
    report(signal.aborted?'Processing stopped. Completed clips can still be reviewed.':error.message,!signal.aborted);
  } finally {
    active=null;
    renderResults();choose(available.find(side=>state[side].data) ?? available[0]);
  }
});
$('cancel').addEventListener('click',()=>active?.abort());

document.querySelectorAll('[data-joint]').forEach(button=>{
  button.addEventListener('click',()=>{
    joint=Number(button.dataset.joint);
    for (const b of document.querySelectorAll('[data-joint]')) b.setAttribute('aria-pressed',String(b===button));
    $('correction-note').textContent=`Tap the ${button.textContent.toLowerCase()} on the preview. The selected joint stays active as you step through frames.`;
    $('viewer').scrollIntoView({block:'center'});
  });
});
canvas.addEventListener('click',event=>{
  if (joint===null || !viewed || !$('review').open || active) return;
  const clip=state[viewed.side], frame=clip.data?.frames[viewed.index];
  if (!frame) return;
  const rect=canvas.getBoundingClientRect();
  if (!frame.edited) frame.original=frame.points?.map(p=>p&&{...p}) ?? null;
  frame.points ??= [null,null,null];
  frame.points[joint]={x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height,score:1};
  frame.edited=true;
  clip.reviewed.delete(viewed.index);
  recalculate(viewed.side);renderResults();void preview();
});
$('restore').addEventListener('click',()=>{
  const clip=state[selected], frame=clip.data?.frames[clip.index];
  if (!frame?.edited) return;
  frame.points=frame.original;delete frame.original;delete frame.edited;
  clip.reviewed.delete(clip.index);
  recalculate(selected);renderResults();void preview();
});
$('export').addEventListener('click',()=>{
  const rows=[['side','raise','practice','braced_knee','peak_time_s','peak_frame_basis',...fields.map(([key,,unit])=>key+(unit==='°/s'?'_deg_per_s':'_deg')),'qc','knee_tracking_qc','manual_edits','decoded_fps']];
  for (const side of sides) {
    const result=state[side].result;
    result?.reps.forEach((r,i)=>rows.push([
      side,i+1,r.practice,result.braced,r.peakTime,result.braced?'hip-to-ankle':'thigh',
      ...fields.map(([key])=>r[key]),r.issues.join(' · '),r.kneeIssues.join(' · '),!!r.edited,result.hz
    ]));
  }
  const csv=rows.map(row=>row.map(value=>'"'+String(value??'').replaceAll('"','""')+'"').join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  const link=document.createElement('a');link.href=url;link.download='lihps-askling-video.csv';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
});
if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('./sw.js').catch(()=>{});
controls();
