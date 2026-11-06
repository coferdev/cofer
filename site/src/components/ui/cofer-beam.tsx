import React, { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import BeamBorder from '@/components/ui/border-beam';
import { BorderBeam } from '@/components/ui/border-beam-search';

// Only animate elements near the viewport and pause when the tab is hidden.
function useVisibleBeam() {
 const ref=useRef<HTMLDivElement>(null); const [visible,setVisible]=useState(false);
 const [tabVisible,setTabVisible]=useState(()=>!document.hidden); const reduced=useReducedMotion();
 useEffect(()=>{const el=ref.current;if(!el)return;const observer=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting),{rootMargin:'40px'});observer.observe(el);const onVisibility=()=>setTabVisible(!document.hidden);document.addEventListener('visibilitychange',onVisibility);return()=>{observer.disconnect();document.removeEventListener('visibilitychange',onVisibility)}},[]);
 return {ref,active:visible&&tabVisible&&!reduced};
}
export function CardBeam({radius=24}:{radius?:number}){
 const {ref,active}=useVisibleBeam();
 return <div ref={ref} className="card-beam-host" aria-hidden="true">{active&&<BeamBorder size="md" colorVariant="mono" theme="dark" duration={5.5} strength={1} brightness={2} beamWidth={2} borderRadius={radius} className="card-beam-layer" style={{position:'absolute',inset:0,pointerEvents:'none','--rim-stroke-opacity':2.5,'--rim-inner-opacity':1.4,'--rim-bloom-opacity':1.5} as React.CSSProperties}/>}</div>
}
export function CombinedCardBorder({radius=24}:{radius?:number}){return <CardBeam radius={radius}/>}
export function SmallBeam({radius=12}:{radius?:number}){
 const {ref,active}=useVisibleBeam();
 return <div ref={ref} className="small-beam-overlay" aria-hidden="true">{active&&<BorderBeam size="line" colorVariant="mono" theme="dark" duration={3.1} brightness={2} strength={1} borderRadius={radius} className="small-beam-layer" style={{position:'absolute',inset:0,pointerEvents:'none'}}><span/></BorderBeam>}</div>
}
export function BeamButton({children,className='',type='button',radius=12,wrapperClassName='',beam=false,...props}:React.ButtonHTMLAttributes<HTMLButtonElement>&{radius?:number;wrapperClassName?:string;beam?:boolean}){
 return <div className={`small-beam-host ${wrapperClassName}`}><button type={type} className={className} {...props}>{children}</button>{beam&&<SmallBeam radius={radius}/>}</div>
}
