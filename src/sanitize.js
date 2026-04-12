/**
 * Mirrors sla-wizard's sanitizeEndpoint: keeps only [A-Za-z0-9-] and drops
 * everything else (slashes, underscores, dots, …).
 */
function sanitizeEndpoint(input) {
  return input.replace(/[^A-Za-z0-9-]/g, "");
}

module.exports = { sanitizeEndpoint };
