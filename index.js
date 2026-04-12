const { configNginxBaseUrl, addToBaseUrlConfd } = require("./src/commands");
const {
  applyBaseUrlToConfig,
  applyBaseUrlTransformations,
} = require("./src/nginx-transform");

/**
 * Plugin that generates nginx configuration with per-endpoint proxy_pass
 * overrides driven by the x-nginx-server-baseurl OAS vendor extension.
 *
 * When a path in the OAS declares:
 *   x-nginx-server-baseurl: http://backend-host:port
 *
 * the generated nginx location blocks for that endpoint will use the specified
 * URL in their proxy_pass directive instead of the global servers[0].url.
 * Paths without the extension continue to use the global default.
 *
 * This plugin also inherits x-nginx-strip support (via sla-wizard-plugin-nginx-strip),
 * so it works with OAS files that combine both extensions and SLAs that
 * reference the stripped (backend) paths in their rate definitions.
 *
 * @param {Object} program - Commander program instance
 * @param {Object} ctx     - Context with utils and generate functions
 */
function apply(program, ctx) {
  program
    .command("config-nginx-baseurl")
    .description(
      "Generate nginx configuration with x-nginx-server-baseurl per-endpoint proxy_pass support",
    )
    .requiredOption(
      "-o, --outDir <outputDirectory>",
      "Output directory for nginx.conf and conf.d/",
    )
    .option(
      "--sla <slaPath>",
      "One of: 1) single SLA, 2) folder of SLAs, 3) URL returning an array of SLA objects",
      "./specs/sla.yaml",
    )
    .option("--oas <pathToOAS>", "Path to an OAS v3 file.", "./specs/oas.yaml")
    .option(
      "--customTemplate <customTemplate>",
      "Custom proxy configuration template.",
    )
    .option(
      "--authLocation <authLocation>",
      "Where to look for the authentication parameter. Must be one of: header, query, url.",
      "header",
    )
    .option(
      "--authName <authName>",
      'Name of the authentication parameter, such as "token" or "apikey".',
      "apikey",
    )
    .option("--proxyPort <proxyPort>", "Port on which the proxy is running", 80)
    .action(function (options) {
      configNginxBaseUrl(options, ctx);
    });

  program
    .command("add-to-baseurl-confd")
    .description(
      "Generate conf.d files with x-nginx-server-baseurl proxy_pass overrides (no nginx.conf)",
    )
    .requiredOption(
      "-o, --outDir <outputDirectory>",
      "Output directory for conf.d/",
    )
    .option(
      "--sla <slaPath>",
      "One of: 1) single SLA, 2) folder of SLAs, 3) URL returning an array of SLA objects",
      "./specs/sla.yaml",
    )
    .option("--oas <pathToOAS>", "Path to an OAS v3 file.", "./specs/oas.yaml")
    .option(
      "--customTemplate <customTemplate>",
      "Custom proxy configuration template.",
    )
    .option(
      "--authLocation <authLocation>",
      "Where to look for the authentication parameter. Must be one of: header, query, url.",
      "header",
    )
    .option(
      "--authName <authName>",
      'Name of the authentication parameter, such as "token" or "apikey".',
      "apikey",
    )
    .option("--proxyPort <proxyPort>", "Port on which the proxy is running", 80)
    .action(function (options) {
      addToBaseUrlConfd(options, ctx);
    });
}

module.exports = {
  apply,
  configNginxBaseUrl,
  addToBaseUrlConfd,
  applyBaseUrlToConfig,
  applyBaseUrlTransformations,
};
