// VIOLATES fe.env.no-secret-in-public-env
export const stripeSecret = import.meta.env.VITE_STRIPE_SECRET;

// Clean: a genuinely public value behind the public prefix is fine.
export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL;
