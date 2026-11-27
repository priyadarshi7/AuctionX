// Which addresses Express may believe when they say "I am forwarding for
// someone else" (ADR-0047). Without this, req.ip behind a proxy is the
// proxy's own address and every visitor shares one rate-limit bucket.
//
// Express reads X-Forwarded-For from the right and stops at the first address
// NOT listed here: that is the client. Entries a client writes itself sit
// further left and are never reached. A list of addresses is used instead of a
// hop count so the answer does not depend on how many proxies are in front,
// and instead of `true`, which would believe whatever the client sent.
export const TRUSTED_PROXIES = [
  // The host's own private network (and local development).
  'loopback',
  'linklocal',
  'uniquelocal',
  '100.64.0.0/10',

  // Cloudflare, which sits in front of Render. Copied 2026-11-27 from
  // https://www.cloudflare.com/ips-v4 and /ips-v6; re-check if client IPs in
  // the logs start showing Cloudflare addresses.
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
];
