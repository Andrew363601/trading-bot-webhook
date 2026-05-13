// lib/constants.js

export const COINBASE_AFFILIATE_URL = process.env.NEXT_PUBLIC_COINBASE_AFFILIATE_URL || 'https://www.coinbase.com/join/YOUR_REFERRAL_ID';

/**
 * Returns the affiliate link, potentially with dynamic tracking parameters.
 */
export const getCoinbaseAffiliateLink = (utmSource = 'nexus_app') => {
    const url = new URL(COINBASE_AFFILIATE_URL);
    url.searchParams.set('utm_source', utmSource);
    return url.toString();
};
