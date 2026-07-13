export function replaceTemplateTokenExactlyOnce(source, token, replacement) {
  if (typeof source !== 'string' || typeof token !== 'string' || !token) {
    throw new TypeError('Template source and token must be non-empty strings.');
  }
  const first = source.indexOf(token);
  if (first < 0 || source.indexOf(token, first + token.length) >= 0) {
    throw new Error(`Template must contain ${token} exactly once.`);
  }
  const value = typeof replacement === 'function' ? replacement() : replacement;
  if (typeof value !== 'string') throw new TypeError(`Template replacement for ${token} must be a string.`);
  const result = source.replace(token, () => value);
  if (result.includes(token)) throw new Error(`Template replacement did not consume ${token}.`);
  return result;
}
