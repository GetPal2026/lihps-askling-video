import {fields,median,ratio,summarize} from './metrics.js';
import {flagFrames,flagSignature,nextGroup,reviewGroups} from './review.js';
import {calculate,preserveEdits,timedFrames} from './analysis.js';
import {seedBrace} from './brace.js';
import {braceImage,drawFrame,engine,inspectVideo,openVideo,scan} from './media.js';

const $ = id => document.getElementById(id);
const sides = ['left','right'];
const title = side => side[0].toUpperCase()+side.slice(1);
const newClip = file => ({file,turn:0,practice:false,braced:false,index:0,
  flags:[],reviewed:new Map(),excluded:new Set(),dirty:false,revision:0,captureFps:null,referenceIndex:null,
  braceSeed:null,poseOnly:false,propagate:false});
const state = Object.fromEntries(sides.map(side => [side,newClip()]));
const canvas=$('preview');
let selected='left', active=null, previewRequest=0, joint=null;
let viewed=null, previewSource=null, previewOpening=null, guide=null;
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

const activeSeed=clip=>clip.braced ? clip.braceSeed : null;
const requiresGuide=clip=>clip.braced && !clip.braceSeed && !clip.poseOnly;
const needsProcessing=clip=>!!clip.data && (clip.data.braceSeed ?? null)!==activeSeed(clip);
const guideSteps=[['hip','Tap the centre of the tested hip.'],['ankle','Tap the centre of the tested ankle.'],
  ['panel','Tap the middle of a solid brace panel, away from the straps and table.']];

function updateGuide(clip) {
  const placing=guide?.side===selected;
  $('brace-guide').hidden=!clip.braced || !clip.file;
  $('brace-prompt').hidden=!placing;
  $('brace-prompt').textContent=placing ? guideSteps[guide.step][1] : '';
  $('seed-brace').disabled=!!active;
  $('seed-brace').textContent=placing?'Cancel guide':clip.braceSeed?'Replace brace guide':'Place brace guide';
  $('clear-brace').hidden=!clip.braceSeed || placing;
  $('clear-brace').disabled=!!active;
  $('pose-only-option').hidden=!!clip.braceSeed || placing;
  $('pose-only').disabled=!!active;
  $('pose-only').checked=clip.poseOnly;
  $('brace-status').textContent=clip.braceSeed
    ? 'Guide placed. Processing follows the brace and estimates the hip-to-ankle line.'
    : clip.poseOnly ? 'This clip will use pose detection with braced-knee quality checks.'
    : 'On the first resting frame, mark the hip, ankle and a padded brace panel.';
  $('propagate-option').hidden=!clip.data?.braceSeed;
  $('propagate').checked=clip.propagate;
}

function controls() {
  for (const side of sides) {
    $(side).disabled=!!active;
    $('show-'+side).setAttribute('aria-pressed',String(side===selected));
  }
  const clip=state[selected];
  const available=sides.filter(side=>state[side].file);
  $('ccw').disabled=$('cw').disabled=!!active || !clip.file;
  $('process').disabled=preparing || !!active || !!guide || !available.length;
  $('process').textContent=available.length===1 ? `Process ${available[0]} video` : 'Process both videos';
  $('prepare').disabled=preparing || !!active;
  $('cancel').hidden=$('progress').hidden=!active;
  $('practice-option').hidden=!clip.file;
  $('practice').disabled=!!active;
  $('practice').checked=clip.practice;
  $('brace-option').hidden=!clip.file;
  $('braced').disabled=!!active;
  $('braced').checked=clip.braced;
  updateGuide(clip);
  $('timing-options').hidden=!clip.file;
  $('time-basis').disabled=$('capture-fps').disabled=!!active;
  $('time-basis').value=clip.captureFps===null?'file':'capture';
  $('capture-field').hidden=clip.captureFps===null;
  if (clip.captureFps!==null) $('capture-fps').value=clip.captureFps;
  updateTiming();
  updateCorrections();
  $('review').hidden=!clip.data || !!active || !!guide;
  if ($('review').hidden) $('review').open=false;
  $('scrub').hidden=!clip.data || !!active || !!guide;
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
  const tracked=clip.data?.frames[clip.index]?.tracking;
  const source=tracked==='brace + pose'?' · Brace estimate with pose agreement':
    tracked==='brace estimate'?' · Brace estimate':tracked==='brace refit'?' · Brace track recovered':'';
  $('flag-status').textContent=count+current+source;
  $('restore').disabled=!clip.data?.frames[clip.index]?.edited || !!active;
  $('set-reference').disabled=!clip.data || !!active;
  $('auto-reference').disabled=clip.referenceIndex===null || !!active;
  $('reference-status').textContent=clip.referenceIndex===null?'Resting reference: automatic stable start.':
    `Resting reference: frame ${clip.referenceIndex+1}. Recalculate after changing it.`;
}

function updateTiming() {
  for (const side of sides) {
    const clip=state[side];
    const fileFps=clip.metadata?.fps;
    const decoded=clip.data?.hz;
    const tracking=clip.braced
      ? activeSeed(clip) ? ' · Brace guide ready' : clip.poseOnly ? ' · Pose only' : ' · Guide needed'
      : '';
    $(side+'-meta').textContent=clip.error ? clip.error :
      clip.file ? `File timing ${num(fileFps,' fps')}${decoded?' · Decoded '+num(decoded,' fps'):''}${tracking}`:'';
  }
  const clip=state[selected];
  $('timing-info').textContent=`${title(selected)} · File timing ${num(clip.metadata?.fps,' fps')} (sampled timestamps).
    ${clip.data?'Decoded '+num(clip.data.hz,' fps')+'. ':''}
    ${clip.captureFps===null?'Using source timestamps.':'Using confirmed '+num(clip.captureFps,' fps')+' for analysis.'}`;
}

function updateCorrections() {
  const messages=sides.filter(side=>state[side].result).map(side=>{
    const clip=state[side];
    const applied=clip.result.correctedFrames ?? 0;
    const nearby=clip.result.propagatedFrames;
    return `${title(side)} · revision ${clip.revision} · ${applied} corrected frames applied${nearby?` · ${nearby} nearby frames adjusted`:''}${clip.dirty?' · changes pending recalculation':''}.`;
  });
  $('calculation-state').textContent=messages.join(' ');
  const clip=state[selected];
  const edited=clip.data?.frames.filter(frame=>frame.edited).length ?? 0;
  $('correction-status').textContent=requiresGuide(clip)
    ? 'Place a brace guide or choose pose detection without a guide.'
    : needsProcessing(clip)
    ? 'Brace guide changed. Process the video again to apply it.'
    : clip.dirty
    ? `${edited} corrected frames in this clip. Recalculate to apply current edits and timing settings.`
    : clip.result ? `Revision ${clip.revision}: ${clip.result.correctedFrames} corrected frames included in these results.`:'';
  $('correction-actions').hidden=!clip.data || !!active;
  $('apply-corrections').disabled=!clip.data || !clip.dirty || !!active || needsProcessing(clip) || requiresGuide(clip) || !!guide;
  const braceResults=sides.filter(side=>state[side].result?.braceAssisted);
  $('brace-summary').hidden=!braceResults.length;
  $('brace-summary').textContent=braceResults.map(side=>{
    const {data}=state[side];
    const lost=data.frames.filter(f=>f.tracking==='lost' || f.tracking==='disagreement').length;
    const refit=data.frames.filter(f=>f.tracking==='brace refit').length;
    return `${title(side)} · Whole-leg estimates from brace tracking · ${lost}/${data.frames.length} unresolved frames · ${refit} recovered.`;
  }).join(' ');
  $('export-frames').disabled=$('export').disabled=sides.some(side=>state[side].dirty) || !!active;
}

function refreshFlags(side) {
  const clip=state[side];
  if (!clip.data) return;
  const frames=timedFrames(clip.data,clip.captureFps);
  const hz=clip.captureFps ?? clip.data.hz;
  clip.flags=flagFrames(frames,clip.data.aspect,clip.braced,hz);
  if (side===selected) updateReview(clip);
}

function pending(side) {
  const clip=state[side];
  if (!clip.data) return;
  clip.dirty=true;
  refreshFlags(side);
  updateCorrections();
}

function overlay(points,guidePoints=null) {
  const ctx=canvas.getContext('2d');
  let shown=points ?? [];
  if (guidePoints) shown=[guidePoints.hip,guidePoints.ankle,guidePoints.panel];
  else if (!shown[1]) shown=[shown[0],shown[2]];
  const coords=shown.map(p=> p && Number.isFinite(p.x) && Number.isFinite(p.y) && p.score>=.5
    ? [p.x*canvas.width,p.y*canvas.height] : null);
  ctx.lineWidth=Math.max(2,canvas.width/230);
  ctx.strokeStyle=guidePoints?'#ffdb5c':'#24baff';
  for (let i=1;i<coords.length;i++) {
    if (!coords[i-1] || !coords[i] || (guidePoints && i===2)) continue;
    ctx.beginPath();ctx.moveTo(...coords[i-1]);ctx.lineTo(...coords[i]);ctx.stroke();
  }
  for (const point of coords) {
    if (!point) continue;
    ctx.beginPath();ctx.arc(...point,Math.max(3,canvas.width/140),0,Math.PI*2);
    ctx.fillStyle='#fff';ctx.fill();ctx.stroke();
  }
}

async function preview(showOverlay=true) {
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
      const applied=clip.dirty ? null : clip.appliedFrames?.[index];
      const bracePoints=guide?.side===side?guide.seed:!clip.data && clip.braced?clip.braceSeed:null;
      if (showOverlay) overlay(applied?.points ?? frame?.points,bracePoints);
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
    guide=null;
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
  const {result,flags,frames}=calculate(clip.data,{practice:clip.practice,braced:clip.braced,
    captureFps:clip.captureFps,excluded:[...clip.excluded],referenceIndex:clip.referenceIndex,propagate:clip.propagate});
  clip.appliedFrames=result.propagatedFrames ? frames : null;
  clip.flags=flags;
  clip.result=result;
  clip.revision++;
  clip.dirty=false;
  if (side===selected) updateReview(clip);
  updateCorrections();
}

function renderResults() {
  $('summary').hidden=$('repetitions').hidden=!sides.some(s=>state[s].result);
  updateCorrections();
  if ($('summary').hidden) return;
  const [l,r]=sides.map(s=>summarize(state[s].result));
  $('counts').textContent=`Mean of selected raises · Left ${l.count} · Right ${r.count}`;
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
    if (result.reps.filter(r=>!r.practice).length<3) extra.push('Fewer than three scored raises detected.');
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
    const selection=summarize(result).selection;
    let scored=0;
    for (const [i,rep] of result.reps.entries()) {
      const details=document.createElement('details');
      details.className='rep';details.dataset.rep=side+i;details.open=expanded.has(side+i);
      const summary=document.createElement('summary');
      const label=rep.practice?'Practice':`Raise ${++scored}`;
      const key=result.braced?'leg':'thigh';
      const trackIssues=[...rep.issues,...rep.kneeIssues];
      const reviewNeeded=rep.issues.length || (!result.braceAssisted && rep.kneeIssues.length);
      summary.textContent=`${label} · ${selection[i].reason} · ${num(rep[key],'°')} · ${num(rep[key+'Speed'],'°/s')}${reviewNeeded?' · Check tracking':''}`;
      function showPeak() {
        const frames=state[side].data.frames;
        const index=frames.findIndex(r=>r.time===rep.sourcePeakTime);
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
      const exclude=document.createElement('input');
      exclude.type='checkbox';exclude.checked=!!rep.excluded;exclude.disabled=!!active || state[side].dirty;
      exclude.addEventListener('change',()=>{
        if (exclude.checked) state[side].excluded.add(rep.sourceStartTime);
        else state[side].excluded.delete(rep.sourceStartTime);
        if (state[side].dirty) {
          report('Recalculate pending landmark and timing changes before selecting repetitions.',true);
          return;
        }
        recalculate(side);renderResults();
      });
      const exclusion=document.createElement('label');
      exclusion.className='check';
      exclusion.append(exclude,document.createTextNode('Exclude from set'));
      details.append(summary,values,qc,peak,exclusion);
      list.append(details);
    }
  }
}

for (const side of sides) {
  $(side).addEventListener('change',async()=>{
    const file=$(side).files[0];
    if (!file) return;
    guide=null;
    closePreview();
    state[side]=newClip(file);
    $(side+'-name').textContent=file.name;
    report(sides.every(s=>state[s].file)?'Check each preview, then process both videos.':`Check the preview, then process the ${side} video. You can also add the other leg.`);
    renderResults();choose(side);
    const clip=state[side];
    try {
      const metadata=await inspectVideo(file);
      if (state[side]!==clip) return;
      clip.metadata=metadata;
    } catch(error) {
      if (state[side]!==clip) return;
      clip.error='Could not inspect file: '+error.message;
    }
    updateTiming();
  });
  $('show-'+side).addEventListener('click',()=>choose(side));
}
for (const [id,angle] of [['ccw',270],['cw',90]]) {
  $(id).addEventListener('click',()=>{
    const clip=state[selected];
    clip.turn=(clip.turn+angle)%360;
    clip.data=null;clip.result=null;clip.index=0;clip.flags=[];clip.reviewed.clear();clip.dirty=false;clip.excluded.clear();clip.error=null;clip.referenceIndex=null;
    guide=null;clip.braceSeed=null;clip.appliedFrames=null;
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
$('set-reference').addEventListener('click',()=>{
  state[selected].referenceIndex=state[selected].index;
  pending(selected);controls();
});
$('auto-reference').addEventListener('click',()=>{
  state[selected].referenceIndex=null;
  pending(selected);controls();
});
$('braced').addEventListener('change',()=>{
  const clip=state[selected];
  clip.braced=$('braced').checked;
  guide=null;
  clip.reviewed.clear();
  pending(selected);
  renderResults();controls();void preview();
});
$('seed-brace').addEventListener('click',()=>{
  if (active || !state[selected].file || !state[selected].braced) return;
  guide=guide?null:{side:selected,step:0,seed:{}};
  if (guide) {
    choose(selected,0);
    $('viewer').scrollIntoView({block:'center'});
  } else {controls();void preview();}
});
$('clear-brace').addEventListener('click',()=>{
  state[selected].braceSeed=null;
  pending(selected);controls();void preview();
});
$('pose-only').addEventListener('change',()=>{
  state[selected].poseOnly=$('pose-only').checked;
  controls();
});
$('propagate').addEventListener('change',()=>{
  state[selected].propagate=$('propagate').checked;
  pending(selected);controls();
});
$('practice').addEventListener('change',()=>{
  state[selected].practice=$('practice').checked;
  pending(selected);renderResults();
});
$('apply-corrections').addEventListener('click',()=>{
  if (needsProcessing(state[selected]) || requiresGuide(state[selected])) return;
  try {
    recalculate(selected);renderResults();controls();void preview();
    report(`${title(selected)} results recalculated from current landmarks. Revision ${state[selected].revision}.`);
  } catch(error) {report(error.message,true);}
});
function changeTiming() {
  const clip=state[selected];
  const value=$('time-basis').value==='capture'?Number($('capture-fps').value):null;
  if (value!==null && (!Number.isFinite(value) || value<1 || value>1000)) {
    report('Enter a capture rate between 1 and 1000 fps.',true);
    return;
  }
  clip.captureFps=value;
  controls();
  pending(selected);
}
$('time-basis').addEventListener('change',changeTiming);
$('capture-fps').addEventListener('change',changeTiming);
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
  if (active || preparing || guide || !available.length) return;
  const needsGuide=available.find(side=>requiresGuide(state[side]));
  if (needsGuide) {
    choose(needsGuide);
    $('brace-guide').scrollIntoView({block:'center'});
    const message=`Place the ${needsGuide} brace guide or select pose detection without a guide.`;
    $('brace-status').textContent=message;
    report(message,true);
    return;
  }
  active=new AbortController();
  const signal=active.signal;
  closePreview();
  controls();
  void preview();
  $('progress').removeAttribute('value');
  report('Loading MediaPipe Full…');
  for (const side of available) state[side].error=null;
  renderResults();
  const failures=[];
  let completed=0;
  try {
    for (const side of available) {
      signal.throwIfAborted();
      const clip=state[side];
      let data,lastError;
      for (const software of [false,true]) {
        let model;
        try {
          report(`${title(side)} · ${software?'Retrying with software decoding…':'Loading pose model…'}`);
          model=await engine();
          data=await scan(clip.file,side,clip.turn,model,signal,(count,time,stage)=>report(stage==='verify'
            ? `${title(side)} · Checking brace track backwards · ${count}/${time} frames`
            : `${title(side)} · ${activeSeed(clip)?'Tracking brace':'Tracking pose'} · ${count} frames · ${time.toFixed(1)} s of video`),
          software,activeSeed(clip));
          break;
        } catch(error) {
          signal.throwIfAborted();
          lastError=error;
        } finally {model?.close();}
      }
      if (!data) {
        clip.error=`${title(side)} processing failed · ${lastError?.message ?? 'No frames returned'}`;
        failures.push(clip.error);
        updateTiming();
        continue;
      }
      signal.throwIfAborted();
      const intervals=data.frames.slice(1).map((row,i)=>row.time-data.frames[i].time);
      const step=median(intervals);
      const next=preserveEdits(clip.data,{...data,hz:step>0?1/step:null});
      const previous=clip.data;
      clip.data=next;
      try {
        recalculate(side);
        completed++;
      } catch(error) {
        clip.data=previous;
        clip.error=`${title(side)} measurement failed · ${error.message}`;
        failures.push(clip.error);
      }
    }
    report(failures.length ? failures.join(' · ') :
      `${completed===2?'Both videos':title(available[0])+' video'} processed. Review the overlay before using the measurements.`,!!failures.length);
  } catch(error) {
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
canvas.addEventListener('click',async event=>{
  if (guide && !active && viewed?.side===selected && viewed.index===0) {
    const rect=canvas.getBoundingClientRect();
    const point={x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height,score:1};
    const placing=guide;
    const key=guideSteps[placing.step][0];
    placing.seed[key]=point;
    if (placing.step<guideSteps.length-1) {
      placing.step++;
    } else {
      const clip=state[selected];
      try {
        // Read unpainted pixels so the guide overlay cannot affect the colour sample.
        await preview(false);
        if (guide!==placing || state[selected]!==clip || viewed?.side!==selected || viewed.index!==0) return;
        seedBrace(braceImage(canvas,document.createElement('canvas')),placing.seed);
        clip.braceSeed=placing.seed;
        clip.poseOnly=false;
        guide=null;
        pending(selected);
        report('Brace guide placed. Process the video when ready.');
      } catch(error) {report(error.message,true);$('brace-prompt').textContent=error.message;return;}
    }
    controls();void preview();
    return;
  }
  if (joint===null || !viewed || !$('review').open || active) return;
  const clip=state[viewed.side], frame=clip.data?.frames[viewed.index];
  if (!frame) return;
  const rect=canvas.getBoundingClientRect();
  if (!frame.edited) frame.original=frame.points?.map(p=>p&&{...p}) ?? null;
  frame.points ??= [null,null,null];
  frame.points[joint]={x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height,score:1};
  frame.edited=true;
  frame.manualJoints=[...new Set([...(frame.manualJoints ?? []),joint])];
  clip.reviewed.delete(viewed.index);
  pending(viewed.side);renderResults();void preview();
});
$('restore').addEventListener('click',()=>{
  const clip=state[selected], frame=clip.data?.frames[clip.index];
  if (!frame?.edited) return;
  frame.points=frame.original;delete frame.original;delete frame.edited;delete frame.manualJoints;
  clip.reviewed.delete(clip.index);
  pending(selected);renderResults();void preview();
});
$('export').addEventListener('click',()=>{
  if (sides.some(side=>state[side].dirty)) return;
  const rows=[['side','raise','included_in_summary','selection_reason','selection_rank','practice','braced_knee','peak_time_s','peak_frame_basis',...fields.map(([key,,unit])=>key+(unit==='°/s'?'_deg_per_s':'_deg')),'qc','knee_tracking_qc','manual_edits','corrected_frames_applied','calculation_revision','file_timing_fps','decoded_fps','analysis_fps','timing_basis','tracking_method','nearby_frames_adjusted']];
  for (const side of sides) {
    const result=state[side].result;
    const selection=summarize(result).selection;
    result?.reps.forEach((r,i)=>rows.push([
      side,i+1,selection[i].included,selection[i].reason,selection[i].rank,r.practice,result.braced,r.peakTime,result.braced?'hip-to-ankle':'thigh',
      ...fields.map(([key])=>r[key]),r.issues.join(' · '),r.kneeIssues.join(' · '),!!r.edited,result.correctedFrames,state[side].revision,state[side].metadata?.fps,state[side].data?.hz,result.hz,result.captureFps===null?'file timestamps':'confirmed capture fps',
      result.braceAssisted?'brace estimate':'MediaPipe pose',result.propagatedFrames
    ]));
  }
  const csv=rows.map(row=>row.map(value=>'"'+String(value??'').replaceAll('"','""')+'"').join(',')).join('\r\n');
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  const link=document.createElement('a');link.href=url;link.download='lihps-askling-video.csv';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
});
if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('./sw.js').catch(()=>{});
controls();

// Frame data supports review of applied edits and quality flags.
$('export-frames').addEventListener('click',()=>{
  if (sides.some(side=>state[side].dirty)) return;
  const payload=Object.fromEntries(sides.filter(side=>state[side].data).map(side=>{
    const clip=state[side];
    return [side,{fileName:clip.file.name,data:clip.data,metadata:clip.metadata,result:clip.result,
      flags:clip.flags,revision:clip.revision,appliedFrames:clip.appliedFrames}];
  }));
  const url=URL.createObjectURL(new Blob([JSON.stringify(payload)],{type:'application/json'}));
  const link=document.createElement('a');
  link.href=url;link.download='lihps-frame-data.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),5000);
});
