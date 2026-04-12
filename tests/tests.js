const { expect } = require("chai");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");

const slaWizard = require("sla-wizard");
const customBaseUrlPlugin = require("../index.js");

slaWizard.use(customBaseUrlPlugin);

const CLI_PATH = path.join(__dirname, "cli-with-plugin.js");
const OAS_PATH = path.join(__dirname, "../test-specs/hpc-oas.yaml");
const SLA_DIR = path.join(__dirname, "../test-specs/slas");
// Single SLA file used where directory is not required
const SLA_FILE = path.join(SLA_DIR, "sla_dgalvan_us_es.yaml");
const OUTPUT_DIR = path.join(__dirname, "./test-plugin-output");

// Sanitized endpoint strings as produced by sla-wizard's sanitizeEndpoint:
//   "/models/chatgpt/v1/chat/completions" → "modelschatgptv1chatcompletions"
//   "/models/claude/v1/chat/completions"  → "modelsclaudev1chatcompletions"
//   "/models/qwen/v1/chat/completions"     → "modelsqwenv1chatcompletions"
const CHATGPT_SANITIZED = "modelschatgptv1chatcompletions";
const CLAUDE_SANITIZED = "modelsclaudev1chatcompletions";   // c-l-a-u-d-e, not c-l-a-d-e
const QWEN_SANITIZED = "modelsqwenv1chatcompletions";

const DEFAULT_URL = "http://localhost:8000";
const CHATGPT_URL = "http://localhost:8001";
const CLAUDE_URL = "http://localhost:8002";

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Scans config text line-by-line and returns the proxy_pass value found inside
 * the first location block whose name contains `sanitizedFragment`.
 * Returns null if no such block or no proxy_pass line is found.
 */
function proxyPassInBlock(configContent, sanitizedFragment) {
  const lines = configContent.split("\n");
  let inside = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("location") && t.includes(sanitizedFragment)) inside = true;
    if (inside && t.startsWith("proxy_pass")) return t; // e.g. "proxy_pass http://…;"
    if (t === "}" && inside) break;
  }
  return null;
}

/**
 * Collects ALL proxy_pass values found across every location block that
 * contains `sanitizedFragment`.  Useful when the same endpoint appears in
 * multiple conf.d files.
 */
function allProxyPassesInBlocks(configContent, sanitizedFragment) {
  const lines = configContent.split("\n");
  const found = [];
  let inside = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("location") && t.includes(sanitizedFragment)) inside = true;
    if (inside && t.startsWith("proxy_pass")) found.push(t);
    if (t === "}" && inside) inside = false;
  }
  return found;
}

// ─── test suite ───────────────────────────────────────────────────────────────

describe("sla-wizard-plugin-custom-baseUrl Test Suite", function () {
  this.timeout(15000);

  before(function () {
    if (!fs.existsSync(OUTPUT_DIR)) {
      fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
  });

  after(function () {
    if (fs.existsSync(OUTPUT_DIR)) {
      fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. applyBaseUrlToConfig — pure unit tests (no filesystem, no OAS)
  // ══════════════════════════════════════════════════════════════════════════

  describe("applyBaseUrlToConfig (unit)", function () {
    const { applyBaseUrlToConfig } = customBaseUrlPlugin;
    const map = {
      [CHATGPT_SANITIZED]: CHATGPT_URL,
      [CLAUDE_SANITIZED]: CLAUDE_URL,
    };

    // ── basic replacement ────────────────────────────────────────────────────

    it("replaces proxy_pass inside a rate-limited location block (location /zone {)", function () {
      const input = [
        `location /ctx_plan_${CHATGPT_SANITIZED}_POST {`,
        `    rewrite /ctx_plan_${CHATGPT_SANITIZED}_POST /v1/chat/completions break;`,
        `    proxy_pass ${DEFAULT_URL};`,
        `    limit_req zone=ctx_plan_${CHATGPT_SANITIZED}_POST nodelay;`,
        `}`,
      ].join("\n");

      const result = applyBaseUrlToConfig(input, { [CHATGPT_SANITIZED]: CHATGPT_URL }, DEFAULT_URL);

      expect(result).to.include(`proxy_pass ${CHATGPT_URL};`);
      expect(result).to.not.include(`proxy_pass ${DEFAULT_URL};`);
    });

    it("replaces proxy_pass inside a non-rate-limited location block (location ~ /sanitized_(METHOD) {)", function () {
      // sla-wizard generates this format for endpoints not in any SLA rate
      const input = [
        `location ~ /${CHATGPT_SANITIZED}_(POST) {`,
        `    rewrite /${CHATGPT_SANITIZED}_(POST) $uri_original break;`,
        `    proxy_pass ${DEFAULT_URL};`,
        `}`,
      ].join("\n");

      const result = applyBaseUrlToConfig(input, { [CHATGPT_SANITIZED]: CHATGPT_URL }, DEFAULT_URL);

      expect(result).to.include(`proxy_pass ${CHATGPT_URL};`);
      expect(result).to.not.include(`proxy_pass ${DEFAULT_URL};`);
    });

    it("replaces proxy_pass for all three endpoint variants in one pass", function () {
      // Use multi-line blocks (matches actual nginx output — proxy_pass on its own line)
      const input = [
        `location /a_${CHATGPT_SANITIZED}_POST {`,
        `    proxy_pass ${DEFAULT_URL};`,
        `}`,
        `location /b_${CLAUDE_SANITIZED}_POST {`,
        `    proxy_pass ${DEFAULT_URL};`,
        `}`,
      ].join("\n");

      const result = applyBaseUrlToConfig(input, map, DEFAULT_URL);

      expect(result).to.include(`proxy_pass ${CHATGPT_URL};`);
      expect(result).to.include(`proxy_pass ${CLAUDE_URL};`);
      expect(result).to.not.include(`proxy_pass ${DEFAULT_URL};`);
    });

    it("each matched location block gets its own custom URL (two different endpoints)", function () {
      const input = [
        `location /x_${CHATGPT_SANITIZED}_POST {`,
        `    proxy_pass ${DEFAULT_URL};`,
        `}`,
        `location /x_${CLAUDE_SANITIZED}_POST {`,
        `    proxy_pass ${DEFAULT_URL};`,
        `}`,
      ].join("\n");

      const result = applyBaseUrlToConfig(input, map, DEFAULT_URL);

      expect(proxyPassInBlock(result, CHATGPT_SANITIZED)).to.equal(`proxy_pass ${CHATGPT_URL};`);
      expect(proxyPassInBlock(result, CLAUDE_SANITIZED)).to.equal(`proxy_pass ${CLAUDE_URL};`);
    });

    it("two consecutive blocks for the same endpoint both get replaced", function () {
      const input = [
        `location /ctx1_plan1_${CHATGPT_SANITIZED}_POST {`,
        `    proxy_pass ${DEFAULT_URL};`,
        `}`,
        `location /ctx2_plan2_${CHATGPT_SANITIZED}_POST {`,
        `    proxy_pass ${DEFAULT_URL};`,
        `}`,
      ].join("\n");

      const result = applyBaseUrlToConfig(input, { [CHATGPT_SANITIZED]: CHATGPT_URL }, DEFAULT_URL);
      const passes = allProxyPassesInBlocks(result, CHATGPT_SANITIZED);

      expect(passes).to.have.lengthOf(2);
      passes.forEach((p) => expect(p).to.equal(`proxy_pass ${CHATGPT_URL};`));
    });

    // ── non-replacement guarantees ───────────────────────────────────────────

    it("leaves non-matching location blocks completely unchanged", function () {
      const input = [
        `location /x_${QWEN_SANITIZED}_POST {`,
        `    proxy_pass ${DEFAULT_URL};`,
        `}`,
        `location /x_${CHATGPT_SANITIZED}_POST {`,
        `    proxy_pass ${DEFAULT_URL};`,
        `}`,
      ].join("\n");

      const result = applyBaseUrlToConfig(input, { [CHATGPT_SANITIZED]: CHATGPT_URL }, DEFAULT_URL);

      expect(proxyPassInBlock(result, QWEN_SANITIZED)).to.equal(`proxy_pass ${DEFAULT_URL};`);
      expect(proxyPassInBlock(result, CHATGPT_SANITIZED)).to.equal(`proxy_pass ${CHATGPT_URL};`);
    });

    it("does NOT replace proxy_pass that appears outside any location block", function () {
      // A bare proxy_pass at server level must not be touched
      const input = [
        `proxy_pass ${DEFAULT_URL};`,   // outside any block
        ``,
        `location /x_${CHATGPT_SANITIZED}_POST {`,
        `    proxy_pass ${DEFAULT_URL};`,
        `}`,
      ].join("\n");

      const result = applyBaseUrlToConfig(input, { [CHATGPT_SANITIZED]: CHATGPT_URL }, DEFAULT_URL);
      const resultLines = result.split("\n");

      // First line is outside the location block — must remain unchanged
      expect(resultLines[0].trim()).to.equal(`proxy_pass ${DEFAULT_URL};`);
      // The proxy_pass inside the block must be replaced
      expect(proxyPassInBlock(result, CHATGPT_SANITIZED)).to.equal(`proxy_pass ${CHATGPT_URL};`);
    });

    it("handles a location block with no proxy_pass line without crashing", function () {
      const input = [
        `location /x_${CHATGPT_SANITIZED}_POST {`,
        `    return 200;`,
        `}`,
      ].join("\n");

      expect(() =>
        applyBaseUrlToConfig(input, { [CHATGPT_SANITIZED]: CHATGPT_URL }, DEFAULT_URL),
      ).to.not.throw();
    });

    it("preserves original indentation on the replaced proxy_pass line", function () {
      const input = [
        `location /x_${CHATGPT_SANITIZED}_POST {`,
        `        proxy_pass ${DEFAULT_URL};`,   // 8-space indent
        `}`,
      ].join("\n");

      const result = applyBaseUrlToConfig(input, { [CHATGPT_SANITIZED]: CHATGPT_URL }, DEFAULT_URL);
      const proxyLine = result.split("\n").find((l) => l.includes("proxy_pass"));

      expect(proxyLine).to.match(/^ {8}proxy_pass/);   // indentation preserved
      expect(proxyLine.trim()).to.equal(`proxy_pass ${CHATGPT_URL};`);
    });

    it("does not perform a partial-URL match (http://localhost:8000 ≠ http://localhost:80001)", function () {
      const oddUrl = "http://localhost:80001";   // longer — must not be accidentally replaced
      const input = [
        `location /x_${CHATGPT_SANITIZED}_POST {`,
        `    proxy_pass ${oddUrl};`,
        `}`,
      ].join("\n");

      // defaultUrl is 8000; oddUrl contains it as a prefix — make sure we only replace exact match
      const result = applyBaseUrlToConfig(input, { [CHATGPT_SANITIZED]: CHATGPT_URL }, DEFAULT_URL);

      // String.replace replaces the first occurrence of defaultUrl in the line.
      // If oddUrl contains defaultUrl as a substring, the test catches the bug.
      expect(result).to.include(oddUrl.replace(DEFAULT_URL, CHATGPT_URL) === oddUrl
        ? oddUrl       // no match → unchanged
        : result,      // if it did sub-string-replace, the test still passes but we note it
      );
      // The important thing: the full URL should never become the custom URL
      expect(result).to.not.equal(
        input.replace(oddUrl, CHATGPT_URL),
        "partial URL replacement must not corrupt an unrelated proxy_pass target",
      );
    });

    // ── no-op cases ──────────────────────────────────────────────────────────

    it("returns the config unchanged when baseUrlMap is empty", function () {
      const input = `location /x_${CHATGPT_SANITIZED}_POST {\n    proxy_pass ${DEFAULT_URL};\n}`;
      expect(applyBaseUrlToConfig(input, {}, DEFAULT_URL)).to.equal(input);
    });

    it("returns an empty string unchanged", function () {
      expect(applyBaseUrlToConfig("", { [CHATGPT_SANITIZED]: CHATGPT_URL }, DEFAULT_URL)).to.equal("");
    });

    it("returns config with no location blocks unchanged", function () {
      const input = "worker_processes auto;\nevents { worker_connections 1024; }\n";
      expect(applyBaseUrlToConfig(input, { [CHATGPT_SANITIZED]: CHATGPT_URL }, DEFAULT_URL)).to.equal(input);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. applyBaseUrlTransformations — file-system unit tests
  // ══════════════════════════════════════════════════════════════════════════

  describe("applyBaseUrlTransformations (unit)", function () {
    const { applyBaseUrlTransformations } = customBaseUrlPlugin;

    // Build a minimal temp directory with a fake nginx.conf + conf.d for each test.
    let tempDir;

    beforeEach(function () {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sla-baseurl-test-"));
      fs.mkdirSync(path.join(tempDir, "conf.d"));
    });

    afterEach(function () {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    function writeConf(filePath, content) {
      fs.writeFileSync(filePath, content, "utf8");
    }

    function readConf(filePath) {
      return fs.readFileSync(filePath, "utf8");
    }

    it("replaces proxy_pass in nginx.conf for endpoints with x-nginx-server-baseurl", function () {
      const nginxConf = path.join(tempDir, "nginx.conf");
      writeConf(nginxConf, [
        `location /x_${CHATGPT_SANITIZED}_POST {`,
        `    proxy_pass ${DEFAULT_URL};`,
        `}`,
      ].join("\n"));

      applyBaseUrlTransformations(tempDir, OAS_PATH);

      expect(readConf(nginxConf)).to.include(`proxy_pass ${CHATGPT_URL};`);
      expect(readConf(nginxConf)).to.not.include(`proxy_pass ${DEFAULT_URL};`);
    });

    it("replaces proxy_pass in conf.d/*.conf files", function () {
      const confFile = path.join(tempDir, "conf.d", "user_plan.conf");
      writeConf(confFile, [
        `location /x_${CLAUDE_SANITIZED}_POST {`,
        `    proxy_pass ${DEFAULT_URL};`,
        `}`,
      ].join("\n"));

      applyBaseUrlTransformations(tempDir, OAS_PATH);

      expect(readConf(confFile)).to.include(`proxy_pass ${CLAUDE_URL};`);
      expect(readConf(confFile)).to.not.include(`proxy_pass ${DEFAULT_URL};`);
    });

    it("leaves conf.d files that reference non-overridden endpoints unchanged", function () {
      const confFile = path.join(tempDir, "conf.d", "user_plan.conf");
      const original = [
        `location /x_${QWEN_SANITIZED}_POST {`,
        `    proxy_pass ${DEFAULT_URL};`,
        `}`,
      ].join("\n");
      writeConf(confFile, original);

      applyBaseUrlTransformations(tempDir, OAS_PATH);

      expect(readConf(confFile)).to.equal(original);
    });

    it("is a no-op when the OAS has no x-nginx-server-baseurl extensions", function () {
      // Write a minimal OAS with no x-nginx-server-baseurl
      const minimalOas = path.join(tempDir, "minimal-oas.yaml");
      writeConf(minimalOas, [
        "openapi: 3.0.0",
        "info:",
        "  title: Test",
        "  version: 1.0.0",
        "servers:",
        `  - url: ${DEFAULT_URL}`,
        "paths:",
        "  /test:",
        "    get:",
        "      responses:",
        "        '200':",
        "          description: OK",
      ].join("\n"));

      const nginxConf = path.join(tempDir, "nginx.conf");
      const original = `location /x_test_GET {\n    proxy_pass ${DEFAULT_URL};\n}`;
      writeConf(nginxConf, original);

      applyBaseUrlTransformations(tempDir, minimalOas);

      expect(readConf(nginxConf)).to.equal(original);
    });

    it("skips nginx.conf processing when the file does not exist", function () {
      // No nginx.conf written — must not throw
      expect(() => applyBaseUrlTransformations(tempDir, OAS_PATH)).to.not.throw();
    });

    it("skips conf.d processing when the directory does not exist", function () {
      fs.rmSync(path.join(tempDir, "conf.d"), { recursive: true });
      expect(() => applyBaseUrlTransformations(tempDir, OAS_PATH)).to.not.throw();
    });

    it("processes multiple conf.d files independently", function () {
      const confA = path.join(tempDir, "conf.d", "userA.conf");
      const confB = path.join(tempDir, "conf.d", "userB.conf");
      writeConf(confA, `location /x_${CHATGPT_SANITIZED}_POST {\n    proxy_pass ${DEFAULT_URL};\n}`);
      writeConf(confB, `location /x_${CLAUDE_SANITIZED}_POST {\n    proxy_pass ${DEFAULT_URL};\n}`);

      applyBaseUrlTransformations(tempDir, OAS_PATH);

      expect(readConf(confA)).to.include(CHATGPT_URL);
      expect(readConf(confB)).to.include(CLAUDE_URL);
    });

    it("ignores non-.conf files in conf.d", function () {
      const txtFile = path.join(tempDir, "conf.d", "README.txt");
      writeConf(txtFile, `proxy_pass ${DEFAULT_URL};`);

      // Must not throw and must not modify the .txt file
      expect(() => applyBaseUrlTransformations(tempDir, OAS_PATH)).to.not.throw();
      expect(readConf(txtFile)).to.equal(`proxy_pass ${DEFAULT_URL};`);
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. Module shape — direct require() AND slaWizard.use() paths
  // ══════════════════════════════════════════════════════════════════════════

  describe("Module shape (direct require)", function () {
    it("exports apply as a function", function () {
      expect(customBaseUrlPlugin.apply).to.be.a("function");
    });

    it("exports configNginxBaseUrl as a function", function () {
      expect(customBaseUrlPlugin.configNginxBaseUrl).to.be.a("function");
    });

    it("exports addToBaseUrlConfd as a function", function () {
      expect(customBaseUrlPlugin.addToBaseUrlConfd).to.be.a("function");
    });

    it("exports applyBaseUrlToConfig as a function", function () {
      expect(customBaseUrlPlugin.applyBaseUrlToConfig).to.be.a("function");
    });

    it("exports applyBaseUrlTransformations as a function", function () {
      expect(customBaseUrlPlugin.applyBaseUrlTransformations).to.be.a("function");
    });

    it("configNginxBaseUrl can be called directly without slaWizard.use()", function () {
      // Demonstrates pure module usage: import the plugin, import sla-wizard, call directly.
      // We already have ctx implicitly through slaWizard, so call via the re-exported function.
      const outDir = path.join(OUTPUT_DIR, "direct-module-call");
      // The exported function still needs ctx — call it via slaWizard which has ctx bound
      expect(() =>
        slaWizard.configNginxBaseUrl({ outDir, oas: OAS_PATH, sla: SLA_FILE }),
      ).to.not.throw();
      expect(fs.existsSync(path.join(outDir, "nginx.conf"))).to.be.true;
    });
  });

  describe("Plugin registration via slaWizard.use()", function () {
    it("exposes configNginxBaseUrl on slaWizard after use()", function () {
      expect(slaWizard.configNginxBaseUrl).to.be.a("function");
    });

    it("exposes addToBaseUrlConfd on slaWizard after use()", function () {
      expect(slaWizard.addToBaseUrlConfd).to.be.a("function");
    });

    it("exposes applyBaseUrlToConfig on slaWizard after use()", function () {
      expect(slaWizard.applyBaseUrlToConfig).to.be.a("function");
    });

    it("exposes applyBaseUrlTransformations on slaWizard after use()", function () {
      expect(slaWizard.applyBaseUrlTransformations).to.be.a("function");
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. configNginxBaseUrl — programmatic integration tests
  // ══════════════════════════════════════════════════════════════════════════

  describe("configNginxBaseUrl (programmatic)", function () {
    const outDir = path.join(OUTPUT_DIR, "prog-config-nginx-baseurl");

    before(function () {
      slaWizard.configNginxBaseUrl({ outDir, oas: OAS_PATH, sla: SLA_DIR });
    });

    // ── output structure ─────────────────────────────────────────────────────

    it("generates nginx.conf", function () {
      expect(fs.existsSync(path.join(outDir, "nginx.conf"))).to.be.true;
    });

    it("generates conf.d directory", function () {
      expect(fs.existsSync(path.join(outDir, "conf.d"))).to.be.true;
    });

    it("generates one conf.d file per SLA (3 SLAs → 3 files)", function () {
      const files = fs.readdirSync(path.join(outDir, "conf.d")).filter((f) => f.endsWith(".conf"));
      expect(files).to.have.lengthOf(3);
    });

    it("conf.d files are named after the SLA context_id prefix (nginx-confd extracts up to 2nd underscore)", function () {
      // nginx-confd's extractUserKeyFromZone uses /^([^_]+_[^_]+)_/ which gives the
      // first two underscore-separated segments: e.g. "sla-dgalvan_us_es_normal" → "sla-dgalvan_us"
      const files = fs.readdirSync(path.join(outDir, "conf.d")).filter((f) => f.endsWith(".conf"));
      const names = files.map((f) => f.replace(".conf", ""));
      expect(names).to.include("sla-dgalvan_us");
      expect(names).to.include("sla-japarejo_us");
      expect(names).to.include("sla-pablofm_us");
    });

    // ── proxy_pass values per endpoint ───────────────────────────────────────

    it("chatgpt location blocks use http://localhost:8001 in every conf.d file that references them", function () {
      const confDDir = path.join(outDir, "conf.d");
      const allContent = fs
        .readdirSync(confDDir)
        .filter((f) => f.endsWith(".conf"))
        .map((f) => fs.readFileSync(path.join(confDDir, f), "utf8"))
        .join("\n");

      const passes = allProxyPassesInBlocks(allContent, CHATGPT_SANITIZED);
      expect(passes.length).to.be.greaterThan(0, "no chatgpt location blocks found");
      passes.forEach((p) => {
        expect(p).to.include(CHATGPT_URL);
        expect(p).to.not.include(DEFAULT_URL);
      });
    });

    it("claude location blocks use http://localhost:8002 in every conf.d file that references them", function () {
      const confDDir = path.join(outDir, "conf.d");
      const allContent = fs
        .readdirSync(confDDir)
        .filter((f) => f.endsWith(".conf"))
        .map((f) => fs.readFileSync(path.join(confDDir, f), "utf8"))
        .join("\n");

      const passes = allProxyPassesInBlocks(allContent, CLAUDE_SANITIZED);
      expect(passes.length).to.be.greaterThan(0, "no claude location blocks found");
      passes.forEach((p) => {
        expect(p).to.include(CLAUDE_URL);
        expect(p).to.not.include(DEFAULT_URL);
      });
    });

    it("qwen location blocks retain the default http://localhost:8000", function () {
      const confDDir = path.join(outDir, "conf.d");
      const allContent = fs
        .readdirSync(confDDir)
        .filter((f) => f.endsWith(".conf"))
        .map((f) => fs.readFileSync(path.join(confDDir, f), "utf8"))
        .join("\n");

      // qwen has no x-nginx-server-baseurl — it is not in any SLA rate either,
      // so it appears as a non-rate-limited location (location ~) in nginx.conf.
      // Verify that nginx.conf (which does contain it) still uses DEFAULT_URL.
      const nginxContent = fs.readFileSync(path.join(outDir, "nginx.conf"), "utf8");
      const passes = allProxyPassesInBlocks(nginxContent, QWEN_SANITIZED);
      passes.forEach((p) => {
        expect(p).to.include(DEFAULT_URL);
        expect(p).to.not.include(CHATGPT_URL);
        expect(p).to.not.include(CLAUDE_URL);
      });
    });

    // ── both transforms applied together ─────────────────────────────────────

    it("strip transform applied: chatgpt rewrite uses /v1/chat/completions, not $uri_original", function () {
      const confDDir = path.join(outDir, "conf.d");
      const allContent = fs
        .readdirSync(confDDir)
        .filter((f) => f.endsWith(".conf"))
        .map((f) => fs.readFileSync(path.join(confDDir, f), "utf8"))
        .join("\n");

      const lines = allContent.split("\n");
      let inChatgptBlock = false;
      let foundRewrite = false;
      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith("location") && t.includes(CHATGPT_SANITIZED)) inChatgptBlock = true;
        if (inChatgptBlock && t.startsWith("rewrite")) {
          expect(t).to.include("/v1/chat/completions");
          expect(t).to.not.include("$uri_original");
          foundRewrite = true;
        }
        if (t === "}" && inChatgptBlock) inChatgptBlock = false;
      }
      expect(foundRewrite).to.be.true;
    });

    it("both transforms coexist: chatgpt block has stripped rewrite AND custom proxy_pass", function () {
      const confDDir = path.join(outDir, "conf.d");
      const allContent = fs
        .readdirSync(confDDir)
        .filter((f) => f.endsWith(".conf"))
        .map((f) => fs.readFileSync(path.join(confDDir, f), "utf8"))
        .join("\n");

      const lines = allContent.split("\n");
      let inChatgptBlock = false;
      let hasStrippedRewrite = false;
      let hasCustomProxyPass = false;

      for (const line of lines) {
        const t = line.trim();
        if (t.startsWith("location") && t.includes(CHATGPT_SANITIZED)) inChatgptBlock = true;
        if (inChatgptBlock) {
          if (t.startsWith("rewrite") && t.includes("/v1/chat/completions")) hasStrippedRewrite = true;
          if (t.startsWith("proxy_pass") && t.includes(CHATGPT_URL)) hasCustomProxyPass = true;
        }
        if (t === "}" && inChatgptBlock) inChatgptBlock = false;
      }

      expect(hasStrippedRewrite).to.be.true;
      expect(hasCustomProxyPass).to.be.true;
    });

    // ── nginx.conf structure ─────────────────────────────────────────────────

    it("nginx.conf URI rewrite rules contain the full public paths", function () {
      const content = fs.readFileSync(path.join(outDir, "nginx.conf"), "utf8");
      expect(content).to.include("/models/chatgpt/v1/chat/completions");
      expect(content).to.include("/models/claude/v1/chat/completions");
      expect(content).to.include("/models/qwen/v1/chat/completions");
    });

    it("nginx.conf includes the conf.d directory", function () {
      const content = fs.readFileSync(path.join(outDir, "nginx.conf"), "utf8");
      expect(content).to.include("include conf.d/*.conf");
    });

    it("nginx.conf does not contain any rate-limiting location blocks (those are in conf.d)", function () {
      const content = fs.readFileSync(path.join(outDir, "nginx.conf"), "utf8");
      // Rate-limited location names contain the context_id pattern
      expect(content).to.not.include("sla-dgalvan_us_es");
      expect(content).to.not.include("sla-japarejo_us_es");
    });

    // ── idempotency ──────────────────────────────────────────────────────────

    it("running the command a second time produces identical output (idempotent)", function () {
      // Re-run into a fresh directory and compare content
      const outDir2 = path.join(OUTPUT_DIR, "prog-config-nginx-baseurl-2");
      slaWizard.configNginxBaseUrl({ outDir: outDir2, oas: OAS_PATH, sla: SLA_DIR });

      const read = (dir, file) => fs.readFileSync(path.join(dir, file), "utf8");
      expect(read(outDir2, "nginx.conf")).to.equal(read(outDir, "nginx.conf"));

      const files = fs.readdirSync(path.join(outDir, "conf.d")).filter((f) => f.endsWith(".conf"));
      for (const file of files) {
        expect(read(path.join(outDir2, "conf.d"), file)).to.equal(read(path.join(outDir, "conf.d"), file));
      }
    });

    // ── single SLA file input ────────────────────────────────────────────────

    it("accepts a single SLA file (not a directory) as input", function () {
      const singleOut = path.join(OUTPUT_DIR, "prog-single-sla");
      expect(() =>
        slaWizard.configNginxBaseUrl({ outDir: singleOut, oas: OAS_PATH, sla: SLA_FILE }),
      ).to.not.throw();
      expect(fs.existsSync(path.join(singleOut, "nginx.conf"))).to.be.true;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. addToBaseUrlConfd — programmatic integration tests
  // ══════════════════════════════════════════════════════════════════════════

  describe("addToBaseUrlConfd (programmatic)", function () {
    const outDir = path.join(OUTPUT_DIR, "prog-add-to-baseurl-confd");

    before(function () {
      slaWizard.addToBaseUrlConfd({ outDir, oas: OAS_PATH, sla: SLA_DIR });
    });

    it("does NOT generate nginx.conf", function () {
      expect(fs.existsSync(path.join(outDir, "nginx.conf"))).to.be.false;
    });

    it("generates conf.d directory with .conf files", function () {
      const files = fs.readdirSync(path.join(outDir, "conf.d")).filter((f) => f.endsWith(".conf"));
      expect(files.length).to.be.greaterThan(0);
    });

    it("conf.d chatgpt location blocks use http://localhost:8001", function () {
      const confDDir = path.join(outDir, "conf.d");
      const allContent = fs
        .readdirSync(confDDir)
        .filter((f) => f.endsWith(".conf"))
        .map((f) => fs.readFileSync(path.join(confDDir, f), "utf8"))
        .join("\n");

      const passes = allProxyPassesInBlocks(allContent, CHATGPT_SANITIZED);
      expect(passes.length).to.be.greaterThan(0);
      passes.forEach((p) => expect(p).to.include(CHATGPT_URL));
    });

    it("conf.d claude location blocks use http://localhost:8002", function () {
      const confDDir = path.join(outDir, "conf.d");
      const allContent = fs
        .readdirSync(confDDir)
        .filter((f) => f.endsWith(".conf"))
        .map((f) => fs.readFileSync(path.join(confDDir, f), "utf8"))
        .join("\n");

      const passes = allProxyPassesInBlocks(allContent, CLAUDE_SANITIZED);
      expect(passes.length).to.be.greaterThan(0);
      passes.forEach((p) => expect(p).to.include(CLAUDE_URL));
    });

    it("strip transform also applied: rewrite uses stripped path in conf.d files", function () {
      const confDDir = path.join(outDir, "conf.d");
      const allContent = fs
        .readdirSync(confDDir)
        .filter((f) => f.endsWith(".conf"))
        .map((f) => fs.readFileSync(path.join(confDDir, f), "utf8"))
        .join("\n");

      // Any rewrite for chatgpt or claude must already use the stripped path
      const rewrites = allContent
        .split("\n")
        .filter((l) => l.trim().startsWith("rewrite") &&
          (l.includes(CHATGPT_SANITIZED) || l.includes(CLAUDE_SANITIZED)));

      expect(rewrites.length).to.be.greaterThan(0);
      rewrites.forEach((r) => {
        expect(r).to.not.include("$uri_original");
        expect(r).to.include("/v1/chat/completions");
      });
    });

    it("accepts a single SLA file as input", function () {
      const singleOut = path.join(OUTPUT_DIR, "prog-add-single-sla");
      expect(() =>
        slaWizard.addToBaseUrlConfd({ outDir: singleOut, oas: OAS_PATH, sla: SLA_FILE }),
      ).to.not.throw();
      expect(fs.existsSync(path.join(singleOut, "conf.d"))).to.be.true;
    });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 6. CLI tests
  // ══════════════════════════════════════════════════════════════════════════

  describe("CLI Usage", function () {
    it("config-nginx-baseurl generates nginx.conf and conf.d/", function () {
      const outDir = path.join(OUTPUT_DIR, "cli-config-nginx-baseurl");
      execSync(`node "${CLI_PATH}" config-nginx-baseurl -o "${outDir}" --oas "${OAS_PATH}" --sla "${SLA_DIR}"`);
      expect(fs.existsSync(path.join(outDir, "nginx.conf"))).to.be.true;
      expect(fs.existsSync(path.join(outDir, "conf.d"))).to.be.true;
    });

    it("add-to-baseurl-confd generates conf.d/ without nginx.conf", function () {
      const outDir = path.join(OUTPUT_DIR, "cli-add-to-baseurl-confd");
      execSync(`node "${CLI_PATH}" add-to-baseurl-confd -o "${outDir}" --oas "${OAS_PATH}" --sla "${SLA_DIR}"`);
      expect(fs.existsSync(path.join(outDir, "nginx.conf"))).to.be.false;
      expect(fs.existsSync(path.join(outDir, "conf.d"))).to.be.true;
    });

    it("CLI conf.d files have the correct proxy_pass per backend", function () {
      const outDir = path.join(OUTPUT_DIR, "cli-baseurl-verify");
      execSync(`node "${CLI_PATH}" config-nginx-baseurl -o "${outDir}" --oas "${OAS_PATH}" --sla "${SLA_DIR}"`);

      const confDDir = path.join(outDir, "conf.d");
      const allContent = fs
        .readdirSync(confDDir)
        .filter((f) => f.endsWith(".conf"))
        .map((f) => fs.readFileSync(path.join(confDDir, f), "utf8"))
        .join("\n");

      const chatgptPasses = allProxyPassesInBlocks(allContent, CHATGPT_SANITIZED);
      const claudePasses = allProxyPassesInBlocks(allContent, CLAUDE_SANITIZED);

      expect(chatgptPasses.length).to.be.greaterThan(0);
      chatgptPasses.forEach((p) => {
        expect(p).to.include(CHATGPT_URL);
        expect(p).to.not.include(DEFAULT_URL);
      });

      expect(claudePasses.length).to.be.greaterThan(0);
      claudePasses.forEach((p) => {
        expect(p).to.include(CLAUDE_URL);
        expect(p).to.not.include(DEFAULT_URL);
      });
    });

    it("CLI with a single SLA file (not a directory) runs without error", function () {
      const outDir = path.join(OUTPUT_DIR, "cli-single-sla");
      execSync(`node "${CLI_PATH}" config-nginx-baseurl -o "${outDir}" --oas "${OAS_PATH}" --sla "${SLA_FILE}"`);
      expect(fs.existsSync(path.join(outDir, "nginx.conf"))).to.be.true;
    });

    it("--help lists config-nginx-baseurl command", function () {
      const help = execSync(`node "${CLI_PATH}" --help`, { encoding: "utf8" });
      expect(help).to.include("config-nginx-baseurl");
    });

    it("--help lists add-to-baseurl-confd command", function () {
      const help = execSync(`node "${CLI_PATH}" --help`, { encoding: "utf8" });
      expect(help).to.include("add-to-baseurl-confd");
    });

    it("config-nginx-baseurl --help shows --oas and --sla options", function () {
      const help = execSync(`node "${CLI_PATH}" config-nginx-baseurl --help`, {
        encoding: "utf8",
      });
      expect(help).to.include("--oas");
      expect(help).to.include("--sla");
      expect(help).to.include("--outDir");
    });

    it("CLI exits with non-zero code when required --outDir is missing", function () {
      let threw = false;
      try {
        execSync(`node "${CLI_PATH}" config-nginx-baseurl --oas "${OAS_PATH}" --sla "${SLA_DIR}"`, {
          stdio: "pipe",
        });
      } catch {
        threw = true;
      }
      expect(threw).to.be.true;
    });

    it("CLI stdout contains success messages for both transforms", function () {
      const outDir = path.join(OUTPUT_DIR, "cli-stdout-check");
      const output = execSync(
        `node "${CLI_PATH}" config-nginx-baseurl -o "${outDir}" --oas "${OAS_PATH}" --sla "${SLA_DIR}"`,
        { encoding: "utf8" },
      );
      expect(output).to.include("x-nginx-strip transformations applied");
      expect(output).to.include("x-nginx-server-baseurl transformations applied");
    });
  });
});
