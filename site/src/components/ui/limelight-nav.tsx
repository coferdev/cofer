import React, { cloneElement, useLayoutEffect, useRef, useState } from 'react';

export type NavItem = { id: string; href: string; icon: React.ReactElement<{className?:string}>; label: string; onClick?: () => void };
type LimelightNavProps = {items:NavItem[]; activeIndex?:number; onTabChange?:(index:number)=>void; className?:string};

/** A keyboard-accessible adaptation of the supplied Limelight navigation. */
export function LimelightNav({items,activeIndex:controlled,onTabChange,className=''}:LimelightNavProps){
 const [internal,setInternal]=useState(0);const index=controlled??internal;const refs=useRef<(HTMLAnchorElement|null)[]>([]);const light=useRef<HTMLDivElement>(null);const [ready,setReady]=useState(false);
 useLayoutEffect(()=>{const node=refs.current[index],mark=light.current;if(!node||!mark)return;const position=()=>{const x=node.offsetLeft+node.offsetWidth/2-mark.offsetWidth/2;mark.style.transform=`translateX(${x}px)`};position();const observer=new ResizeObserver(position);observer.observe(node);const id=requestAnimationFrame(()=>setReady(true));return()=>{observer.disconnect();cancelAnimationFrame(id)}},[index,items]);
 if(!items.length)return null;
 return <nav className={`limelight-nav ${className}`} aria-label="Landing sections">{items.map(({id,href,icon,label,onClick},i)=><a key={id} href={href} ref={el=>{refs.current[i]=el}} className={`limelight-item${i===index?' is-active':''}`} aria-current={i===index?'location':undefined} onClick={e=>{if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;setInternal(i);onTabChange?.(i);if(onClick){e.preventDefault();onClick()}}}>{cloneElement(icon,{className:'limelight-icon'})}<span>{label}</span></a>)}<div ref={light} aria-hidden="true" className={`limelight-indicator${ready?' is-ready':''}`}><span/></div></nav>
}
