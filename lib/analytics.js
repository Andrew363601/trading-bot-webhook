export const GA_MEASUREMENT_ID = 'G-7REMMP1S7R';

export const trackEvent = (eventName, params = {}) => {
  if (typeof window === 'undefined') return;

  window.dataLayer = window.dataLayer || [];

  if (typeof window.gtag === 'function') {
    window.gtag('event', eventName, params);
    return;
  }

  window.dataLayer.push({ event: eventName, ...params });
};
