export const defaultBuyPresets = Object.freeze([1, 5, 10]);
export const buyPresetsKey = 'btc5m-buy-presets-v1';
export function validateBuyPresets(values) {
  if (!Array.isArray(values) || values.length !== 3 ||
      values.some(n => !Number.isInteger(n) || n < 1 || n > 1000)) {
    throw Error('请填写三个 $1–$1000 的整数金额');
  }
  return [...values];
}
export function loadBuyPresets(storage) {
  try { return validateBuyPresets(JSON.parse(storage.getItem(buyPresetsKey))); }
  catch { return [...defaultBuyPresets]; }
}
