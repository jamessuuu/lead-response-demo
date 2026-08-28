import { defineConfig } from 'astro/config';

// `site` (the canonical URL) is deliberately unset: per the Spec section 18
// dispatcher decision, the *.pages.dev subdomain is chosen when the Pages
// project is first created (M0 deploy step, not run in this session) and
// the product name goes through the identity brief before M3. Setting a
// placeholder domain here would be exactly the kind of invented fact the
// honesty architecture refuses.
export default defineConfig({
  output: 'static',
  trailingSlash: 'never',
  build: {
    // Ship every stylesheet as an external, cacheable file rather than
    // inlined <style> tags, so _headers can set a strict `style-src 'self'`
    // (no 'unsafe-inline') instead of loosening the CSP to fit the build.
    inlineStylesheets: 'never',
  },
});
