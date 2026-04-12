# sla-wizard-plugin-custom-baseUrl

A plugin for [SLA Wizard](../sla-wizard) and [sla-wizard-nginx-confd](../sla-wizard-nginx-confd) that adds support for the `x-nginx-server-baseurl` OAS extension.

When a path declares `x-nginx-server-baseurl`, nginx will proxy that endpoint to the **custom backend URL** instead of the global `servers[0].url`. Endpoints without the extension continue to use the global default.

```
Client → nginx:  POST /models/chatgpt/v1/chat/completions
nginx → backend: POST http://localhost:8001/v1/chat/completions   ← custom URL

Client → nginx:  POST /models/qwen/v1/chat/completions
nginx → backend: POST http://localhost:8000/v1/chat/completions   ← default URL
```

The plugin also inherits full `x-nginx-strip` support (via `sla-wizard-plugin-nginx-strip`), so you can freely combine both extensions on the same OAS path.

---

## How it works

### 1. Annotate your OAS with `x-nginx-server-baseurl`

Add the extension at the **path level** (not operation level):

```yaml
# oas.yaml
servers:
  - url: http://localhost:8000   # default for all endpoints

paths:
  /models/qwen/v1/chat/completions:
    post: ...                    # no extension → proxy_pass http://localhost:8000

  /models/chatgpt/v1/chat/completions:
    x-nginx-server-baseurl: http://localhost:8001   # overrides proxy_pass
    post: ...

  /models/claude/v1/chat/completions:
    x-nginx-server-baseurl: http://localhost:8002
    post: ...
```

### 2. Write your SLAs normally

```yaml
# sla.yaml
plan:
  name: normal
  rates:
    /models/chatgpt/v1/chat/completions:
      post:
        requests:
          - max: 5
            period: minute
```

If you combine this plugin with `x-nginx-strip`, your SLAs can reference the backend (stripped) path and the plugin handles the expansion automatically.

### 3. Run the plugin

The plugin generates nginx configuration where each location block uses the endpoint-specific `proxy_pass` target:

```nginx
# Without x-nginx-server-baseurl (standard output)
location /sla-alice_normal_modelschatgptv1chatcompletions_POST {
    rewrite /sla-alice_normal_modelschatgptv1chatcompletions_POST  $uri_original  break;
    proxy_pass http://localhost:8000;   ← same URL for every endpoint
    ...
}

# With x-nginx-server-baseurl applied
location /sla-alice_normal_modelschatgptv1chatcompletions_POST {
    rewrite /sla-alice_normal_modelschatgptv1chatcompletions_POST  $uri_original  break;
    proxy_pass http://localhost:8001;   ← custom URL for this endpoint only
    ...
}
```

---

## Installation

```bash
cd sla-wizard-plugin-custom-baseUrl
npm install
```

The plugin depends on `sla-wizard-plugin-nginx-strip` (bundled as a local dependency).

---

## Usage — CLI

Register the plugin in a CLI wrapper and invoke the commands.

### CLI wrapper (one-time setup)

```js
// my-cli.js
const slaWizard = require("sla-wizard");
const customBaseUrlPlugin = require("sla-wizard-plugin-custom-baseUrl");

slaWizard.use(customBaseUrlPlugin);
slaWizard.program.parse(process.argv);
```

### `config-nginx-baseurl` — full config (nginx.conf + conf.d/)

Generates the complete nginx configuration split into a main `nginx.conf` and
per-user `conf.d/` files:

```bash
node my-cli.js config-nginx-baseurl \
  -o ./nginx-output \
  --oas ./specs/oas.yaml \
  --sla ./specs/slas \
  --authName apikey \
  --proxyPort 80
```

Output:

```
nginx-output/
├── nginx.conf          ← server block + URI routing rules
└── conf.d/
    ├── sla-alice_us.conf
    ├── sla-bob_us.conf
    └── ...
```

Each `conf.d/` file contains the rate-limiting zones, API-key map, and location
blocks for one user. Location blocks for endpoints with `x-nginx-server-baseurl`
will have the custom URL in their `proxy_pass` directive.

### `add-to-baseurl-confd` — conf.d only (no nginx.conf overwrite)

Useful for adding a new user or plan without touching the main `nginx.conf`:

```bash
node my-cli.js add-to-baseurl-confd \
  -o ./nginx-output \
  --oas ./specs/oas.yaml \
  --sla ./specs/slas/sla_newuser.yaml
```

### CLI options

| Option | Description | Default |
|---|---|---|
| `-o, --outDir <dir>` | Output directory | **required** |
| `--oas <path>` | Path to OAS v3 file | `./specs/oas.yaml` |
| `--sla <path>` | Single SLA file, directory of SLAs, or URL | `./specs/sla.yaml` |
| `--authLocation <loc>` | Where to read the API key: `header`, `query`, `url` | `header` |
| `--authName <name>` | API key parameter name | `apikey` |
| `--proxyPort <port>` | Port nginx listens on | `80` |
| `--customTemplate <path>` | Custom nginx config template | — |

---

## Usage — Module (programmatic)

### Setup

```js
const slaWizard = require("sla-wizard");
const customBaseUrlPlugin = require("sla-wizard-plugin-custom-baseUrl");

slaWizard.use(customBaseUrlPlugin);
```

`slaWizard.use` registers the plugin and exposes its functions directly on the
`slaWizard` object, injecting the sla-wizard context automatically.

### `slaWizard.configNginxBaseUrl(options)` — full config

```js
slaWizard.configNginxBaseUrl({
  outDir: "./nginx-output",
  oas:    "./specs/oas.yaml",
  sla:    "./specs/slas",          // file, directory, or URL
  authLocation: "header",          // optional, default: "header"
  authName:     "apikey",          // optional, default: "apikey"
  proxyPort:    80,                 // optional, default: 80
});
```

### `slaWizard.addToBaseUrlConfd(options)` — conf.d only

Generates (or updates) only the `conf.d/` files without creating or overwriting
`nginx.conf`. Ideal for incremental user management:

```js
slaWizard.addToBaseUrlConfd({
  outDir: "./nginx-output",
  oas:    "./specs/oas.yaml",
  sla:    "./specs/slas/sla_newuser.yaml",
});
```

### Using individual exports directly

The plugin also exports lower-level functions that work **without sla-wizard
context** — useful when integrating into custom pipelines:

```js
const {
  applyBaseUrlToConfig,        // transform a raw config string
  applyBaseUrlTransformations, // transform all .conf files in an output directory
} = require("sla-wizard-plugin-custom-baseUrl");
```

#### `applyBaseUrlTransformations(outDir, oasPath)`

Reads the OAS from `oasPath`, then for every endpoint that declares
`x-nginx-server-baseurl`, rewrites every matching `proxy_pass` directive inside
`<outDir>/nginx.conf` and `<outDir>/conf.d/*.conf` — replacing the default
server URL with the endpoint-specific custom URL.

```js
const { applyBaseUrlTransformations } = require("sla-wizard-plugin-custom-baseUrl");

// After generating nginx config into outDir with any other tool...
applyBaseUrlTransformations("./nginx-output", "./specs/oas.yaml");
```

#### `applyBaseUrlToConfig(configContent, baseUrlMap, defaultUrl)`

Lower-level string transformation. Takes the raw config text, a map of
`sanitizedEndpoint → customUrl`, and the default URL to replace, and returns
the modified config string.

```js
const { applyBaseUrlToConfig } = require("sla-wizard-plugin-custom-baseUrl");

const modified = applyBaseUrlToConfig(nginxConfString, {
  modelschatgptv1chatcompletions: "http://localhost:8001",
  modelsclaudev1chatcompletions:  "http://localhost:8002",
}, "http://localhost:8000");
```

---

## Combining with `x-nginx-strip`

The plugin is built on top of `sla-wizard-plugin-nginx-strip`, so **both
extensions work together on the same OAS path**. When you annotate an endpoint
with both, nginx will:

1. Receive the full public path (e.g. `/models/chatgpt/v1/chat/completions`)
2. Forward the stripped backend path (e.g. `/v1/chat/completions`) — from `x-nginx-strip`
3. Send the request to the custom backend URL (e.g. `http://localhost:8001`) — from `x-nginx-server-baseurl`

```yaml
paths:
  /models/chatgpt/v1/chat/completions:
    x-nginx-strip: "/models/chatgpt"             # strip this prefix before forwarding
    x-nginx-server-baseurl: http://localhost:8001 # forward to this backend

  /models/claude/v1/chat/completions:
    x-nginx-strip: "/models/claude"
    x-nginx-server-baseurl: http://localhost:8002
```

When using `x-nginx-strip`, your SLAs can reference the backend (stripped) path
and the plugin expands them automatically:

```yaml
plan:
  rates:
    /v1/chat/completions:     # stripped path — expanded to all matching OAS paths
      post:
        requests:
          - max: 10
            period: minute
```

---

## Complete example

### OAS (`oas.yaml`)

```yaml
openapi: 3.0.3
info:
  title: LLM Gateway API
  version: 1.0.0
servers:
  - url: http://localhost:8000   # default backend

paths:
  /models/qwen/v1/chat/completions:
    post:
      summary: Qwen completions
      operationId: postQwenCompletion
      responses:
        "200":
          description: OK

  /models/chatgpt/v1/chat/completions:
    x-nginx-server-baseurl: http://localhost:8001
    post:
      summary: ChatGPT completions
      operationId: postChatGPTCompletion
      responses:
        "200":
          description: OK

  /models/claude/v1/chat/completions:
    x-nginx-server-baseurl: http://localhost:8002
    post:
      summary: Claude completions
      operationId: postClaudeCompletion
      responses:
        "200":
          description: OK
```

### SLA (`sla.yaml`)

```yaml
sla4oas: 1.0.0
context:
  id: sla-alice
  type: agreement
  api:
    $ref: ./oas.yaml
  apikeys:
    - my-secret-key-abc123
plan:
  name: standard
  rates:
    /models/chatgpt/v1/chat/completions:
      post:
        requests:
          - max: 10
            period: minute
    /models/claude/v1/chat/completions:
      post:
        requests:
          - max: 10
            period: minute
```

### Generate config (programmatic)

```js
const slaWizard = require("sla-wizard");
const customBaseUrlPlugin = require("sla-wizard-plugin-custom-baseUrl");

slaWizard.use(customBaseUrlPlugin);

slaWizard.configNginxBaseUrl({
  outDir: "./nginx-output",
  oas:    "./oas.yaml",
  sla:    "./sla.yaml",
});
```

### Generated `conf.d/sla-alice_standard.conf` (excerpt)

```nginx
# Rate limiting zones
limit_req_zone $http_apikey zone=sla-alice_standard_modelschatgptv1chatcompletions_POST:10m rate=10r/m;
limit_req_zone $http_apikey zone=sla-alice_standard_modelsclaudev1chatcompletions_POST:10m rate=10r/m;

# Endpoint locations
location /sla-alice_standard_modelschatgptv1chatcompletions_POST {
    rewrite /sla-alice_standard_modelschatgptv1chatcompletions_POST  $uri_original  break;
    proxy_pass http://localhost:8001;   ← chatgpt backend
    limit_req zone=sla-alice_standard_modelschatgptv1chatcompletions_POST burst=9 nodelay;
}

location /sla-alice_standard_modelsclaudev1chatcompletions_POST {
    rewrite /sla-alice_standard_modelsclaudev1chatcompletions_POST  $uri_original  break;
    proxy_pass http://localhost:8002;   ← claude backend
    limit_req zone=sla-alice_standard_modelsclaudev1chatcompletions_POST burst=9 nodelay;
}
```

The qwen endpoint has no `x-nginx-server-baseurl`, so its location block (in
`nginx.conf`) keeps `proxy_pass http://localhost:8000`.

---

## Running the tests

```bash
npm test
```

The test suite covers:

- **Unit** — `applyBaseUrlToConfig`: replacement, non-replacement, edge cases (empty input, no location blocks, block without `proxy_pass`, indentation preservation, partial-URL guard)
- **Unit** — `applyBaseUrlTransformations`: file I/O, no-op when no extension present, graceful handling of missing files/directories
- **Integration** — `configNginxBaseUrl` and `addToBaseUrlConfd`: correct output structure, proxy_pass values per endpoint, both strip and baseurl transforms coexisting, idempotency, single-file SLA input
- **CLI** — both commands, `--help` output, missing required argument, single-file SLA input, stdout success messages

---

## License

Apache License 2.0 — same as SLA Wizard.
