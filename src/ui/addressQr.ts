import encodeQR from 'qr';

import { scriptPubKeyForNitoAddress } from '../network/electrum';

const QR_BORDER_MODULES = 4;

export type AddressQr = {
  payload: string;
  path: string;
  size: number;
};

const matrixToPath = (matrix: readonly (readonly boolean[])[]) => {
  const size = matrix.length;
  if (size === 0 || !matrix.every((row) => row.length === size)) {
    throw new Error('Invalid QR matrix.');
  }

  const commands: string[] = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (matrix[y]?.[x] === true) commands.push(`M${x} ${y}h1v1h-1z`);
    }
  }

  if (commands.length === 0) throw new Error('The generated QR code is empty.');
  return commands.join('');
};

export const createAddressQr = (address: string): AddressQr => {
  const payload = address.trim();
  scriptPubKeyForNitoAddress(payload);

  const matrix = encodeQR(payload, 'raw', {
    border: QR_BORDER_MODULES,
    ecc: 'quartile',
    encoding: 'byte',
  });

  return {
    payload,
    path: matrixToPath(matrix),
    size: matrix.length,
  };
};
