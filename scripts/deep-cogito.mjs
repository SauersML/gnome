export const COGITO_ENDPOINT = 'https://chat.deepcogito.com/api/cogito';
const MODEL = 'drishanarora/cogito-v2-1-671b';

export async function completeInBrowser(browser, body) {
  const payload = JSON.parse(body);
  if (payload.model !== MODEL || !Array.isArray(payload.messages) || payload.messages.length > 40) {
    throw new Error('Invalid Cogito request');
  }
  const page = await browser.newPage();
  try {
    const navigation = await page.goto('https://chat.deepcogito.com/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (!navigation?.ok()) {
      return { status: navigation?.status() || 502, contentType: 'text/plain', text: '' };
    }
    await page.locator('textarea').waitFor({ timeout: 15_000 });
    return await page.evaluate(async ({ endpoint, body }) => {
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        signal: AbortSignal.timeout(120_000),
      });
      const text = response.ok ? await response.text() : '';
      if (text.length > 256_000) throw new Error('Response too large');
      return { status: response.status, contentType: response.headers.get('content-type') || '', text };
    }, { endpoint: COGITO_ENDPOINT, body });
  } finally {
    await page.close();
  }
}
