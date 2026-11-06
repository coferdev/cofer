import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import Loader from '@/components/ui/3d-box-loader-animation';
import { LandingNavigation } from '@/landing-nav';
import './styles/ui.css';
import './styles/loader.css';

function LoadScreen(){
 const [phase,setPhase]=useState<'loading'|'leaving'|'done'>('loading');
 const finishRef=React.useRef<()=>void>(()=>{});
 const readyRef=React.useRef(false);
 useEffect(()=>{
  const reduced=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const started=performance.now(); let timer=0, finishTimer=0, stopped=false;
  const finish=()=>{if(stopped)return;performance.mark('cofer-loader-exit');stopped=true;document.getElementById('cofer-loader-root')?.removeAttribute('data-pending');setPhase('leaving');finishTimer=window.setTimeout(()=>setPhase('done'),reduced?0:500)};
  finishRef.current=finish;
  const poll=()=>{
   readyRef.current=document.body.dataset.page==='dashboard'?!!document.querySelector('[data-dashboard-ready]'):!!document.querySelector('[data-framer-name="Hero"]');
   const elapsed=performance.now()-started;
   // Keep the full three-second animation cycle; only skip it for reduced motion.
   if((reduced&&readyRef.current&&elapsed>=150)||elapsed>=9000){finish();return}
   timer=window.setTimeout(poll,100);
  };
  poll();return()=>{stopped=true;clearTimeout(timer);clearTimeout(finishTimer);finishRef.current=()=>{}};
 },[]);
 if(phase==='done')return null;
 return <div className={`site-loading${phase==='leaving'?' is-leaving':''}`} role="status" aria-label="Loading Cofer" aria-hidden={phase==='leaving'} onAnimationIteration={event=>{if(event.animationName==='box-move0'&&readyRef.current){performance.mark('cofer-loader-cycle-complete');document.getElementById('cofer-loader-root')?.setAttribute('data-cycle-complete','');finishRef.current()}}}><Loader/><span className="loader-label">COFER / LOADING</span></div>;
}
const loading=document.getElementById('cofer-loader-root');if(loading){if(document.documentElement.hasAttribute('data-skip-dashboard-loader'))loading.remove();else createRoot(loading).render(<LoadScreen/>);}
const landingNav=document.getElementById('cofer-landing-nav-root');if(landingNav){createRoot(landingNav).render(<LandingNavigation/>);document.body.setAttribute('data-cofer-navigation-ready','');}
