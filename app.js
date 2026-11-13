import {analyze,fields,ratio,summarize} from './metrics.js';
import {drawFrame,engine,openVideo,scan} from './media.js';

const $ = id => document.getElementById(id);
const sides = ['left','right'];
const title = side => side[0].toUpperCase()+side.slice(1);
const state = Object.fromEntries(sides.map(side => [side,{turn:0,practice:false,index:0}]));
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
  $('ccw').disabled=$('cw').disabled=!!active || !clip.file;
  $('process').disabled=preparing || !!active || !sides.every(side=>state[side].file);
  $('prepare').disabled=preparing || !!active;
  $('cancel').hidden=$('progress').hidden=!active;
  $('practice-option').hidden=!clip.file;
  $('practice').disabled=!!active;
  $('practice').checked=clip.practice;
  $('review').hidden=!clip.data || !!active;
  if ($('review').hidden) $('review').open=false;
  $('scrub').hidden=!clip.data || !!active;
  $('position').max=Math.max(0,(clip.data?.frames.length ?? 1)-1);
  $('position').value=clip.index;
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
      $('time').textContent=frame ? frame.time.toFixed(2)+' s' : '';
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
  if (clip.data) clip.result=analyze(clip.data.frames,clip.data.aspect,clip.practice);
}

function renderResults() {
  $('summary').hidden=$('repetitions').hidden=!sides.some(s=>state[s].result);
  if ($('summary').hidden) return;
  const [l,r]=sides.map(s=>summarize(state[s].result));
  $('counts').textContent=`Mean of usable scored raises · Left ${l.count} · Right ${r.count}`;
  table($('summary-table'),['Measure','Left','Right','L/R'],fields.map(([key,label,unit])=>[
    label,num(l.metrics[key],unit),num(r.metrics[key],unit),
    key.startsWith('knee')?'—':num(ratio(l.metrics[key],r.metrics[key]),'%')
  ]));
  const notes=sides.flatMap(s=>{
    const result=state[s].result;
    if (!result) return [];
    const extra=[...result.suggestions];
    if (result.reps.filter(r=>!r.practice).length!==3) extra.push('Check the detected rep count.');
    if (result.flaggedFrames) extra.push(`${result.flaggedFrames} frames flagged.`);
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
      summary.textContent=`${label} · ${num(rep.thigh,'°')} · ${num(rep.thighSpeed,'°/s')}${rep.issues.length?' · Check tracking':''}`;
      function showPeak() {
        const frames=state[side].data.frames;
        const index=frames.findIndex(r=>r.time===rep.peakTime);
        choose(side,Math.max(0,index));
      }
      const values=document.createElement('div');
      table(values,['Measure','Value'],fields.map(([key,name,unit])=>[name,num(rep[key],unit)]));
      const qc=document.createElement('p');
      qc.textContent=`Peak at ${rep.peakTime.toFixed(2)} s. `+
        (rep.issues.join(' · ') || 'No automatic QC flags.')+(rep.edited?' Includes manual landmark edits.':'');
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
    state[side]={file,turn:0,practice:false,index:0};
    $(side+'-name').textContent=file.name;
    report(sides.every(s=>state[s].file)?'Check each preview, then process both videos.':'Choose the other leg’s video.');
    renderResults();choose(side);
  });
  $('show-'+side).addEventListener('click',()=>choose(side));
}
for (const [id,angle] of [['ccw',270],['cw',90]]) {
  $(id).addEventListener('click',()=>{
    const clip=state[selected];
    clip.turn=(clip.turn+angle)%360;
    clip.data=null;clip.result=null;clip.index=0;
    report('Rotation updated. Process both clips to update measurements.');
    renderResults();choose(selected);
  });
}
$('position').addEventListener('input',()=>choose(selected,Number($('position').value)));
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
  if (active || preparing || !sides.every(side=>state[side].file)) return;
  active=new AbortController();
  const signal=active.signal;
  closePreview();
  controls();
  void preview();
  $('progress').removeAttribute('value');
  report('Loading MediaPipe Full…');
  for (const side of sides) {
    const clip=state[side];clip.data=null;clip.result=null;clip.index=0;
  }
  renderResults();
  try {
    for (const side of sides) {
      signal.throwIfAborted();
      const clip=state[side];
      const model=await engine();
      try {
        const data=await scan(clip.file,side,clip.turn,model,signal,(count,time) =>
          report(`${title(side)} · ${count} frames · ${time.toFixed(1)} s of video`));
        signal.throwIfAborted();
        clip.data=data;
        recalculate(side);
      } finally {model.close();}
    }
    report('Both videos processed. Review the overlay before using the measurements.');
  } catch (error) {
    report(signal.aborted?'Processing stopped. Completed clips can still be reviewed.':error.message,!signal.aborted);
  } finally {
    active=null;
    renderResults();choose(state.left.data?'left':selected);
  }
});
$('cancel').addEventListener('click',()=>active?.abort());

document.querySelectorAll('[data-joint]').forEach(button=>{
  button.addEventListener('click',()=>{
    joint=Number(button.dataset.joint);
    for (const b of document.querySelectorAll('[data-joint]')) b.setAttribute('aria-pressed',String(b===button));
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
  recalculate(viewed.side);renderResults();void preview();
});
$('restore').addEventListener('click',()=>{
  const clip=state[selected], frame=clip.data?.frames[clip.index];
  if (!frame?.edited) return;
  frame.points=frame.original;delete frame.original;delete frame.edited;
  recalculate(selected);renderResults();void preview();
});
$('export').addEventListener('click',()=>{
  const rows=[['side','raise','practice','peak_time_s',...fields.map(([key,,unit])=>key+(unit==='°/s'?'_deg_per_s':'_deg')),'qc','manual_edits','decoded_fps']];
  for (const side of sides) {
    const result=state[side].result;
    result?.reps.forEach((r,i)=>rows.push([
      side,i+1,r.practice,r.peakTime,...fields.map(([key])=>r[key]),r.issues.join(' · '),!!r.edited,result.hz
    ]));
  }
  const csv=rows.map(row=>row.map(value=>'"'+String(value??'').replaceAll('"','""')+'"').join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  const link=document.createElement('a');link.href=url;link.download='lihps-askling-video.csv';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
});
if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('./sw.js').catch(()=>{});
controls();
