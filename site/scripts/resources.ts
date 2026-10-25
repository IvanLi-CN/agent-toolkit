import assert from 'node:assert/strict';

// Follow the srcset URL-token boundary: commas inside data URLs are part of the
// URL; trailing commas delimit candidates. Descriptors may contain parentheses.
export function srcsetUrls(input: string): string[] {
  const urls: string[] = [];
  let index = 0;
  while (index < input.length) {
    while (/[\s,]/.test(input[index] || '') && index < input.length) index++;
    const start = index;
    while (index < input.length && !/\s/.test(input[index])) index++;
    const token = input.slice(start, index);
    if (!token) break;
    urls.push(token.replace(/,+$/, ''));
    if (token.endsWith(',')) continue;
    let depth = 0;
    while (index < input.length) {
      const char = input[index++];
      if (char === '(') depth++;
      if (char === ')') depth--;
      if (char === ',' && depth === 0) break;
    }
  }
  return urls;
}

// A small CSS token reader, rather than a url(...) regex: comments and ordinary
// strings cannot introduce resources, while quoted URLs and CSS escapes can.
// Malformed or unsupported URL syntax fails the check instead of being skipped.
export function cssUrls(input: string): string[] {
  let index = 0;
  const urls: string[] = [];
  const escape = () => {
    assert.equal(input[index++], '\\');
    assert(index < input.length, 'Incomplete CSS escape');
    const hex = input.slice(index).match(/^[0-9a-f]{1,6}/i)?.[0];
    if (hex) {
      index += hex.length;
      if (input[index] === '\r' && input[index + 1] === '\n') index += 2;
      else if (/\s/.test(input[index] || '')) index++;
      const code = Number.parseInt(hex, 16);
      return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : String.fromCodePoint(code);
    }
    const char = input[index++];
    if (char === '\r' && input[index] === '\n') index++;
    return /[\r\n\f]/.test(char) ? '' : char;
  };
  const quoted = () => {
    const quote = input[index++];
    let value = '';
    while (index < input.length && input[index] !== quote) {
      assert(!/[\r\n\f]/.test(input[index]), 'Newline in CSS string');
      value += input[index] === '\\' ? escape() : input[index++];
    }
    assert.equal(input[index++], quote, 'Unterminated CSS string');
    return value;
  };
  const trivia = () => {
    while (index < input.length) {
      if (/\s/.test(input[index])) { index++; continue; }
      if (!input.startsWith('/*', index)) break;
      const end = input.indexOf('*/', index + 2);
      assert(end !== -1, 'Unterminated CSS comment');
      index = end + 2;
    }
  };
  while (index < input.length) {
    trivia();
    if (input[index] === '"' || input[index] === "'") { quoted(); continue; }
    if (/[a-z_\-\\\u0080-\uffff]/i.test(input[index] || '') && index < input.length) {
      let identifier = '';
      while (index < input.length && /[a-z0-9_\-\\\u0080-\uffff]/i.test(input[index])) {
        identifier += input[index] === '\\' ? escape() : input[index++];
      }
      if (identifier.toLowerCase() !== 'url' || input[index] !== '(') continue;
      index++;
      trivia();
      let value = '';
      if (input[index] === '"' || input[index] === "'") value = quoted();
      else {
        while (index < input.length && input[index] !== ')' && !/\s/.test(input[index])) {
          assert(!/[('"\x00-\x08\x0b\x0e-\x1f\x7f]/.test(input[index]), 'Invalid CSS URL');
          value += input[index] === '\\' ? escape() : input[index++];
        }
      }
      trivia();
      assert.equal(input[index++], ')', 'Unterminated CSS URL');
      urls.push(value);
    } else index++;
  }
  return urls;
}

export function localTarget(url: string, from: string, base: string): { file: string; hash: string } | undefined {
  const value = url.trim();
  if (!value || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return;
  const origin = 'https://site.invalid';
  const target = new URL(value, new URL(base + from.replace(/index\.html$/, ''), origin));
  // URL parsing also recognizes backslash spellings of external network URLs.
  if (target.origin !== origin) return;
  const pathname = decodeURIComponent(target.pathname);
  assert(pathname.startsWith(base), `Link escapes repository base: ${from}: ${url}`);
  const local = pathname.slice(base.length);
  assert(!local.split(/[\\/]/).some(part => part === '..' || part === '.'), `Unsafe built target: ${from}: ${url}`);
  assert(!local.includes('\\') && !local.includes('\0'), `Unsafe built target: ${from}: ${url}`);
  return { file: !local || local.endsWith('/') ? `${local}index.html` : local, hash: target.hash };
}
