// Brace position is expressed in image pixels here. The pose API uses normalized coordinates.
import {median,usable} from './metrics.js';

const radians = Math.PI / 180;
const clamp = (n,lo,hi) => Math.max(lo,Math.min(hi,n));
const turn = a => Math.atan2(Math.sin(a),Math.cos(a));
const angleChange = (a,b) => turn(a-b);
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);

function rgb(image,x,y) {
  x=Math.round(x);y=Math.round(y);
  if (x<0 || y<0 || x>=image.width || y>=image.height) return null;
  const start=4*(y*image.width+x);
  return [image.data[start],image.data[start+1],image.data[start+2]];
}

function colorProfile(pixels) {
  const channels=[0,1,2].map(i=>median(pixels.map(pixel=>pixel[i])));
  const value=Math.max(...channels);
  const chroma=channels.map(v=>v-value);
  const spread=median(pixels.map(color=>Math.abs(Math.max(...color)-value)));
  return {value,chroma,spread};
}

function appearance(image,point,axis,length) {
  const pixels=[];
  for (let y=-3;y<=3;y++) {
    for (let x=-3;x<=3;x++) {
      const color=rgb(image,point.x+x,point.y+y);
      if (color) pixels.push(color);
    }
  }
  const local=colorProfile(pixels);
  const panel=[];
  for (let fraction=.24;fraction<=.80;fraction+=.025) {
    for (let lateral=-.045;lateral<=.046;lateral+=.015) {
      const pt=transform(axis,fraction*length,lateral*length);
      const color=rgb(image,pt.x,pt.y);
      if (!color) continue;
      const value=Math.max(...color);
      const error=color.reduce((sum,channel,i)=>sum+Math.abs(channel-value-local.chroma[i]),0);
      if (value>=Math.max(3,local.value-52) && value<=local.value+23 && error<=41)
        panel.push(color);
    }
  }
  if (panel.length<35) return local;
  const interior=colorProfile(panel);
  // When the tap is on a highlight or a lighter fabric strip, use the
  // representative colour observed along the panel instead.
  return local.value-interior.value>=12 ? interior : local;
}

function maskFor(image,style) {
  const {data,width,height}=image;
  const mask=new Uint8Array(Math.ceil(width*height/8));
  const allowance=clamp(style.spread*4+23,23,49);
  const shadow=clamp((30-style.value)/11,0,1);
  const upper=style.value+allowance+20*shadow;
  for (let i=0,j=0;i<width*height;i++,j+=4) {
    const r=data[j],g=data[j+1],b=data[j+2],value=Math.max(r,g,b);
    if (value>upper || value<Math.max(4,style.value-allowance)) continue;
    const error=Math.abs(r-value-style.chroma[0])+Math.abs(g-value-style.chroma[1])+Math.abs(b-value-style.chroma[2]);
    if (error<=25+10*shadow) mask[i>>3] |= 1<<(i&7);
  }
  return mask;
}

function lookup(model,mask,x,y) {
  const col=Math.round(x), row=Math.round(y);
  if (col<0 || col>=model.width || row<0 || row>=model.height) return 0;
  const index=row*model.width+col;
  return (mask[index>>3]>>(index&7))&1;
}

function transform(pose,along,across) {
  return {x:pose.x+pose.c*along-pose.s*across,y:pose.y+pose.s*along+pose.c*across};
}

function poseAt(x,y,angle) {
  return {x,y,angle,c:Math.cos(angle),s:Math.sin(angle)};
}

export function seedBrace(image,seed) {
  const pixel=point=>({x:point.x*image.width,y:point.y*image.height});
  const hip=pixel(seed.hip),ankle=pixel(seed.ankle),panel=pixel(seed.panel);
  const length=distance(hip,ankle);
  if (length<image.width*.12) throw new Error('Select the hip and ankle at opposite ends of the tested leg.');
  const initial=poseAt(hip.x,hip.y,Math.atan2(ankle.y-hip.y,ankle.x-hip.x));
  const along=(panel.x-hip.x)*initial.c+(panel.y-hip.y)*initial.s;
  const across=-(panel.x-hip.x)*initial.s+(panel.y-hip.y)*initial.c;
  if (along<.12*length || along>.9*length || Math.abs(across)>.17*length)
    throw new Error('Tap a padded brace panel between the hip and ankle.');
  const style=appearance(image,panel,initial,length);
  const model={width:image.width,height:image.height,length,style,initial,rows:[]};
  const mask=maskFor(image,style);
  // Learn outlines where the seed colour contrasts with the pixels immediately outside the brace.
  for (let fraction=.16;fraction<=.89;fraction+=.04) {
    const cells=[];
    for (let lateral=-.16;lateral<=.161;lateral+=.02) {
      const p=transform(initial,fraction*length,lateral*length);
      cells.push({offset:lateral*length,on:lookup(model,mask,p.x,p.y)});
    }
    const on=cells.filter(cell=>cell.on);
    if (on.length<3) continue;
    const left=on[0].offset,right=on.at(-1).offset;
    if (right-left>length*.235) continue;
    model.rows.push({
      along:fraction*length,
      inside:[left+(right-left)*.18,(left+right)/2,right-(right-left)*.18],
      outside:[left-.025*length,right+.025*length]
    });
  }
  if (model.rows.length<8 || model.rows.at(-1).along-model.rows[0].along<length*.39)
    throw new Error('The brace colour could not be isolated. Tap the middle of a solid padded panel and try again.');
  return model;
}

function score(model,mask,pose) {
  let inside=0,outside=0,sections=0;
  const zone=Math.ceil(model.rows.length/3);
  for (const row of model.rows) {
    let matches=0;
    for (const offset of row.inside) {
      matches+=lookup(model,mask,pose.x+pose.c*row.along-pose.s*offset,pose.y+pose.s*row.along+pose.c*offset);
    }
    inside+=matches;
    sections+=Number(matches>=2);
    for (const offset of row.outside) {
      outside+=lookup(model,mask,pose.x+pose.c*row.along-pose.s*offset,pose.y+pose.s*row.along+pose.c*offset);
    }
  }
  const n=model.rows.length;
  return {support:inside/(3*n),spread:sections>=2*zone,
    quality:inside/(3*n)-.36*outside/(2*n)};
}

export const braceMask = (model,image) => maskFor(image,model.style);

export function findBrace(model,mask,previous=null) {
  const {initial,length}=model;
  const last=previous?.pose ?? initial;
  const velocity=previous?.velocity ?? {x:0,y:0,angle:0};
  const predicted=poseAt(last.x+velocity.x,last.y+velocity.y,last.angle+velocity.angle);
  let best=null;
  function search(center,positionStep,angleStep,positionRadius,angleRadius) {
    for (let dx=-positionRadius;dx<=positionRadius;dx++) {
      for (let dy=-positionRadius;dy<=positionRadius;dy++) {
        const x=center.x+dx*positionStep,y=center.y+dy*positionStep;
        if (Math.abs(x-initial.x)>length*.36 || Math.abs(y-initial.y)>length*.23) continue;
        for (let da=-angleRadius;da<=angleRadius;da++) {
          const pose=poseAt(x,y,center.angle+da*angleStep);
          const fit=score(model,mask,pose);
          if (!fit.spread) continue;
          const cost=.55*distance(pose,predicted)/length+.33*Math.abs(angleChange(pose.angle,predicted.angle))+
            .18*distance(pose,initial)/length;
          const value=fit.quality-cost;
          if (!best || value>best.value) best={pose,...fit,value};
        }
      }
    }
  }
  search(predicted,length*.022,4*radians,2,3);
  if (best) search(best.pose,length*.007,1.1*radians,2,2);
  const reliable=()=>best && best.support>=.59 && best.quality>=.44;
  if (!reliable()) {
    search(predicted,length*.05,10*radians,2,5);
    if (best) search(best.pose,length*.018,3*radians,2,2);
  }
  if (!reliable()) return null;
  const {pose}=best;
  return {...best,velocity:{x:clamp(pose.x-last.x,-length*.035,length*.035),
    y:clamp(pose.y-last.y,-length*.035,length*.035),
    angle:clamp(angleChange(pose.angle,last.angle),-10*radians,10*radians)}};
}

export function braceEndpoints(model,fit) {
  const ankle=transform(fit.pose,model.length,0);
  return [fit.pose,ankle].map(p=>({x:p.x/model.width,y:p.y/model.height,score:1}));
}

function line(points,aspect) {
  if (!usable(points?.[0]) || !usable(points?.[2])) return null;
  const [hip,,ankle]=points;
  const dx=(ankle.x-hip.x)*aspect,dy=ankle.y-hip.y;
  return {angle:Math.atan2(dy,dx),length:Math.hypot(dx,dy)};
}

export function trackingBasis(candidates,endpoints,aspect) {
  if (!endpoints) return {points:null,tracking:'lost'};
  const points=[endpoints[0],null,endpoints[1]];
  const brace=line(points,aspect);
  if (!brace) return {points:null,tracking:'lost'};
  const nearest=(candidates ?? []).map(candidate=>{
    const known=line(candidate,aspect);
    if (!known) return null;
    const [a,,b]=candidate;
    const error=(Math.hypot((a.x-points[0].x)*aspect,a.y-points[0].y)+
      Math.hypot((b.x-points[2].x)*aspect,b.y-points[2].y))/brace.length;
    return {known,error};
  }).filter(Boolean).sort((a,b)=>a.error-b.error)[0];
  const agrees=nearest && nearest.error<.24 && Math.abs(angleChange(nearest.known.angle,brace.angle))<13*radians;
  // Brace motion supports estimated endpoints. A hidden knee has no dependable anatomical landmark.
  return {points,tracking:agrees?'brace + pose':'brace estimate'};
}

export function checkBracePasses(frames,reverse,aspect) {
  return frames.map((frame,i)=>{
    if (!frame.points) return frame;
    const a=line(frame.points,aspect), b=line(reverse[i]?.points,aspect);
    const dx=(frame.points[0].x-(reverse[i]?.points?.[0]?.x ?? 0))*aspect;
    const dy=frame.points[0].y-(reverse[i]?.points?.[0]?.y ?? 0);
    if (!b || Math.abs(angleChange(a.angle,b.angle))>12*radians ||
        Math.abs(dy*Math.cos(a.angle)-dx*Math.sin(a.angle))>.12*a.length ||
        Math.hypot(dx,dy)>.24*a.length)
      return {...frame,points:null,tracking:'disagreement'};
    // Average independent fits to reduce frame-to-frame jitter.
    const points=frame.points.map((point,j)=>point ? {...point,x:(point.x+reverse[i].points[j].x)/2,
      y:(point.y+reverse[i].points[j].y)/2}:null);
    return {...frame,points};
  });
}

// Keep only a packed colour mask per decoded frame. Reverse tracking reuses these masks.
export function startBraceTrack(model,aspect) {
  const masks=[],forward=[];
  let previous=null;
  return {
    add(frame,image,candidates) {
      const mask=braceMask(model,image);
      const fit=findBrace(model,mask,previous);
      if (fit) previous=fit;
      else if (previous) previous={pose:previous.pose};
      masks.push(mask);
      forward.push({...frame,...trackingBasis(candidates,fit?braceEndpoints(model,fit):null,aspect)});
    },
    async finish(signal,pause,progress) {
      const reverse=new Array(forward.length);
      if (previous) previous={pose:previous.pose};
      for (let i=forward.length-1;i>=0;i--) {
        signal.throwIfAborted();
        const fit=findBrace(model,masks[i],previous);
        if (fit) previous=fit;
        else if (previous) previous={pose:previous.pose};
        const ends=fit ? braceEndpoints(model,fit) : null;
        reverse[i]={points:ends?[ends[0],null,ends[1]]:null};
        if (i%16===0) {
          progress(forward.length-i,forward.length);
          await pause();
        }
      }
      const verified=checkBracePasses(forward,reverse,aspect);
      const frameStep=median(forward.slice(1).map((frame,i)=>frame.time-forward[i].time));
      const maxSpan=10;
      // Use the pixels in each uncertain frame to refit a short stretch between trusted fits.
      // Time adjacency alone never fills a frame without image support.
      for (let i=1;i<verified.length-1;i++) {
        if (verified[i].points || !verified[i-1].points) continue;
        const start=i-1;
        let end=i+1;
        while (end<verified.length && !verified[end].points) end++;
        i=end-1;
        if (end>=verified.length || end-start>maxSpan) continue;
        const a=verified[start], b=verified[end];
        const first=line(a.points,aspect), last=line(b.points,aspect);
        const delta=angleChange(last.angle,first.angle);
        if (Math.abs(delta)>18*radians || b.time-a.time>1.5*(end-start)*frameStep) continue;
        const recovered=[];
        for (let j=start+1;j<end;j++) {
          const weight=(verified[j].time-a.time)/(b.time-a.time);
          const x=(a.points[0].x*(1-weight)+b.points[0].x*weight)*model.width;
          const y=(a.points[0].y*(1-weight)+b.points[0].y*weight)*model.height;
          const predicted=poseAt(x,y,first.angle+weight*delta);
          const fit=findBrace(model,masks[j],{pose:predicted});
          if (!fit || fit.support<.68 || distance(fit.pose,predicted)>.072*model.length ||
              Math.abs(angleChange(fit.pose.angle,predicted.angle))>5*radians) break;
          const [hip,ankle]=braceEndpoints(model,fit);
          recovered.push({...verified[j],points:[hip,null,ankle],tracking:'brace refit'});
        }
        if (recovered.length===end-start-1) verified.splice(start+1,recovered.length,...recovered);
      }
      return verified;
    }
  };
}

// Apply an examiner's positional adjustment in the moving segment's coordinate system.
// Require continuous tracking. Never bridge a lost brace or invent a knee position.
export function applyBraceEdits(frames,aspect,enabled) {
  if (!enabled) return frames;
  const offsets=new Map();
  for (const [i,frame] of frames.entries()) {
    if (!frame.manualJoints?.length) continue;
    const anchor=line(frame.original,aspect);
    if (!anchor || !frame.tracking || !line(frame.points,aspect)) continue;
    for (const joint of [0,2]) {
      if (!frame.manualJoints.includes(joint)) continue;
      const dx=(frame.points[joint].x-frame.original[joint].x)*aspect;
      const dy=frame.points[joint].y-frame.original[joint].y;
      if (Math.hypot(dx,dy)>.18*anchor.length) continue;
      for (const dir of [-1,1]) {
        for (let j=i+dir;frames[j];j+=dir) {
          const target=frames[j];
          const dt=Math.abs(target.time-frame.time);
          const neighbor=line(target.original ?? target.points,aspect);
          if (!neighbor || dt>.16 || !target.tracking ||
              Math.abs(target.time-frames[j-dir].time)>.075) break;
          if (target.manualJoints?.includes(joint)) continue;
          const rotation=angleChange(neighbor.angle,anchor.angle);
          const weight=(1+Math.cos(Math.PI*dt/.16))/2;
          const row=offsets.get(j) ?? [];
          const accum=row[joint] ?? {x:0,y:0,weight:0};
          accum.x+=weight*(dx*Math.cos(rotation)-dy*Math.sin(rotation))/aspect;
          accum.y+=weight*(dx*Math.sin(rotation)+dy*Math.cos(rotation));
          accum.weight+=weight;
          row[joint]=accum;
          offsets.set(j,row);
        }
      }
    }
  }
  return frames.map((frame,i)=>{
    if (!offsets.has(i)) return frame;
    let propagated=false;
    const points=frame.points.map((point,joint)=>{
      const adjustment=offsets.get(i)[joint];
      if (!adjustment || adjustment.weight<=0 || !usable(point)) return point;
      const weight=Math.max(1,adjustment.weight);
      const moved={...point,x:point.x+adjustment.x/weight,y:point.y+adjustment.y/weight};
      if (!usable(moved)) return point;
      propagated=true;
      return moved;
    });
    return {...frame,points,propagated};
  });
}
