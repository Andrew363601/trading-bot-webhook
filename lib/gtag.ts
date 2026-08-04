export const GA_MEASUREMENT_ID = 'G-7REMMP1S7R';

declare global {
  interface Window {
    gtag: (command: string, ...args: any[]) => void;
    dataLayer: any[];
  }
}

export const trackGA4Event = (eventName: string, params: Record<string, any> = {}) => {
  if (typeof window === 'undefined') return;

  window.dataLayer = window.dataLayer || [];

  if (typeof window.gtag === 'function') {
    window.gtag('event', eventName, params);
  } else {
    window.dataLayer.push(['event', eventName, params]);
  }
};
