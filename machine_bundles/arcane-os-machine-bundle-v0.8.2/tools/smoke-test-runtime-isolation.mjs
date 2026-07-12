import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const devBootstrap = 'window.__ARCANE_DEV_HTTP__=true;';

const windowsHost = await fs.readFile(path.join(root, 'src/hosts/windows/ArcaneHost.cs'), 'utf8');
for (const token of [
  'CoreWebView2HostResourceAccessKind.DenyCors',
  'if (!IsAllowedAppUri(eventArgs.Uri)) eventArgs.Cancel = true;',
  'String.Equals(uri.Scheme, Uri.UriSchemeHttps',
  'foreach (string allowedPath in Program.AllowedNavigationPaths)',
  'String.Equals(uri.AbsolutePath, allowedPath, StringComparison.Ordinal)',
  'String.Equals(uri.AbsolutePath, "/app/" + Program.AppMode + "/index.html", StringComparison.Ordinal)',
  'String.IsNullOrEmpty(uri.Query)',
  'String.IsNullOrEmpty(uri.Fragment)',
  'Program.AppMode == "shell"',
  'eventArgs.PermissionKind == CoreWebView2PermissionKind.Microphone',
  'CoreWebView2PermissionState.Deny',
]) assert.ok(windowsHost.includes(token), `Windows runtime isolation is missing: ${token}`);
const allowedUriMethod = windowsHost.match(/private static bool IsAllowedAppUri\(string value\)[\s\S]+?(?=\n\s*private static bool IsTrustedAppOrigin\(string value\))/)?.[0] || '';
assert.match(
  allowedUriMethod,
  /if \(!String\.IsNullOrEmpty\(uri\.Query\) \|\| !String\.IsNullOrEmpty\(uri\.Fragment\)\) return false;/,
  'Windows navigation must reject even allowlisted paths when the URI has a query or fragment.',
);

const linuxHost = await fs.readFile(path.join(root, 'src/hosts/linux/arcane_host.c'), 'utf8');
for (const token of [
  'WEBKIT_POLICY_DECISION_TYPE_NEW_WINDOW_ACTION',
  'WEBKIT_POLICY_DECISION_TYPE_NAVIGATION_ACTION',
  'uri_matches_app(host, uri)',
  'webkit_policy_decision_ignore(decision)',
  'g_strcmp0(ARCANE_APP, "shell") == 0',
  'webkit_user_media_permission_is_for_audio_device',
  'webkit_permission_request_allow(request)',
  'webkit_permission_request_deny(request)',
  'webkit_settings_set_allow_file_access_from_file_urls(settings, FALSE)',
  'webkit_settings_set_allow_universal_access_from_file_urls(settings, FALSE)',
]) assert.ok(linuxHost.includes(token), `Linux runtime isolation is missing: ${token}`);

function hashSource(source) {
  return `'sha256-${crypto.createHash('sha256').update(source, 'utf8').digest('base64')}'`;
}

for (const app of ['provisioner', 'shell']) {
  const source = await fs.readFile(path.join(root, `src/frontend/${app}/index.html`), 'utf8');
  assert.ok(source.includes('__ARCANE_SCRIPT_HASHES__'), `${app} source is missing the generated CSP hash placeholder.`);
  assert.match(source, /http-equiv="Permissions-Policy"/i, `${app} source is missing Permissions-Policy.`);
  assert.match(source, /clipboard-write=\(self\)/i, `${app} must retain user-initiated clipboard writes.`);
  if (app === 'shell') assert.match(source, /microphone=\(self\)/i, 'The trusted shell must retain microphone access for voice transcription.');
  else assert.match(source, /microphone=\(\)/i, 'The provisioner must deny microphone access.');

  const built = await fs.readFile(path.join(root, `dist/app/${app}/index.html`), 'utf8');
  assert.ok(!built.includes('__ARCANE_SCRIPT_HASHES__'), `${app} generated CSP still contains its placeholder.`);
  const policy = built.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1];
  assert.ok(policy, `${app} generated payload is missing CSP.`);
  assert.ok(policy.includes("default-src 'none'"), `${app} CSP must default-deny resources.`);
  assert.ok(!/script-src[^;]*'unsafe-inline'/.test(policy), `${app} CSP must not allow arbitrary inline scripts.`);
  assert.ok(policy.includes(hashSource(devBootstrap)), `${app} CSP is missing the exact development bootstrap hash.`);

  const inlineScripts = [...built.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .filter((match) => !/\bsrc\s*=/i.test(match[0]))
    .map((match) => match[1]);
  for (const script of inlineScripts) {
    assert.ok(policy.includes(hashSource(script)), `${app} CSP does not authorize its generated inline application script.`);
  }
}

console.log('Arcane runtime and frontend isolation smoke test passed.');
