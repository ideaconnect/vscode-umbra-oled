#!/usr/bin/env node
// Validates the Umbra OLED extension. No dependencies; Node 18+.
//
//   node scripts/validate.mjs [--vscode-app <dir>]
//
// Checks:
//   1. package.json: required fields, semver, theme contributions, tag/version match in CI.
//   2. Theme files: strict JSON, no duplicate keys, well-formed colors, token rules
//      and semantic token rules.
//   3. Color IDs: every key in "colors" exists in VS Code. Needs --vscode-app (or
//      VSCODE_APP_DIR) pointing at a VS Code "resources/app" directory; skipped otherwise.
//   4. Design rules: OLED surfaces are pure black, nothing glares, all syntax
//      text stays readable, and body text passes APCA (which judges light text
//      on black more accurately than WCAG 2 contrast ratios).

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---- design rules ----------------------------------------------------------

// Large, always-visible surfaces that must stay pure black (pixels off on OLED).
const OLED_SURFACES = [
  'editor.background',
  'editorGutter.background',
  'editorGroupHeader.tabsBackground',
  'tab.activeBackground',
  'tab.inactiveBackground',
  'sideBar.background',
  'sideBarSectionHeader.background',
  'activityBar.background',
  'panel.background',
  'statusBar.background',
  'statusBar.noFolderBackground',
  'titleBar.activeBackground',
  'titleBar.inactiveBackground',
  'terminal.background',
  'minimap.background',
  'breadcrumb.background',
];
const MAX_CONTRAST = 15; // no opaque color brighter than this vs black (pure white is 21)
const MIN_TEXT_CONTRAST = 4.5; // WCAG AA for every syntax color
const EDITOR_FG_RANGE = [7, 13.5]; // body text: at least AAA, but well below white-on-black
// Body text must also reach APCA Lc 75, APCA's minimum for body text
// (https://git.apcacontrast.com/documentation/APCA_in_a_Nutshell).
const MIN_BODY_LC = 75;
const BODY_TEXT = ['foreground', 'editor.foreground', 'terminal.foreground'];

// ---- reporting -------------------------------------------------------------

const errors = [];
const warnings = [];
const error = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);
const rel = (p) => relative(ROOT, p) || '.';

// ---- strict JSON parser with duplicate-key detection -----------------------

function parseStrictJson(text, file) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let i = 0;
  const duplicates = [];
  const lineAt = (pos) => text.slice(0, pos).split('\n').length;
  const fail = (msg) => {
    throw new Error(`${file}:${lineAt(i)}: ${msg}`);
  };
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++;
  };
  const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const LITERAL = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;

  const string = () => {
    STRING.lastIndex = i;
    const m = STRING.exec(text);
    if (!m) fail('invalid string');
    i = STRING.lastIndex;
    return JSON.parse(m[0]);
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') return object();
    if (c === '[') return array();
    if (c === '"') return string();
    LITERAL.lastIndex = i;
    const m = LITERAL.exec(text);
    if (!m) fail(`unexpected ${c === undefined ? 'end of file' : JSON.stringify(c)}`);
    i = LITERAL.lastIndex;
    return JSON.parse(m[0]);
  };
  const object = () => {
    i++;
    const out = {};
    ws();
    if (text[i] === '}') return i++, out;
    for (;;) {
      ws();
      if (text[i] !== '"') fail('expected a property name (comments and trailing commas are not allowed)');
      const at = i;
      const key = string();
      if (Object.hasOwn(out, key)) duplicates.push(`${file}:${lineAt(at)}: duplicate key "${key}"`);
      ws();
      if (text[i++] !== ':') fail("expected ':'");
      out[key] = value();
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') return i++, out;
      fail("expected ',' or '}'");
    }
  };
  const array = () => {
    i++;
    const out = [];
    ws();
    if (text[i] === ']') return i++, out;
    for (;;) {
      out.push(value());
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') return i++, out;
      fail("expected ',' or ']'");
    }
  };

  const result = value();
  ws();
  if (i !== text.length) fail('unexpected content after the top-level value');
  return { value: result, duplicates };
}

function loadJson(path) {
  const name = rel(path);
  try {
    const { value, duplicates } = parseStrictJson(readFileSync(path, 'utf8'), name);
    for (const d of duplicates) errors.push(d);
    return value;
  } catch (e) {
    errors.push(e.message);
    return undefined;
  }
}

// ---- colors ----------------------------------------------------------------

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

function rgba(hex) {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join('');
  const n = (k) => parseInt(h.slice(k, k + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 255 };
}

function luminance(hex) {
  const { r, g, b } = rgba(hex);
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// APCA 0.0.98G-4g lightness contrast, as |Lc| (polarity does not matter here).
function apca(text, bg) {
  const y = (hex) => {
    const { r, g, b } = rgba(hex);
    const v = 0.2126729 * (r / 255) ** 2.4 + 0.7151522 * (g / 255) ** 2.4 + 0.072175 * (b / 255) ** 2.4;
    return v > 0.022 ? v : v + (0.022 - v) ** 1.414;
  };
  const [yt, yb] = [y(text), y(bg)];
  if (Math.abs(yb - yt) < 0.0005) return 0;
  const s = yb > yt ? (yb ** 0.56 - yt ** 0.57) * 1.14 : (yb ** 0.65 - yt ** 0.62) * 1.14;
  return Math.abs(s) < 0.1 ? 0 : (Math.abs(s) - 0.027) * 100;
}

const isOpaque = (hex) => rgba(hex).a === 255;
const isPureBlack = (hex) => {
  const { r, g, b, a } = rgba(hex);
  return r === 0 && g === 0 && b === 0 && a === 255;
};

// ---- 1. manifest -----------------------------------------------------------

const UI_THEMES = { vs: 'light', 'vs-dark': 'dark', 'hc-black': 'hcDark', 'hc-light': 'hcLight' };
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// The Marketplace needs a PNG icon of at least 128x128 inside the package; it rejects SVG.
function checkIcon(where, icon) {
  if (typeof icon !== 'string') return error(where, '"icon" must be a path');
  if (/\.svg$/i.test(icon)) return error(where, '"icon" cannot be an SVG (the Marketplace rejects it)');
  const file = resolve(ROOT, icon);
  if (!existsSync(file)) return error(where, `"icon" ${icon} does not exist`);
  const png = readFileSync(file);
  const isPng = png.length >= 24 && png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && png.toString('latin1', 12, 16) === 'IHDR';
  if (!isPng) return error(where, `"icon" ${icon} is not a PNG file`);
  const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  if (width < 128 || height < 128) error(where, `"icon" is ${width}x${height}, the Marketplace needs at least 128x128`);
}

function checkManifest() {
  const where = 'package.json';
  const pkg = loadJson(join(ROOT, 'package.json'));
  if (!pkg) return [];

  for (const field of ['name', 'displayName', 'description', 'version', 'publisher', 'license']) {
    if (typeof pkg[field] !== 'string' || !pkg[field].trim()) error(where, `"${field}" must be a non-empty string`);
  }
  if (pkg.name && !/^[a-z0-9][a-z0-9-]*$/.test(pkg.name)) error(where, `"name" must be lowercase letters, digits and dashes`);
  if (pkg.version && !SEMVER.test(pkg.version)) error(where, `"version" ${JSON.stringify(pkg.version)} is not semver`);
  if (typeof pkg.engines?.vscode !== 'string') error(where, '"engines.vscode" is required');
  if (!pkg.categories?.includes('Themes')) error(where, '"categories" must include "Themes"');
  if (pkg.icon !== undefined) checkIcon(where, pkg.icon);
  if (pkg.galleryBanner !== undefined) {
    const { color, theme } = pkg.galleryBanner ?? {};
    if (color !== undefined && !HEX.test(color)) error(where, `"galleryBanner.color" ${JSON.stringify(color)} is not a hex color`);
    if (theme !== undefined && theme !== 'dark' && theme !== 'light') error(where, '"galleryBanner.theme" must be "dark" or "light"');
  }

  // On a tag build, the tag must match the version ("0.1" matches "0.1.0", "v1.2.3" matches "1.2.3").
  if (process.env.GITHUB_REF_TYPE === 'tag' && pkg.version) {
    const tag = process.env.GITHUB_REF_NAME.replace(/^v/, '');
    const parts = tag.split('.');
    while (parts.length < 3) parts.push('0');
    if (parts.join('.') !== pkg.version) error(where, `git tag "${process.env.GITHUB_REF_NAME}" does not match version "${pkg.version}"`);
  }

  const themes = pkg.contributes?.themes;
  if (!Array.isArray(themes) || themes.length === 0) {
    error(where, '"contributes.themes" must be a non-empty array');
    return [];
  }
  const labels = new Set();
  const found = [];
  themes.forEach((t, n) => {
    const at = `${where} contributes.themes[${n}]`;
    if (typeof t.label !== 'string' || !t.label.trim()) error(at, '"label" is required');
    else if (labels.has(t.label)) error(at, `duplicate label "${t.label}"`);
    else labels.add(t.label);
    if (!(t.uiTheme in UI_THEMES)) error(at, `"uiTheme" must be one of ${Object.keys(UI_THEMES).join(', ')}`);
    if (typeof t.path !== 'string') return error(at, '"path" is required');
    const file = resolve(ROOT, t.path);
    if (!file.startsWith(ROOT + '/') && !file.startsWith(ROOT + '\\')) return error(at, `"path" escapes the extension folder`);
    if (!existsSync(file)) return error(at, `"path" ${t.path} does not exist`);
    found.push({ ...t, file });
  });
  return found;
}

// ---- 2. theme structure ----------------------------------------------------

const FONT_STYLES = new Set(['italic', 'bold', 'underline', 'strikethrough']);
const TOKEN_SETTINGS = new Set(['foreground', 'background', 'fontStyle']);
const SEMANTIC_SELECTOR = /^(?:\*|[A-Za-z][\w-]*)(?:\.[A-Za-z][\w-]*)*(?::[A-Za-z][\w-]*)?$/;
const SEMANTIC_STYLE = new Set(['foreground', 'fontStyle', 'bold', 'italic', 'underline', 'strikethrough']);

function checkColor(where, value) {
  if (typeof value !== 'string' || !HEX.test(value)) {
    error(where, `${JSON.stringify(value)} is not a #rgb, #rgba, #rrggbb or #rrggbbaa color`);
    return false;
  }
  return true;
}

function checkFontStyle(where, value) {
  if (typeof value !== 'string') return error(where, 'fontStyle must be a string');
  for (const s of value.split(/\s+/).filter(Boolean)) {
    if (!FONT_STYLES.has(s)) error(where, `unknown fontStyle "${s}"`);
  }
}

function checkTheme(theme, contribution) {
  const where = rel(contribution.file);
  const textColors = []; // [where, hex] syntax foregrounds, checked against the editor background

  if (typeof theme.name !== 'string') warn(where, '"name" is missing');
  const expectedType = UI_THEMES[contribution.uiTheme];
  if (theme.type !== undefined && theme.type !== expectedType) {
    error(where, `"type" is "${theme.type}" but package.json uiTheme "${contribution.uiTheme}" means "${expectedType}"`);
  }
  if (theme.semanticHighlighting !== undefined && typeof theme.semanticHighlighting !== 'boolean') {
    error(where, '"semanticHighlighting" must be a boolean');
  }

  // colors
  const colors = theme.colors ?? {};
  if (typeof colors !== 'object' || Array.isArray(colors)) error(where, '"colors" must be an object');
  for (const [key, value] of Object.entries(colors)) checkColor(`${where} colors["${key}"]`, value);

  // tokenColors
  const rules = theme.tokenColors ?? [];
  if (!Array.isArray(rules)) {
    error(where, '"tokenColors" must be an array (external .tmTheme files are not supported here)');
  } else {
    const scopeOwner = new Map();
    rules.forEach((rule, n) => {
      const at = `${where} tokenColors[${n}]${rule?.name ? ` "${rule.name}"` : ''}`;
      if (!rule || typeof rule !== 'object') return error(at, 'must be an object');
      const s = rule.settings;
      if (!s || typeof s !== 'object') return error(at, '"settings" object is required');
      for (const k of Object.keys(s)) if (!TOKEN_SETTINGS.has(k)) error(at, `unknown setting "${k}"`);
      if (s.foreground !== undefined && checkColor(`${at} foreground`, s.foreground)) textColors.push([at, s.foreground]);
      if (s.background !== undefined) checkColor(`${at} background`, s.background);
      if (s.fontStyle !== undefined) checkFontStyle(at, s.fontStyle);

      if (rule.scope === undefined) {
        if (n !== 0) error(at, 'only the first rule may omit "scope" (it sets the defaults)');
        return;
      }
      const scopes = typeof rule.scope === 'string' ? rule.scope.split(',') : rule.scope;
      if (!Array.isArray(scopes) || scopes.length === 0) return error(at, '"scope" must be a string or a non-empty array');
      for (const raw of scopes) {
        if (typeof raw !== 'string' || !raw.trim()) {
          error(at, 'scopes must be non-empty strings');
          continue;
        }
        const scope = raw.trim();
        if (scopeOwner.has(scope)) error(at, `scope "${scope}" is already styled by tokenColors[${scopeOwner.get(scope)}]`);
        else scopeOwner.set(scope, n);
      }
    });
  }

  // semanticTokenColors
  const semantic = theme.semanticTokenColors ?? {};
  for (const [selector, style] of Object.entries(semantic)) {
    const at = `${where} semanticTokenColors["${selector}"]`;
    if (!SEMANTIC_SELECTOR.test(selector)) error(at, 'invalid selector');
    if (typeof style === 'string') {
      if (checkColor(at, style)) textColors.push([at, style]);
    } else if (style && typeof style === 'object') {
      for (const [k, v] of Object.entries(style)) {
        if (!SEMANTIC_STYLE.has(k)) error(at, `unknown property "${k}"`);
        else if (k === 'foreground') checkColor(at, v) && textColors.push([at, v]);
        else if (k === 'fontStyle') checkFontStyle(at, v);
        else if (typeof v !== 'boolean') error(at, `"${k}" must be a boolean`);
      }
    } else {
      error(at, 'must be a color string or a style object');
    }
  }

  return { colors, textColors };
}

// ---- 3. color IDs known to VS Code -----------------------------------------

function loadKnownColorIds(appDir) {
  const workbench = join(appDir, 'out/vs/workbench/workbench.desktop.main.js');
  if (!existsSync(workbench)) throw new Error(`${workbench} not found; --vscode-app must point at VS Code's resources/app`);
  const source = readFileSync(workbench, 'utf8');

  // Colors contributed by built-in extensions (e.g. gitDecoration.* from the git extension).
  const contributed = new Set();
  const extDir = join(appDir, 'extensions');
  for (const ext of existsSync(extDir) ? readdirSync(extDir) : []) {
    const manifest = join(extDir, ext, 'package.json');
    if (!existsSync(manifest)) continue;
    try {
      for (const c of JSON.parse(readFileSync(manifest, 'utf8')).contributes?.colors ?? []) contributed.add(c.id);
    } catch {
      // not every bundled package.json is ours to judge
    }
  }

  let version = 'unknown';
  try {
    version = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version;
  } catch {}

  const has = (id) => contributed.has(id) || source.includes(`"${id}"`) || source.includes(`'${id}'`) || source.includes(`\`${id}\``);
  return { has, version };
}

// ---- 4. design rules -------------------------------------------------------

function checkDesign(where, colors, textColors) {
  const bg = colors['editor.background'];
  const fg = colors['editor.foreground'];

  for (const key of OLED_SURFACES) {
    const value = colors[key];
    if (value === undefined) error(where, `OLED: "${key}" must be set to #000000 (VS Code's default is not black)`);
    else if (HEX.test(value) && !isPureBlack(value)) error(where, `OLED: "${key}" is ${value}, must be #000000`);
  }

  for (const [key, value] of Object.entries(colors)) {
    if (HEX.test(value) && isOpaque(value) && contrast(value, '#000000') > MAX_CONTRAST) {
      error(where, `glare: colors["${key}"] ${value} is ${contrast(value, '#000000').toFixed(2)}:1 vs black (max ${MAX_CONTRAST})`);
    }
  }
  for (const [at, value] of textColors) {
    if (isOpaque(value) && contrast(value, '#000000') > MAX_CONTRAST) {
      error(at, `glare: ${value} is ${contrast(value, '#000000').toFixed(2)}:1 vs black (max ${MAX_CONTRAST})`);
    }
  }

  if (!bg || !fg || !HEX.test(bg) || !HEX.test(fg)) return;
  const body = contrast(fg, bg);
  if (body < EDITOR_FG_RANGE[0] || body > EDITOR_FG_RANGE[1]) {
    error(where, `editor.foreground is ${body.toFixed(2)}:1, must be between ${EDITOR_FG_RANGE[0]} and ${EDITOR_FG_RANGE[1]}`);
  }
  for (const key of BODY_TEXT) {
    const value = colors[key];
    if (value === undefined || !HEX.test(value) || !isOpaque(value)) continue;
    const lc = apca(value, bg);
    if (lc < MIN_BODY_LC) error(where, `readability: colors["${key}"] ${value} is APCA Lc ${lc.toFixed(1)} on ${bg}, needs at least Lc ${MIN_BODY_LC}`);
  }
  for (const [at, value] of textColors) {
    if (!isOpaque(value)) continue;
    const c = contrast(value, bg);
    if (c < MIN_TEXT_CONTRAST) error(at, `readability: ${value} is ${c.toFixed(2)}:1 on ${bg}, needs at least ${MIN_TEXT_CONTRAST}`);
  }
}

// ---- main ------------------------------------------------------------------

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const vscodeApp = argValue('--vscode-app') ?? process.env.VSCODE_APP_DIR;
let known;
if (vscodeApp) {
  try {
    known = loadKnownColorIds(resolve(vscodeApp));
  } catch (e) {
    error('--vscode-app', e.message);
  }
}

const contributions = checkManifest();
const summary = [];
for (const contribution of contributions) {
  const where = rel(contribution.file);
  const theme = loadJson(contribution.file);
  if (!theme || typeof theme !== 'object' || Array.isArray(theme)) {
    if (theme !== undefined) error(where, 'top level must be an object');
    continue;
  }
  const { colors, textColors } = checkTheme(theme, contribution);
  if (known) {
    for (const key of Object.keys(colors)) {
      if (!known.has(key)) error(`${where} colors["${key}"]`, `not a color ID in VS Code ${known.version}`);
    }
  }
  checkDesign(where, colors, textColors);
  summary.push(
    `${contribution.label}: ${Object.keys(colors).length} colors, ` +
      `${theme.tokenColors?.length ?? 0} token rules, ${Object.keys(theme.semanticTokenColors ?? {}).length} semantic rules`,
  );
}

for (const line of summary) console.log(`  ${line}`);
console.log(known ? `  color IDs checked against VS Code ${known.version}` : '  color IDs not checked (pass --vscode-app <VS Code resources/app dir>)');
for (const w of warnings) console.warn(`warning  ${w}`);
for (const e of errors) console.error(`error    ${e}`);

if (errors.length) {
  console.error(`\n✖ ${errors.length} error(s)`);
  process.exit(1);
}
console.log('\n✔ theme is valid');
