export const normalizeBip39Passphrase = (value: string): string =>
  value.normalize('NFKD');

export const bip39PassphrasesMatch = (
  passphrase: string,
  confirmation: string,
): boolean =>
  normalizeBip39Passphrase(passphrase) ===
  normalizeBip39Passphrase(confirmation);
