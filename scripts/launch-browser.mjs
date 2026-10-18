// launch-browser.mjs – the browser the page tests drive: BROWSER=chromium (the
// default), firefox or webkit (Safari's engine), each from Playwright. CI runs
// the browser and co-op tests in all three (.github/workflows/browsers.yml).
//
//   BROWSER=firefox npm run test:browser
//
// Each gets what a player's browser would have after a click: audio allowed to
// start, and for WebRTC on one machine, host candidates as plain addresses
// rather than mDNS names.
import * as playwright from 'playwright';

export const browserName = process.env.BROWSER || 'chromium';

export function launchBrowser() {
  if (browserName === 'chromium') {
    return playwright.chromium.launch({
      executablePath: process.env.CHROMIUM || undefined,
      args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'],
    });
  }
  if (browserName === 'firefox') {
    return playwright.firefox.launch({
      firefoxUserPrefs: {
        'media.autoplay.default': 0,                               // (allowed)
        'media.autoplay.blocking_policy': 0,
        'media.peerconnection.ice.obfuscate_host_addresses': false,
      },
    });
  }
  if (browserName === 'webkit') return playwright.webkit.launch();
  throw new Error(`BROWSER=${browserName}: chromium, firefox or webkit`);
}
