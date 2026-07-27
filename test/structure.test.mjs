import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("manifest entry points exist and side-panel IDs are unique", async () => {
  const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const html = await readFile(new URL("../sidepanel.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles/sidepanel.css", import.meta.url), "utf8");
  const sidepanelScript = await readFile(new URL("../src/sidepanel.mjs", import.meta.url), "utf8");
  const backgroundScript = await readFile(new URL("../src/background.mjs", import.meta.url), "utf8");

  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.equal(manifest.version, packageJson.version, "manifest and package versions must match");
  assert.ok(manifest.permissions.includes("contextMenus"));
  assert.ok(Number(manifest.minimum_chrome_version) >= 116);

  assert.deepEqual(Object.keys(manifest.icons), ["16", "32", "48", "128"]);
  assert.deepEqual(Object.keys(manifest.action.default_icon), ["16", "32", "48"]);
  assert.ok(
    Object.values(manifest.action.default_icon).every((iconPath) => iconPath.includes("toolbar-")),
    "toolbar action must use the compact icon set"
  );
  const iconPaths = new Set([
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon)
  ]);
  for (const iconPath of iconPaths) {
    const icon = await readFile(new URL(`../${iconPath}`, import.meta.url));
    assert.ok(icon.length > 0, `${iconPath} is empty`);
    assert.deepEqual(
      [...icon.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
      `${iconPath} must be a PNG`
    );
  }

  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "side-panel element IDs must be unique");

  for (const theme of ["spectre", "cobalt", "violet", "ember", "light"]) {
    assert.match(html, new RegExp(`value="${theme}"`));
    if (theme !== "spectre") assert.match(css, new RegExp(`data-theme="${theme}"`));
  }

  for (const statusId of ["status-role-value", "status-proxy-value", "status-network-value"]) {
    assert.ok(ids.includes(statusId), `${statusId} is missing`);
  }
  assert.ok(ids.includes("surface-toggle"), "pop-out/return control is missing");
  assert.match(sidepanelScript, /sidepanel\.html\?mode=popup/);
  assert.match(sidepanelScript, /chrome\.windows\.create/);
  assert.match(sidepanelScript, /chrome\.sidePanel\.open/);
  assert.match(sidepanelScript, /window\.close\(\)/);
  assert.match(sidepanelScript, /\{\s*active:\s*true,\s*windowId:\s*dockWindowId\s*\}/);
  for (const id of [
    "panel-jwt",
    "jwt-input",
    "jwt-analysis",
    "jwt-header",
    "jwt-claims",
    "jwt-rebuild-unsigned",
    "jwt-secret",
    "jwt-verify",
    "jwt-sign",
    "jwt-result"
  ]) {
    assert.ok(ids.includes(id), `${id} JWT workbench control is missing`);
  }
  assert.match(css, /grid-template-columns:\s*repeat\(6,\s*1fr\)/);
  assert.match(sidepanelScript, /signJwtHmac/);
  assert.match(sidepanelScript, /verifyJwtHmac/);
  assert.ok(ids.includes("selection-transform-title"));
  assert.match(sidepanelScript, /function openRecordTransformMenu/);
  assert.match(sidepanelScript, /extractJwt\(value\)/);
  assert.match(sidepanelScript, /showPanel\("jwt"\)/);
  assert.match(sidepanelScript, /addEventListener\("contextmenu"[\s\S]*cookie\.value/);
  assert.match(sidepanelScript, /addEventListener\("contextmenu"[\s\S]*itemValue/);
  assert.match(sidepanelScript, /Number\(isJwt\(b\.value\)\)\s*-\s*Number\(isJwt\(a\.value\)\)/);
  assert.match(css, /\.record-row\.jwt-record/);
  assert.match(css, /\.record-jwt-badge/);
  assert.ok(ids.includes("clear-cookies"), "cookie clear action is missing");
  assert.ok(ids.includes("confirm-dialog"), "in-app confirmation dialog is missing");
  assert.ok(ids.includes("confirm-dialog-accept"), "confirmation action is missing");
  assert.match(sidepanelScript, /function confirmAction\(/);
  assert.match(sidepanelScript, /send\("clearCookies"/);
  assert.match(backgroundScript, /case "clearCookies":/);
  assert.doesNotMatch(sidepanelScript, /\bconfirm\s*\(/, "native confirmation prompts are not allowed");
  assert.match(css, /\.app-dialog::backdrop/);

  const transformOrder = ["base64-input", "url-input", "hash-input", "epoch-input"]
    .map((id) => html.indexOf(`id="${id}"`));
  assert.deepEqual(transformOrder, [...transformOrder].sort((a, b) => a - b));
  assert.ok(ids.includes("ua-preset"), "User-Agent preset selector is missing");
  assert.ok(ids.includes("header-list"), "custom header editor is missing");
  for (const id of [
    "cookie-mode-raw",
    "cookie-mode-pretty",
    "storage-mode-raw",
    "storage-mode-pretty"
  ]) {
    assert.ok(ids.includes(id), `${id} is missing`);
  }
  for (const id of ["base64-tool", "url-tool"]) {
    assert.ok(ids.includes(id), `${id} transform anchor is missing`);
  }
  for (const id of ["base64-clear", "url-clear"]) {
    assert.ok(ids.includes(id), `${id} clear action is missing`);
  }
  assert.match(sidepanelScript, /function clearBase64\(\)/);
  assert.match(sidepanelScript, /function clearUrl\(\)/);
  assert.ok(ids.includes("selection-transform-menu"));
  assert.equal((html.match(/data-selection-tool=/g) ?? []).length, 5);
  assert.ok(ids.includes("selection-jwt-workbench"));
  assert.match(sidepanelScript, /selectionStart/);
  assert.match(sidepanelScript, /applySelectionTransform/);
  for (const menuId of [
    "spectre-base64-encode",
    "spectre-base64-decode",
    "spectre-url-encode",
    "spectre-url-decode"
  ]) {
    assert.match(backgroundScript, new RegExp(menuId));
  }
  for (const menuId of [
    "spectre-action-proxy",
    "spectre-action-headers",
    "spectre-action-user-agent",
    "spectre-action-role"
  ]) {
    assert.match(backgroundScript, new RegExp(menuId));
  }
  assert.match(backgroundScript, /contexts:\s*\["action"\]/);
  assert.match(backgroundScript, /type:\s*"radio"/);
  assert.match(backgroundScript, /type:\s*"checkbox"/);
  assert.match(backgroundScript, /chrome\.proxy\.settings\.get/);
  assert.match(backgroundScript, /controlled_by_this_extension/);

  for (const id of ["proxy-list", "proxy-form", "new-proxy", "role-list", "role-form", "new-role"]) {
    assert.ok(ids.includes(id), `${id} is missing`);
  }
  assert.match(html, /id="proxy-form" class="editor-card hidden"/);
  assert.match(html, /id="role-form" class="editor-card hidden"/);
  assert.match(html, /id="user-agent-form" class="editor-card hidden"/);
  assert.match(html, /id="header-form" class="editor-card hidden"/);
  for (const id of [
    "user-agent-list",
    "new-user-agent",
    "user-agent-form",
    "header-list",
    "new-header",
    "header-form"
  ]) {
    assert.ok(ids.includes(id), `${id} is missing`);
  }
  assert.match(css, /\.switch input\s*\{[^}]*inset:\s*0;[^}]*width:\s*100%;[^}]*height:\s*100%/s);
  for (const id of ["role-scope", "role-scope-domain", "role-scope-hint"]) {
    assert.ok(ids.includes(id), `${id} role scope control is missing`);
  }
  for (const scope of ["origin", "domain", "all"]) {
    assert.match(html, new RegExp(`<option value="${scope}">`));
  }
  assert.match(backgroundScript, /requestDomains:\s*\[domain\]/);
  assert.match(sidepanelScript, /Activate role on all sites\?/);

  const literalSelectors = [...sidepanelScript.matchAll(/\$\("#([A-Za-z][\w:-]*)"\)/g)]
    .map((match) => match[1]);
  for (const id of new Set(literalSelectors)) {
    assert.ok(ids.includes(id), `sidepanel.mjs references missing #${id}`);
  }
});
