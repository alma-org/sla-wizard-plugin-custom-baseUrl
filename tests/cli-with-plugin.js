#!/usr/bin/env node
/**
 * CLI wrapper for tests: loads sla-wizard, registers the custom-baseUrl plugin,
 * then delegates to sla-wizard's CLI runner.
 *
 * Usage: node cli-with-plugin.js <command> [options]
 */
const slaWizard = require("sla-wizard");
const customBaseUrlPlugin = require("../index.js");

slaWizard.use(customBaseUrlPlugin);

slaWizard.program.parse(process.argv);
