# Spectre

Browser extension (Manifest V3) for **security testing** from the current tab: cookies, web storage, JWT tooling, recon, GraphQL exploration, header/cookie/UA/proxy control, and small utilities. Open the resizable Chrome side panel from the toolbar icon; most actions apply to the **active tab** (must be a normal `http`/`https` page when page context is required).

---

## Quick start

1. In Chrome: `chrome://extensions` → **Developer mode** → **Load unpacked** → select this project folder.
2. Pin the Spectre icon if you want.

---

## Tab: Recon

Runs recon checks and renders results in ordered sections. **Run All** executes every check in sequence. Each section has its own **Run**, **Collapse/Expand**, and **Copy** buttons. Use **Clear** to wipe all output.

Toolbar: **Run All · Copy All · Export MD · Export JSON · Collapse All · Clear**

| Section | What it does |
|---------|----------------|
| **Tech Stack** | Heuristic, client-only checks: global objects (React, `__NEXT_DATA__`, Vue, Angular, jQuery, axios, etc.), `meta[name=generator]`, tag/class heuristics (Tailwind, Bootstrap, WordPress). Not a full scanner. |
| **Source Scan** | Fetches the current document URL in the background and inspects raw source for API paths, comments, and script URLs. |
| **Source Maps** | Checks up to 30 external scripts for `//# sourceMappingURL=` comments and probes `{file}.map`; flags HTTP 200 responses as **EXPOSED** (high severity). |
| **Discovered Links & Assets** | Collects unique URLs from the live DOM, fetched page source, and external JS bundles. Groups by hostname, shows where each was found (DOM, page source line, JS file line). Can send a URL to **Dispatch**. |
| **robots.txt / Sitemap** | Fetches `/robots.txt` and `/sitemap.xml`. Flags interesting Disallow paths (admin, backup, `.git`, `.env`, etc.) and lists all sitemap URLs. |
| **Open Redirect Params** | Scans DOM links and discovered URLs for redirect-style params (`redirect`, `next`, `url`, `goto`, `return_to`, etc.) with URL-like values. |
| **Header Audit** | Fetches the current URL and reports response headers plus security-header issues: HSTS, CSP, clickjacking controls, `nosniff`, referrer policy, permissions policy, CORS, exposed server headers. |
| **CSP Analysis** | Deep CSP parse: `unsafe-inline`, `unsafe-eval`, wildcards, `data:`, `http:`, missing `object-src` / `base-uri` / `form-action`, known JSONP/bypass-prone CDN hosts (googleapis, jsdelivr, unpkg, etc.). Reports positive signals (nonces, hashes, `upgrade-insecure-requests`). |
| **Forms** | Lists every `<form>`: method, `action`, `id`, and for each `input` / `select` / `textarea`: type, `name`, `id`, value (passwords masked as `***`), placeholder. |
| **Hidden Fields** | Every `input[type=hidden]`: `name`, `id`, `value`, and which form it belongs to. |
| **DOM XSS** | Passive DOM-sink analysis: tracks tainted sources to dangerous sinks. Shows hot (source→sink) and cold (sink-only) findings with file/line. |
| **Reflected Params** | Passive check: fetches page source and tests if current URL param values appear raw (unencoded) in HTML. Flags script-context occurrences as high, HTML-context as medium. |
| **Secrets & Sensitive Data** | Scans page source for JWTs, Bearer tokens, AWS keys, GitHub tokens, Google API keys, Stripe keys, Slack tokens, private keys, passwords, MongoDB URIs, and more. |
| **Storage Scan** | Inspects `localStorage` and `sessionStorage` for the same sensitive-data patterns as the Source scan. |

**Export MD / Export JSON** saves current output with URL and timestamp.

---

## Tab: GraphQL

| Feature | What it does |
|---------|----------------|
| **Detect Endpoints** | Scans the current page source and network patterns for GraphQL endpoint candidates. |
| **Introspect** | Runs an introspection query against the selected/entered endpoint URL. Renders a searchable schema browser (types, fields, queries, mutations). |
| **Bypass techniques** | If introspection is blocked, tries common bypasses (GET method, field-suggestion probes, alias tricks, etc.). |
| **Schema search** | Live filter across all types and fields in the introspected schema. |
| **Send to Dispatch** | Sends discovered endpoints or schema-generated queries to the Dispatch tab. |

---

## Tab: Cookies

| Feature | What it does |
|---------|----------------|
| **Refresh** | Reloads cookies for the current site from the browser's cookie store. |
| **Add** | Opens a form to set a new cookie (name, value, domain, path, expiry, SameSite, HttpOnly, Secure). |
| **Clear** | Deletes **all** cookies for the current site (with confirmation). |
| **Filter** | Live text filter on cookie name and value. |
| **List** | One row per cookie: name, value (word-wrapped; **JSON values are pretty-printed**). **JWT**-shaped values are moved to the top and highlighted. **Edit · Delete · Copy · JWT** (JWT only) per row. |
| **JWT** | Sends the cookie's value to the **JWT** tab to decode/forge. |

The cookie list **refreshes when you switch to the Cookies tab**.

---

## Tab: Storage

| Feature | What it does |
|---------|----------------|
| **localStorage / sessionStorage** | Switch below the toolbar; each side shows only that namespace for the current origin. |
| **Refresh / Add / Clear** | Manages entries for the selected namespace. **Clear** wipes that namespace. |
| **Filter** | Live filter on key and value text. |
| **Entries** | Key and Value stacked; long **JSON strings are pretty-printed**; long values collapse/expand. **Edit · Delete · Copy**. |

Reads run in the **page** via the scripting API (no `eval`), so it works on strict CSP pages.

---

## Tab: JWT

| Feature | What it does |
|---------|----------------|
| **Decode** | Splits a pasted JWT, shows **header** and **payload** as editable JSON. |
| **Sign / Forge** | **HS256 / HS384 / HS512** with a secret, or **none** / casing variants (`None`, `NONE`, `nOnE`, `NoNe`, `nonE`) for algorithm confusion tests. |
| **Verify** | HMAC verify (HS256/HS384/HS512) using the Secret field against the output or input token. |
| **Attack Builder** | Generates attack tokens for **alg-none variants** or **kid path traversal** (custom `kid` value + optional signing material). |
| **Copy / Use as Input** | Copy forged token, or push output back to the input field. |
| **Send back to Cookie** | After sending a value from a JWT cookie row, writes the **Output token** back to that cookie. |
| **Walkthroughs** | In-panel step-by-step guides for: none-alg, RS256→HS256 confusion, embedded JWK, JKU spoofing, kid traversal, algorithm confusion, JWKS injection, and more. |

---

## Tab: Dispatch

Send arbitrary HTTP requests from the extension background (bypasses CORS, carries extension cookies).

| Feature | What it does |
|---------|----------------|
| **Request editor** | Edit method (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS), URL, headers (one per line), and body. |
| **Import curl** | Paste a `curl` command; Dispatch parses and loads the method, URL, headers, and body. |
| **Send** | Fires the request from the service worker. |
| **Response viewer** | Shows status badge, response headers, body preview, and total response length. |
| **Copy curl** | Copies the current request as a `curl` command. |
| **Load URL** | Seeds the request URL from the active tab. |

---

## Tab: Payloads

| Feature | What it does |
|---------|----------------|
| **Built-in groups** | XSS, SQLi, SSTI, path traversal, command injection, open redirect, XXE, SSRF, GraphQL (POST and GET), and more. |
| **Search** | Live filter across all payload groups and values. |
| **Add to groups** | Add payloads to existing built-in groups; reorder by dragging rows. Added payloads can be deleted. |
| **Custom groups** | Create, edit, delete, and persist standalone custom payload groups. |
| **Copy actions** | Per-payload copy (raw and URL-encoded). |
| **Send** | Send a payload to Encode / Decode. |

---

## Tab: Tools

### Encode / Decode

| Mode | What it does |
|------|----------------|
| **Base64 / Base64URL** | Standard encode and decode. |
| **URL encode / full** | `encodeURIComponent` vs. percent-encode every byte. |
| **HTML entities** | Escape / unescape common entities. |
| **Hex** | Text ↔ hex string. |
| **Unicode escape** | `\uXXXX` style. |

**Encode · Decode · Swap · Copy Output · Clear**

### Hash

**Identify hash** (length + charset heuristics) or compute **MD5, SHA-1, SHA-256, SHA-384, SHA-512** in the client.

### Timestamp

Parse a Unix timestamp (seconds or milliseconds) or date string and display it in multiple formats. **Now** fills the current time.

### Diff

Side-by-side text diff of two inputs (A and B). **Auto JSON** pretty-prints valid JSON before diffing. Shows added/removed line counts.

---

## Tab: Profiles

Manages persistent configuration for proxy, user-agent, role auth, and header injection. An **active-dot indicator** on the nav icon shows when any profile is applied. **Export All / Import JSON** for backup and restore.

Jump navigation: **Proxy · User-Agent · Role Switcher · Header Injection**

### Proxy

**Chrome-wide** proxy (with `proxy` permission): applies to the whole browser, not per-tab.

- **Quick Switch**: **Direct** (no proxy) · **System** · **Burp Suite** (127.0.0.1:8080).
- **Profiles**: Save HTTP / HTTPS / SOCKS4 / SOCKS5 host + port with optional include / exclude host patterns (comma-separated). When patterns are set a PAC script is generated; otherwise a simple fixed-proxy config is used. **Apply / Delete** saved profiles.

### User-Agent Switcher

**Presets** (desktop and mobile across Chrome, Firefox, Safari, Edge, curl, iOS, Android, Samsung Browser) or a **custom** string. **Apply / Reset to Default**. Save named UA profiles; apply or delete from the saved list. Active UA is persisted via DNR.

### Role Switcher

Save named roles and inject auth into matching requests (or set a cookie).

- **Types**: **Bearer** (`Authorization: Bearer …`), **Basic** (`Authorization: Basic …`), **Custom header** (supply header name and value), **Cookie** (sets a named cookie; replaces same-name cookies for the page to avoid duplicates).
- **Domain scope**: Blank = current tab's host. "Include subdomains" stored per role. Header injection uses `declarativeNetRequest` session rules in the service worker, so it survives navigation.
- **Apply / Eject · Edit / Delete / Update**. Active role highlighted in the list and visible in the context menu.

### Header Injection

Save multi-header profiles (arbitrary name/value pairs) and inject them into all requests on a domain. **Apply** activates via DNR session rules; **Eject Active Injection** clears the rule.

---

## Extension icon: right-click (context) menu

Right-click the **toolbar icon** (not the page). Checkmarks show the currently active item.

| Menu | What it does |
|------|----------------|
| **Spectre Proxy** | Direct · System · Burp Suite + saved custom profiles. |
| **Spectre User-Agent** | Default (browser) + built-in UA presets + saved custom UAs. |
| **Spectre Roles** | One entry per saved role: applies that role. **Eject** clears header auth. |
| **Clear Cookies (current site)** | Removes all cookies the extension can access for the active tab URL. |

---

## Misc

- **Toasts** bottom-right for success / warning / error.
- Cookie and storage modals are outside the main panel scroll area so they aren't clipped.

### Permissions (why they exist)

| Permission | Use |
|------------|-----|
| `cookies` | List / set / remove cookies, clear-by-site. |
| `storage` + `tabs` + `activeTab` + `scripting` | Tab URL, inject scripts for storage/recon, `chrome.storage` for settings. |
| `declarativeNetRequest` (+ feedback) | Modify headers (auth, UA, custom) via DNR session rules in the service worker. |
| `proxy` | Chrome-wide proxy and PAC. |
| `contextMenus` | Icon right-click menu. |
| `debugger` | Declared in manifest; reserved for possible future tooling. |
| `sidePanel` | Chrome side panel API. |
| `<all_urls>` | Match requests/URLs across http(s) for rules and fetches. |

Use Spectre **only** on systems and applications you are **authorized** to test.
