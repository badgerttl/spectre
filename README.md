# Spectre Security Toolkit

<p align="center">
  <img src="assets/icons/icon-128.png" width="128" height="128"
       alt="Spectre Security Toolkit icon">
</p>

Spectre is a Chrome/Chromium Manifest V3 side-panel extension for authorised web
application security testing. It keeps inspection and transformation tools close
to the target tab and scopes identity changes to the selected HTTP(S) origin.

## Features

- View, create, edit, and delete cookies, including `HttpOnly`, `Secure`,
  `SameSite`, session, and expiry attributes. JWT-valued cookies are highlighted
  and prioritised at the top of the list. Clear every cookie currently
  applicable to the active target in one action.
- View and modify `localStorage` and `sessionStorage` in editable Pretty mode by
  default, with a Raw toggle. JSON, URL/Base64-encoded JSON, JWTs, and form/query
  values are serialised back to their original representation when saved.
- JWT-valued Web Storage records are highlighted. Right-click any cookie or
  Web Storage row to send its complete value to Base64 or URL Encode/Decode;
  detected JWTs also provide a direct **Send to JWT Workbench** action.
- Identify common hash formats and ambiguous raw digest lengths.
- Encode/decode Unicode Base64, Base64URL, and URL components.
- Clear Base64 and URL transform input/output with a single action.
- Select text on a page and use **Send selection to Spectre** from the context
  menu to run Base64 Encode/Decode or URL Encode/Decode directly in the side
  panel. Inside Spectre itself, right-click selected document, input, or textarea
  text to open the same four Transform actions in an in-panel menu.
- Convert epoch seconds/milliseconds to ISO and local time, and back.
- Analyse JWT headers and claims in an editable workbench, flag expiry and
  not-before conditions, rebuild unsigned tokens, and verify or sign HS256,
  HS384, and HS512 tokens with a non-persisted HMAC secret.
- Save multiple named HTTP, HTTPS, SOCKS4, or SOCKS5 proxy profiles with
  optional credentials and bypass rules. Per-profile switches make one profile
  active at a time; configuration fields appear only for New or Edit. Proxy
  endpoints accept a hostname, `host:port`, or a complete proxy URL, and
  activation verifies Chrome's effective proxy setting.
- Save multiple User-Agent profiles and custom request headers using Manifest V3
  dynamic network rules. User-Agents are mutually exclusive; any number of
  headers can be enabled together. Both use compact toggle/Edit rows with hidden
  editors, and the User-Agent editor includes common desktop, mobile, crawler,
  and CLI presets alongside a free-form value.
- Save and switch scoped roles using Bearer tokens, Basic auth, a cookie, or a
  custom header. Each role can target an exact origin, a configured domain
  and its subdomains, or every HTTP(S) destination. Roles use mutually exclusive
  per-row switches and keep their configuration hidden until New or Edit.
- See the active role, proxy, and request-mutation state in a persistent status
  strip from every tool panel.
- Right-click the pinned Spectre toolbar icon to switch Proxy, User-Agent, or
  Role profiles and independently enable or disable saved custom Headers.
- Pop Spectre out of the browser side panel into a dedicated resizable window,
  then return it to the original browser window. The detached view continues to
  target the original window's active tab.
- Choose Compact, Standard, Large, or Extra large text. The choice is saved across sessions and shared by the side panel and detached window.
- Choose from Spectre, Cobalt, Violet, Ember, Falcon, and Light colour schemes. Falcon uses a terminal palette with monospace text and square controls.
- Confirm cookie, storage, profile, proxy, header, and role deletion through a
  Spectre-styled in-app dialog instead of a browser prompt.
- Search and copy 210 non-destructive probes across 25 categories, including
  XSS, SQLi, SSTI, traversal/LFI, SSRF, command injection, API, authentication,
  parser, upload, header, and client-side testing.

## Editing and portable profiles

Editors warn before switching sections, selecting another record, closing an
editor, or changing targets with unsaved form changes. Cancel returns to the
form so you can save. Closing or reloading the panel also requests confirmation
when there are unsaved changes.

JWT **Verify or sign** tools and proxy **Advanced settings** start collapsed.
Open them when you need HMAC operations, proxy credentials, or bypass rules.

Use **Expand** below a text area for a larger editor. **Apply** returns the text
to the original field; save that form to commit it. Cancel leaves the original
value intact.

In Payloads, open **Add custom payload** to save a category, probe, and note.
Custom entries support search, favorites, copying, and deletion.

Open **Profile export and import** at the bottom of the panel to download or
import JSON. Exports contain roles, proxies, User-Agents, headers, custom
payloads, and favorites. Credential and header values are excluded unless
**Include credentials and header values** is selected. Custom payload text is
always included. Imported profiles with existing names are skipped; new controls
remain disabled. Invalid imports are rejected before any profiles are saved.

## Emergency reset

**Emergency reset** restores the role cookie, clears the active role, disables
custom headers and User-Agent changes, removes Spectre's request rules, and
restores direct connection mode. Saved profiles remain available. The result
lists any failed steps so you can resolve the problem and retry.

## Target, undo, and favorites

Spectre pins the selected target tab by default and displays its title and origin.
If the pinned tab closes, Spectre asks you to select another target. Use **Use current tab** to select
another target, or toggle **Pin target** off to follow active tabs. The pin preference
is saved, and the target is retained for the browser session, including when
switching between the side panel and detached window.

**Undo last edit** restores the most recent cookie or Web Storage save, deletion,
or clear performed in the open panel. Undo history stays in memory and is lost
when the panel closes or reloads. It checks for newer record values before
restoring, preserves unrelated changes, and refuses storage restoration if the
target tab has moved to another origin. Undo restores stored values; it cannot
reverse server-side effects such as a session being invalidated.

Use **Favorite** on a payload to save it, then enable **Favorites only** to filter
the library. Favorites are saved in this browser profile and work with search,
category selection, and **Copy all raw**.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose this repository directory.
5. Pin Spectre, browse to an authorised target, and click the Spectre toolbar
   icon to open the side panel.

After changing source files, select **Reload** on the extension card.

## Security model

- The broad host permission is required for user-selected tab storage/cookie
  inspection and for user-configured request rules.
- Network controls default to the current origin. The all-sites scope must be
  selected explicitly.
- Proxy settings affect the complete regular browser profile because Chrome's
  proxy API is profile-wide.
- Role activation is session-scoped and cleared at browser restart.
- Cookie role switching temporarily writes the selected cookie. Spectre backs up
  the previous value, restores it on deactivation/switch/restart, and removes the
  local backup after restoration.
- Role and proxy secrets are stored in `chrome.storage.local` in the browser
  profile. Use a dedicated testing profile and do not store production secrets.
- The extension contains no remote code, telemetry, or external dependencies.

## Development

Requires a current Node.js release only for validation:

```sh
npm run validate
```

The extension itself has no build step or package dependencies.

## Release packaging

Run validation, smoke-test the unpacked extension, and package only runtime
files:

```sh
npm run validate
zip -r spectre-v0.15.2.zip manifest.json sidepanel.html src styles assets
```

The repository intentionally has no licence yet. Add the licence appropriate to
your intended distribution before publishing the project publicly.

## Browser support

Chrome/Chromium 116 or later is required. This project
targets Chrome's Manifest V3 APIs; Firefox is not currently supported.

Use only against systems covered by your rules of engagement.
