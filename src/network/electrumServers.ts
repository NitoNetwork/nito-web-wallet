export type ElectrumServer = Readonly<{
  host: string;
  port: number;
  protocol: 'wss';
  priority: number;
}>;

export const NITO_ELECTRUM_SERVERS: readonly ElectrumServer[] = [
  { host: 'electrum1.nito.network', port: 50005, protocol: 'wss', priority: 1 },
  { host: 'electrum1.nitopool.fr', port: 50005, protocol: 'wss', priority: 2 },
] as const;

export const NITO_ELECTRUM_WSS_ORIGINS = [
  'wss://electrum1.nito.network:50005',
  'wss://electrum1.nitopool.fr:50005',
] as const;
