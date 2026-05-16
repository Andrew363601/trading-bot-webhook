// components/ChatNotification.js
// Floating notification pill for mobile — appears when the Nexus Chat
// is below the viewport and the user has an unread onboarding message.

import React, { useState, useEffect, useRef } from 'react';
import { MessageCircle, ChevronDown } from 'lucide-react';

export default function ChatNotification({ chatSelector = '#nexus-chat', isOnboarding = false }) {
  const [isVisible, setIsVisible] = useState(false);
  const chatRef = useRef(null);

  useEffect(() => {
    const chatEl = document.querySelector(chatSelector);
    if (!chatEl) return;
    chatRef.current = chatEl;

    const observer = new IntersectionObserver(
      ([entry]) => {
        // Show notification when chat is NOT visible in viewport
        setIsVisible(!entry.isIntersecting);
      },
      { threshold: 0.1, rootMargin: '0px 0px -80px 0px' }
    );

    observer.observe(chatEl);
    return () => observer.disconnect();
  }, [chatSelector]);

  const handleClick = () => {
    const chatEl = document.querySelector(chatSelector);
    if (chatEl) {
      chatEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  if (!isVisible || !isOnboarding) return null;

  return (
    <button
      onClick={handleClick}
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[250] 
        bg-indigo-600/90 backdrop-blur-md border border-indigo-400/30 
        rounded-full px-5 py-3 shadow-2xl shadow-indigo-500/20 
        flex items-center gap-3 
        animate-bounce-subtle
        hover:bg-indigo-500 transition-all
        sm:hidden" /* Only show on mobile */
    >
      <div className="relative">
        <MessageCircle size={16} className="text-white" />
        <span className="absolute -top-1 -right-1 w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
      </div>
      <span className="text-white text-[11px] font-bold whitespace-nowrap">
        Nexus has a message for you
      </span>
      <ChevronDown size={14} className="text-white/70 animate-bounce" />

      <style jsx>{`
        @keyframes bounce-subtle {
          0%, 100% { transform: translateX(-50%) translateY(0); }
          50% { transform: translateX(-50%) translateY(-4px); }
        }
        .animate-bounce-subtle {
          animation: bounce-subtle 2s ease-in-out infinite;
        }
      `}</style>
    </button>
  );
}