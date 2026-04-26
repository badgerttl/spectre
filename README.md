# Spectre

Browser extension (Manifest V3) for **security testing** from the current tab: cookies, web storage, JWT tooling, light recon, header/cookie/UA/proxy control, and small utilities. Open the popup from the toolbar icon; most actions apply to the **active tab** (must be a normal `http`/`https` page when page context is required).

---

## Quick start

1. In Chrome: `chrome://extensions` → **Developer mode** → **Load unpacked** → select this project folder.
2. Pin the Spectre icon if you want. Optional: add `devtools/devtools.html` under **Chrome DevTools** as a `devtools_page` in `manifest.json` if you want a DevTools panel (not enabled by default).

---

## Tab: Cookies

| Feature | What it does |
|--------|----------------|
| **Refresh** | Reloads cookies for the current site from the browser’s cookie store. |
| **Add** | Opens a form to set a new cookie (name, value, domain, path, expiry, SameSite, HttpOnly, Secure). |
| **Clear** | Deletes **all** cookies for the current site (with confirmation). |
| **Filter** | Live text filter on cookie name and value. |
| **List** | One row per cookie: name, value (word-wrapped; **JSON values are pretty-printed** when the value is valid JSON). **JWT**-shaped values are moved to the top and highlighted. **Edit · Delete · Copy · JWT** (JWT only) per row. |
| **JWT** | Sends the cookie’s value to the **JWT** tab to decode/forge. |

The cookie list **refreshes when you switch to the Cookies tab** so it stays in sync with navigation.

---

## Tab: Storage

| Feature | What it does |
|--------|----------------|
| **localStorage / sessionStorage** | Switch below the toolbar; each side shows **only that namespace** for the current origin. The active type **refreshes when you open Storage** or change the switch. |
| **Refresh / Add / Clear** | Manages entries for the selected namespace. **Clear** wipes that namespace. |
| **Filter** | Live filter on key and value text. |
| **Entries** | **Key** and **Value** stacked; long **JSON strings are pretty-printed**; long values can **collapse/expand** with a control. **Edit · Delete · Copy** (no click-to-edit). |

 Reads run in the **page** via the scripting API (no `eval`), so it works on strict CSP pages (e.g. GitHub).

---

## Tab: JWT

| Feature | What it does |
|--------|----------------|
| **Decode** | Splits a pasted JWT, shows **header** and **payload** as editable JSON. |
| **Sign / Forge** | **HS256** with a secret, or **none** / casing variants of “none” (algorithm confusion tests); builds a new token in **Output token**. |
| **Verify** | HMAC **HS256** verify using the **Secret** field and the output or input token. |
| **Copy / Use as Input** | Copy forged token, or copy output back to the top input. |
| **Send back to Cookie** | After sending a value from a JWT cookie row, this writes the **Output token** back to **that** cookie. |

The header/payload area uses a resizable two-column layout.

---

## Tab: Recon

All recon runs append **new** sections to the same scrollable **output** (newest on top). Use **Clear** to wipe the output.

| Button | What it does |
|--------|----------------|
| **Forms &amp; Inputs** | Lists every **&lt;form&gt;** on the page: method, `action`, `id`, and for each `input` / `select` / `textarea`: type, `name`, `id`, value (passwords **masked** as `***`), placeholder. |
| **Spider Links** | Collects **unique** absolute URLs from: `a[href]`, `form[action]`, `script[src]`, `link[href]`, `iframe[src]`, `img[src]` (skips `data:`). Groups URLs **by hostname**. Shows **up to 40** URLs per host first; if there are more, **“+N more (expand)”** opens the rest in place. |
| **Tech Stack** | **Heuristic, client-only** checks: global objects (React, `__NEXT_DATA__`, Vue, Angular, jQuery, axios, etc.), `meta name="generator"`, and a few tag/class heuristics (Tailwind, Bootstrap, WordPress links, etc.). **Not a full scanner**—false positives/negatives are possible. |
| **Hidden Fields** | Every `input type="hidden"`: `name`, `id`, `value`, and a short note for **which form** (id, action, or “no form”). |
| **Source Scan** | Fetches the **current document URL in the background** (unauthenticated) and inspects the **raw HTML/JS** for: (1) **path-shaped strings** (regex tuned for paths like `/api/…`, `/v1/…`, `graphql`, `admin`, etc.), (2) **HTML comments** (first 20, each trimmed to 300 chars), (3) **`script src` URLs** (first 30). Respects the same **Clear** / append behavior. Fails for strict cross-origin/403 pages—**no JS execution** on the fetched body. |

---

## Tab: Inject

### Role Switcher

Save **named roles** and apply them to send **auth to matching requests** (or set a cookie) on a **chosen scope**.

- **Types**: **Bearer** (`Authorization: Bearer …`), **Basic** (`Authorization: Basic …`), **Custom header** (you supply header name and full value), **Cookie** (sets a **named** cookie; applying **replaces** same-name cookies for the page first so you don’t get duplicates).
- **Domain scope**: Optional; blank means **current tab’s host**. “**Include subdomains**” is stored; rules use the Chrome `requestDomains` model for **header** injection. Cookie use uses your domain and the current scheme.
- **Apply / Eject** | **Eject** clears the **session** header-injection rule. **Edit / Delete / Update** | Saved roles are listed with scope; the **right-click** menu (see below) can apply them too. **Active** state is **remembered** (highlighted in the list).

Header injection uses **`declarativeNetRequest`** in the service worker (not page script), so it survives navigation and is visible in network tools as modified outgoing requests (subject to browser behavior).

### User-Agent Switcher

**Presets** (desktop and mobile) or a **custom** string. **Apply** / **Reset**; you can also save named UA profiles (**Save UA Profile**, then **Apply/Delete** from the list). Active UA is **persisted** and implemented via the same DNR “modify `User-Agent`” pattern as the rest of the tool.

### IDOR Tester

Fires requests from the **extension** (not the page) to a **URL template** with `{ID}` replaced by a numeric range. Shows status code, length, and a short body snippet. **Run** / **Stop**. Optional **JSON headers** and **body**. Used to probe ID enumeration-style endpoints **on targets you are allowed to test**.

---

## Tab: Proxy

**Chrome-wide** proxy (with `proxy` permission): the setting applies to the browser’s proxy configuration as configured, not per-tab in isolation.

- **Quick Switch**: **Direct** (no proxy), **System**, **Burp** (127.0.0.1:8080).
- **Profiles**: Save **HTTP/HTTPS/SOCKS** host/port; optional **include** / **exclude** host **patterns** (comma-separated; used in a **PAC** script when at least one pattern is set, otherwise a simple fixed single proxy). **Apply** / **Delete** saved profiles; mode is **remembered**. Status text reflects the current mode. Right-click proxy menu includes the same presets and now lists saved custom profiles with checkmarks for the active one.

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

**Encode ↓** / **Decode ↑** / **Swap** / **Copy output** / **Clear**.

### Hash

**Identify hash** (length + charset heuristics) or compute **MD5, SHA-1, SHA-256, SHA-384, SHA-512** in the client.

---

## Extension icon: right-click (context) menu

Right-click the **toolbar icon** (not the page). Items are checkboxes where noted so you can see what’s **active**.

| Menu | What it does |
|------|----------------|
| **Spectre Proxy** | **Direct** · **System** · **Burp** + saved custom profiles (checkboxes show the current active preset/profile). |
| **Spectre User-Agent** | **Default (browser)** + built-in UA presets + saved custom UAs (checkboxes show the active UA). |
| **Spectre Roles** | (If you have saved roles) One entry per **saved** role: applies that role. **Eject** clears header auth. Checkmarks show the **active** role. |
| **Clear Cookies (current site)** | Removes all cookies the extension can remove for the **active tab** URL. |

---

## Misc

- **Toasts** bottom-right for success/warning/error.  
- **Cookie / storage modals** are outside the main popup scroll area so they aren’t clipped.  
- This README reflects the **in-repo** build; the folder name on disk may still be `offsec` without affecting the public **Spectre** name in `manifest.json`.

### Permissions (why they exist)

| Permission | Use |
|------------|-----|
| `cookies` | List/set/remove cookies, clear-by-site. |
| `storage` + `tabs` + `activeTab` + `scripting` | Tab URL, inject scripts for storage/recon, `chrome.storage` for settings. |
| `declarativeNetRequest` (+ feedback) | Modify **Authorization** (and custom) headers, **User-Agent**; needs rules, not `webRequest` blocking. |
| `proxy` | Global proxy and PAC. |
| `contextMenus` | Icon right-click menu. |
| `debugger` | Declared in manifest (reserved for possible tooling); primary flows above use DNR and scripting. |
| `<all_urls>` | Match requests/URLs across http(s) for rules and fetches. |

Use Spectre **only** on systems and applications you are **authorized** to test.
