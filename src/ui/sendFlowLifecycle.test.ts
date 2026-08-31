import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const dashboardSource = readFileSync(
  resolve(process.cwd(), 'app/wallet-dashboard.tsx'),
  'utf8',
);

describe('send flow lifecycle', () => {
  it('returns from a signed transaction to the editable form when broadcast is cancelled', () => {
    const cancelHandler = dashboardSource.match(
      /const cancelPreparedSend = \(\) => \{([\s\S]*?)\n  \};/u,
    )?.[1];

    expect(cancelHandler).toContain('setPreparedSend(undefined);');
    expect(cancelHandler).toContain('setSendPreview(undefined);');
    expect(cancelHandler).toContain('setSendError(undefined);');
    expect(cancelHandler).toContain(
      'revealWalletStep(sendPreviewButtonRef.current);',
    );
    expect(dashboardSource).toContain('onClick={cancelPreparedSend}');
  });

  it('routes HD consolidation outputs through an internal Taproot address', () => {
    const consolidationHandler = dashboardSource.match(
      /async function previewConsolidation\(\) \{([\s\S]*?)\n  \}/u,
    )?.[1];

    expect(consolidationHandler).toContain(
      'const context = await ensureTaprootReturnAddress();',
    );
    expect(consolidationHandler).toContain(
      'toAddress: context.returnAddress,',
    );
    expect(dashboardSource).toContain("accountKey: 'taproot'");
    expect(dashboardSource).toContain("branch: 'internal'");
  });
});
