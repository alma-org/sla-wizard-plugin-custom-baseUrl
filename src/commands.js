const nginxStrip = require("sla-wizard-plugin-nginx-strip");
const { applyBaseUrlTransformations } = require("./nginx-transform");

/**
 * Generates full nginx config (nginx.conf + conf.d/) with both x-nginx-strip
 * path stripping and x-nginx-server-baseurl per-endpoint proxy_pass overrides.
 *
 * Delegates to sla-wizard-plugin-nginx-strip for SLA path expansion and strip
 * transforms, then applies the base URL transformation on top.
 *
 * @param {Object} options - Command options (outDir, oas, sla, …)
 * @param {Object} ctx     - sla-wizard context
 */
function configNginxBaseUrl(options, ctx) {
  nginxStrip.configNginxStrip(options, ctx);
  applyBaseUrlTransformations(options.outDir, options.oas || "./specs/oas.yaml");
  console.log("✓ x-nginx-server-baseurl transformations applied");
}

/**
 * Generates only conf.d/ files with both strip and base URL transformations.
 *
 * @param {Object} options - Command options (outDir, oas, sla, …)
 * @param {Object} ctx     - sla-wizard context
 */
function addToBaseUrlConfd(options, ctx) {
  nginxStrip.addToStripConfd(options, ctx);
  applyBaseUrlTransformations(options.outDir, options.oas || "./specs/oas.yaml");
  console.log("✓ x-nginx-server-baseurl transformations applied");
}

module.exports = { configNginxBaseUrl, addToBaseUrlConfd };
