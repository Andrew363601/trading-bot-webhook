// components/QuickStartGuide.js
// Coach marks overlay that highlights UI sections with tooltip cards.
// Responsive for web and mobile. Supports external jumpToStep() calls.

import React, { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { QUICK_START_STEPS } from '../lib/quick-start-config';
import { X, ChevronLeft, ChevronRight, SkipForward } from 'lucide-react';

const QuickStartGuide = forwardRef(({ tenantId, onDismiss, onComplete, onBeforeStep, onAfterStep, onInitialize }, ref) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [isVisible, setIsVisible] = useState(true);
  const [tooltipStyle, setTooltipStyle] = useState({});
  const [ringStyle, setRingStyle] = useState({ display: 'none' });
  const [isMobile, setIsMobile] = useState(false);

  // Check viewport size
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Call onInitialize when component first mounts to set up initial state
  useEffect(() => {
    if (onInitialize) {
      onInitialize(currentStep);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Expose jumpToStep to parent via ref
  useImperativeHandle(ref, () => ({
    jumpToStep: (stepId) => {
      const idx = QUICK_START_STEPS.findIndex(s => s.id === stepId);
      if (idx !== -1) {
        setCurrentStep(idx);
      }
    },
    show: () => setIsVisible(true),
    hide: () => setIsVisible(false)
  }));

  // Position tooltip relative to target element
  const positionTooltip = useCallback((stepIndex) => {
    const step = QUICK_START_STEPS[stepIndex];
    if (!step) return;

    const el = document.querySelector(step.selector);
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const pos = isMobile && step.mobilePos ? step.mobilePos : step.pos;
    const gap = 12;
    let style = {};

    switch (pos) {
      case 'top':
        style = {
          left: rect.left + rect.width / 2,
          top: rect.top - gap,
          transform: 'translateX(-50%) translateY(-100%)'
        };
        break;
      case 'bottom':
        style = {
          left: rect.left + rect.width / 2,
          top: rect.bottom + gap,
          transform: 'translateX(-50%)'
        };
        break;
      case 'left':
        style = {
          left: rect.left - gap,
          top: rect.top + rect.height / 2,
          transform: 'translateX(-100%) translateY(-50%)'
        };
        break;
      case 'right':
        style = {
          left: rect.right + gap,
          top: rect.top + rect.height / 2,
          transform: 'translateY(-50%)'
        };
        break;
    }

    // Auto-override left/right positions on small viewports
    let effectivePos = pos;
    const viewportPadding = 20;
    if (effectivePos === 'left' && rect.left < 350) {
      effectivePos = 'bottom';
    } else if (effectivePos === 'right' && window.innerWidth - rect.right < 350) {
      effectivePos = 'bottom';
    }

    // Recalculate if position was overridden
    if (effectivePos !== pos) {
      switch (effectivePos) {
        case 'bottom':
          style = {
            left: rect.left + rect.width / 2,
            top: rect.bottom + gap,
            transform: 'translateX(-50%)'
          };
          break;
      }
    }

    // Ensure tooltip stays within viewport.
    // The card width is min(320, 90vw); clamping MUST account for the horizontal
    // transform (-50% centered, -100% right-anchored, or 0 left-anchored), otherwise
    // edge-anchored steps (e.g. the Settings / API-key steps 8–11) overflow and get cut off.
    const tooltipWidth = Math.min(320, window.innerWidth * 0.9);
    const tooltipHeight = 400;
    const transform = style.transform || '';

    if (typeof style.left === 'number') {
      // Compute the card's actual left/right edges given the transform, then shift
      // `left` so both edges stay inside the viewport padding.
      let edgeLeft;
      if (transform.includes('translateX(-50%)')) edgeLeft = style.left - tooltipWidth / 2;
      else if (transform.includes('translateX(-100%)')) edgeLeft = style.left - tooltipWidth;
      else edgeLeft = style.left;

      const minEdge = viewportPadding;
      const maxEdge = window.innerWidth - tooltipWidth - viewportPadding;
      let clampedEdge = Math.max(minEdge, Math.min(edgeLeft, maxEdge));
      const delta = clampedEdge - edgeLeft;
      style.left = style.left + delta;
    }
    
    if (typeof style.top === 'number') {
      // Compute the card's ACTUAL top edge given the vertical transform, then
      // shift `top` so the whole card stays on-screen. Previously this only
      // checked style.top directly, so 'top'-anchored steps (translateY(-100%),
      // e.g. the Settings / API-key steps) computed a positive style.top whose
      // real top edge was hundreds of px above the viewport — rendering the
      // message off-screen on mobile.
      let edgeTop;
      if (transform.includes('translateY(-100%)')) edgeTop = style.top - tooltipHeight;
      else if (transform.includes('translateY(-50%)')) edgeTop = style.top - tooltipHeight / 2;
      else edgeTop = style.top;

      const minEdge = viewportPadding;
      const maxEdge = window.innerHeight - tooltipHeight - viewportPadding;
      const clampedEdge = Math.max(minEdge, Math.min(edgeTop, Math.max(minEdge, maxEdge)));
      style.top = style.top + (clampedEdge - edgeTop);
    }

    setTooltipStyle(style);

    // Update highlight ring position
    setRingStyle({
      left: rect.left - 4,
      top: rect.top - 4,
      width: rect.width + 8,
      height: rect.height + 8
    });

    // Auto-scroll to target on mobile so the highlighted area is visible
    if (isMobile) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [isMobile]);

  // Reposition on scroll/resize
  useEffect(() => {
    if (!isVisible) return;
    positionTooltip(currentStep);
    const handleUpdate = () => positionTooltip(currentStep);
    window.addEventListener('scroll', handleUpdate, true);
    window.addEventListener('resize', handleUpdate);
    return () => {
      window.removeEventListener('scroll', handleUpdate, true);
      window.removeEventListener('resize', handleUpdate);
    };
  }, [currentStep, isVisible, positionTooltip]);

  const handleNext = () => {
    const nextStep = currentStep + 1;
    if (onBeforeStep) onBeforeStep(currentStep, nextStep);
    if (nextStep >= QUICK_START_STEPS.length) {
      handleComplete();
    } else {
      setCurrentStep(nextStep);
    }
  };

  const handleBack = () => {
    const prevStep = currentStep - 1;
    if (onBeforeStep) onBeforeStep(currentStep, prevStep);
    if (prevStep >= 0) {
      setCurrentStep(prevStep);
    }
  };

  // Fire onAfterStep after step state updates
  useEffect(() => {
    if (onAfterStep) onAfterStep(currentStep);
  }, [currentStep, onAfterStep]);

  const handleSkip = () => {
    setIsVisible(false);
    if (onDismiss) onDismiss(); // Parent handles saving with proper auth
  };

  const handleComplete = () => {
    setIsVisible(false);
    if (onComplete) onComplete(); // Parent handles saving with proper auth
  };

  if (!isVisible) return null;

  const step = QUICK_START_STEPS[currentStep];
  if (!step) return null;

  const isLastStep = currentStep === QUICK_START_STEPS.length - 1;
  const isFirstStep = currentStep === 0;

  return (
    <>
      {/* Backdrop overlay — transparent, allows touch scrolling on mobile */}
      <div className="fixed inset-0 z-[300]" style={{ background: 'transparent' }} onClick={handleSkip} />

      {/* Highlight ring around target */}
      <div
        className="fixed z-[301] pointer-events-none"
        style={{
          border: '2px solid rgba(99, 102, 241, 0.6)',
          borderRadius: '12px',
          boxShadow: '0 0 0 4px rgba(99, 102, 241, 0.15), 0 0 30px rgba(99, 102, 241, 0.2)',
          animation: 'pulse-ring 2s ease-in-out infinite',
          ...ringStyle
        }}
      />

      {/* Tooltip card */}
      <div
        className="fixed z-[302] w-[320px] max-w-[calc(100vw-32px)] bg-slate-900 border border-indigo-500/30 rounded-2xl shadow-2xl shadow-indigo-500/10 p-5 overflow-x-hidden overflow-y-auto break-words max-h-[calc(100vh-40px)]"
        style={tooltipStyle}
      >
        {/* Arrow pointer */}
        <div className="absolute w-3 h-3 bg-slate-900 border-l border-t border-indigo-500/30 rotate-45"
          style={{
            ...(step.pos === 'top' ? { bottom: -6.5, left: '50%', marginLeft: -6 } : {}),
            ...(step.pos === 'bottom' ? { top: -6.5, left: '50%', marginLeft: -6, borderLeft: 'none', borderTop: 'none', borderRight: '1px solid rgba(99,102,241,0.3)', borderBottom: '1px solid rgba(99,102,241,0.3)' } : {}),
            ...(step.pos === 'left' ? { right: -6.5, top: '50%', marginTop: -6, borderLeft: 'none', borderBottom: 'none', borderRight: '1px solid rgba(99,102,241,0.3)', borderTop: '1px solid rgba(99,102,241,0.3)' } : {}),
            ...(step.pos === 'right' ? { left: -6.5, top: '50%', marginTop: -6, borderRight: 'none', borderTop: 'none', borderLeft: '1px solid rgba(99,102,241,0.3)', borderBottom: '1px solid rgba(99,102,241,0.3)' } : {})
          }}
        />

        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <span className="text-[9px] font-black text-indigo-400 uppercase tracking-widest">
            Step {currentStep + 1} of {QUICK_START_STEPS.length}
          </span>
          <button onClick={handleSkip} className="p-1 rounded-lg hover:bg-white/5 text-slate-500 hover:text-slate-300 transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Title */}
        <h3 className="text-sm font-black text-white mb-2 uppercase tracking-tight">{step.title}</h3>

        {/* Description */}
        <p className="text-[11px] text-slate-400 leading-relaxed mb-5 break-words">{step.desc}</p>

        {/* Progress bar */}
        <div className="w-full h-1 bg-slate-800 rounded-full mb-4 overflow-hidden">
          <div
            className="h-full bg-indigo-500 rounded-full transition-all duration-300"
            style={{ width: `${((currentStep + 1) / QUICK_START_STEPS.length) * 100}%` }}
          />
        </div>

        {/* Buttons */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-2">
            {!isFirstStep && (
              <button
                onClick={handleBack}
                className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-[10px] font-bold transition-colors flex items-center gap-1"
              >
                <ChevronLeft size={12} /> Back
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleSkip}
              className="px-3 py-2 rounded-xl text-slate-500 hover:text-slate-300 text-[10px] font-bold transition-colors flex items-center gap-1"
            >
              <SkipForward size={12} /> Skip
            </button>
            <button
              onClick={handleNext}
              className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-bold transition-colors flex items-center gap-1 shadow-lg shadow-indigo-500/20"
            >
              {isLastStep ? 'Done' : 'Next'} <ChevronRight size={12} />
            </button>
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes pulse-ring {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
    </>
  );
});

QuickStartGuide.displayName = 'QuickStartGuide';
export default QuickStartGuide;