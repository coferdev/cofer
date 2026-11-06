"use client";
import React, { useEffect, useRef, useState } from 'react';
import { motion, useAnimationFrame, useMotionTemplate, useMotionValue, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';

/** The supplied SVG-path moving border, with cached path length for smoother frames. */
export function MovingBorder({children,duration=2000,rx='30%',ry='30%',...props}:{children:React.ReactNode;duration?:number;rx?:string;ry?:string}&React.SVGProps<SVGSVGElement>){
 const pathRef=useRef<SVGRectElement>(null),lengthRef=useRef(0),x=useMotionValue(0),y=useMotionValue(0);
 useEffect(()=>{const path=pathRef.current;if(!path)return;const measure=()=>{lengthRef.current=path.getTotalLength()};measure();const observer=new ResizeObserver(measure);observer.observe(path.ownerSVGElement||path);return()=>observer.disconnect()},[]);
 useAnimationFrame(time=>{const path=pathRef.current,length=lengthRef.current;if(!path||!length)return;const point=path.getPointAtLength((time*length/duration)%length);x.set(point.x);y.set(point.y)});
 const transform=useMotionTemplate`translateX(${x}px) translateY(${y}px) translateX(-50%) translateY(-50%)`;
 return <><svg xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none" className="absolute h-full w-full" width="100%" height="100%" {...props}><rect fill="none" width="100%" height="100%" rx={rx} ry={ry} ref={pathRef}/></svg><motion.div style={{position:'absolute',top:0,left:0,display:'inline-block',transform}}>{children}</motion.div></>
}
export function Button({borderRadius='1.75rem',children,as:Component='button',containerClassName,borderClassName,duration,className,...props}:{borderRadius?:string;children:React.ReactNode;as?:React.ElementType;containerClassName?:string;borderClassName?:string;duration?:number;className?:string;[key:string]:unknown}){return <Component className={cn('moving-border-button',containerClassName)} style={{borderRadius}} {...props}><div className="moving-border-button-track" style={{borderRadius:`calc(${borderRadius} * .96)`}}><MovingBorder duration={duration}><div className={cn('moving-border-glow',borderClassName)}/></MovingBorder></div><div className={cn('moving-border-button-content',className)} style={{borderRadius:`calc(${borderRadius} * .96)`}}>{children}</div></Component>}
/** Only mount frame-driven motion while its card is on screen and motion is allowed. */
export function CardBorder(){
 const ref=useRef<HTMLDivElement>(null),[visible,setVisible]=useState(false),[pageVisible,setPageVisible]=useState(()=>!document.hidden),reduced=useReducedMotion();
 useEffect(()=>{const node=ref.current;if(!node)return;const observer=new IntersectionObserver(([entry])=>setVisible(entry.isIntersecting),{rootMargin:'40px'});observer.observe(node);const onVisibility=()=>setPageVisible(!document.hidden);document.addEventListener('visibilitychange',onVisibility);return()=>{observer.disconnect();document.removeEventListener('visibilitychange',onVisibility)}},[]);
 return <div ref={ref} className="card-moving-border" aria-hidden="true">{visible&&pageVisible&&!reduced&&<MovingBorder duration={4000} rx="30" ry="30"><span className="moving-border-glow"/></MovingBorder>}</div>
}
