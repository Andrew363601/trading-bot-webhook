// components/QuickStartGuide.js
// Coach marks overlay that highlights UI sections with tooltip cards.
// Responsive for web and mobile. Supports external jumpToStep() calls.

import React, { useState, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { QUICK_START_STEPS } from '../lib/quick-start-config';
import { X, ChevronLeft, ChevronRight, SkipForward } from 'lucide-react';

const QuickStartGuide = forwardRef(({ tenantId, onDismiss, onComplete }, ref) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [isVisible, setIsVisible] = useState(true);
  const [tooltipStyle, setTooltipStyle] = useState({});
  const [isMobile, setIsMobile] = useState(false);

  // Check viewport size
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
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

    // Ensure tooltip stays within viewport
    const tooltipWidth = 320;
    const tooltipHeight = 200;
    if (style.left && typeof style.left === 'number') {
      if (style.left - tooltipWidth / 2 < 10) style.left = tooltipWidth / 2 + 10;
      if (style.left + tooltipWidth / 2 > window.innerWidth - 10) style.left = window.innerWidth - tooltipWidth / 2 - 10;
    }
    if (style.top && typeof style.top === 'number') {
      if (style.top < 10) style.top = 10;
      if (style.top + tooltipHeight > window.innerHeight - 10) style.top = window.innerHeight - tooltipHeight - 10;
    }

    setTooltipStyle(style);
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
    if (currentStep < QUICK_START_STEPS.length - 1) {
      setCurrentStep(prev => prev + 1);
    } else {
      handleComplete();
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setCurrentStep(prev => prev - 1);
    }
  };

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
      {/* Backdrop overlay */}
      <div className="fixed inset-0 z-[300] bg-black/60 backdrop-blur-sm" onClick={handleSkip} />

      {/* Highlight ring around target */}
      <div
        className="fixed z-[301] pointer-events-none"
        style={{
          border: '2px solid rgba(99, 102, 241, 0.6)',
          borderRadius: '12px',
          boxShadow: '0 0 0 4px rgba(99, 102, 241, 0.15), 0 0 30px rgba(99, 102, 241, 0.2)',
          animation: 'pulse-ring 2s ease-in-out infinite',
          ...(document.querySelector(step.selector)?.getBoundingClientRect() ? {
            left: document.querySelector(step.selector).getBoundingClientRect().left - 4,
            top: document.querySelector(step.selector).getBoundingClientRect().top - 4,
            width: document.querySelector(step.selector).getBoundingClientRect().width + 8,
            height: document.querySelector(step.selector).getBoundingClientRect().height + 8
          } : { display: 'none' })
        }}
      />

      {/* Tooltip card */}
      <div
        className="fixed z-[302] w-[320px] max-w-[90vw] bg-slate-900 border border-indigo-500/30 rounded-2xl shadow-2xl shadow-indigo-500/10 p-5"
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
        <p className="text-[11px] text-slate-400 leading-relaxed mb-5">{step.desc}</p>

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