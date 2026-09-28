import { describe, expect, it } from 'vitest';

import { renderStudioDocument } from '../../src/studio/studioDocument.js';

describe('Studio document', () => {
  it('renders a minimal same-origin application shell', () => {
    const html = renderStudioDocument();

    expect(html).toContain('<div id="studio-root"></div>');
    expect(html).not.toContain('Loading Studio');
    expect(html).toContain('src="/studio/assets/studio.js"');
    expect(html).toContain('href="/studio/assets/studio.css"');
    expect(html).not.toContain('<style>');
    expect(html).not.toContain('Mission Control');
    expect(html).not.toContain('orbit');
  });
});
