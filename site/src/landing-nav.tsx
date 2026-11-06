import React, {useEffect,useState} from 'react';
import {CircleHelp, CircleUserRound, Compass, Flag, Layers, ListChecks, Menu, Network, Sparkles, Users, X} from 'lucide-react';
import {LimelightNav, type NavItem} from '@/components/ui/limelight-nav';
import {InteractiveHoverLink} from '@/components/ui/interactive-hover-button';
import {BOT_URL} from '@/lib/links';
import './styles/landing-nav.css';

const entries:NavItem[]=[
 {id:'top',href:'#top',label:'Home',icon:<Compass/>},
 {id:'groups',href:'#groups',label:'Groups',icon:<Users/>},
 {id:'platform',href:'#platform',label:'Features',icon:<Layers/>},
 {id:'flow',href:'#flow',label:'Workflow',icon:<ListChecks/>},
 {id:'system',href:'#system',label:'System',icon:<Network/>},
 {id:'proof',href:'#proof',label:'Rules',icon:<CircleHelp/>},
 {id:'developers',href:'#developers',label:'Experience',icon:<Sparkles/>},
 {id:'cta',href:'#cta',label:'Get started',icon:<Flag/>},
];
function jump(id:string){const node=document.getElementById(id);if(!node)return;history.pushState(null,'',`#${id}`);node.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'})}
export function LandingNavigation(){
 const [active,setActive]=useState(0),[open,setOpen]=useState(false);
 useEffect(()=>{let observer:IntersectionObserver|undefined,timer=0,tries=0;const setup=()=>{const groups=document.querySelector<HTMLElement>('section[data-framer-name="Trusted"]');if(groups&&!groups.id)groups.id='groups';const nodes=entries.map(x=>document.getElementById(x.id));if(nodes.some(n=>!n)&&tries++<100){timer=window.setTimeout(setup,100);return}observer=new IntersectionObserver(items=>{for(const item of items){if(item.isIntersecting){const index=entries.findIndex(e=>e.id===item.target.id);if(index>=0)setActive(index)}}},{rootMargin:'-20% 0px -65% 0px',threshold:0});nodes.forEach(n=>n&&observer?.observe(n))};setup();return()=>{clearTimeout(timer);observer?.disconnect()}},[]);
 useEffect(()=>{if(!open)return;const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape'){setOpen(false);document.querySelector<HTMLButtonElement>('.landing-menu-toggle')?.focus()}};const outside=(e:PointerEvent)=>{if(!(e.target as Element).closest('.cofer-landing-header'))setOpen(false)};document.addEventListener('keydown',onKey);document.addEventListener('pointerdown',outside);return()=>{document.removeEventListener('keydown',onKey);document.removeEventListener('pointerdown',outside)}},[open]);
 return <header className="cofer-landing-header"><a className="landing-brand" href="#top" aria-label="Cofer Project home" onClick={e=>{e.preventDefault();setActive(0);jump('top')}}><img src="/assets/cofer-mark.png" alt=""/><span>COFER <span className="brand-project">PROJECT</span></span></a><LimelightNav items={entries.map(item=>({...item,onClick:()=>{setOpen(false);jump(item.id)}}))} activeIndex={active} onTabChange={setActive}/><div className="landing-actions"><a className="landing-how" href="/how-it-works.html">How it works <span aria-hidden="true">↗</span></a><InteractiveHoverLink text="Telegram" aria-label="Open Cofer in Telegram" className="cofer-nav-hover" href={BOT_URL}/><button className="landing-menu-toggle" aria-label={open?'Close sections menu':'Open sections menu'} aria-expanded={open} aria-controls="landing-sections" onClick={()=>setOpen(v=>!v)}>{open?<X size={20}/>:<Menu size={20}/>}</button></div>{open&&<nav id="landing-sections" className="landing-mobile-menu" aria-label="Landing sections">{entries.map((item,i)=><a key={item.id} href={item.href} aria-current={active===i?'location':undefined} onClick={e=>{e.preventDefault();setActive(i);setOpen(false);jump(item.id)}}><span>{String(i+1).padStart(2,'0')}</span>{item.label}</a>)}<a href="/how-it-works.html"><span>↗</span>How it works</a></nav>}</header>
}
