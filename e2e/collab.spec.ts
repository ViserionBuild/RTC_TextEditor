import { expect, test, type Browser, type Page } from '@playwright/test';

declare global {
  interface Window {
    __collabpad?: { editorText(): string; text(): string };
  }
}

/** Each user is a separate browser context: own storage, own replica. */
async function openAs(browser: Browser, url: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(url);
  await expect(page.getByRole('status')).toHaveText('All changes saved');
  return page;
}

/** Create a document from the home page; the creating page becomes the first user. */
async function createAs(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: /new document/i }).click();
  await expect(page).toHaveURL(/\/d\/[\w-]+$/);
  await expect(page.getByRole('status')).toHaveText('All changes saved');
  return page.url();
}

/** Editor view and CRDT agree on every page, and all pages agree with each other. */
async function expectConverged(pages: Page[], expected: string) {
  await expect
    .poll(async () => {
      const texts = await Promise.all(
        // The hook is missing for a moment after a reload; report that instead of throwing.
        pages.map((p) =>
          p.evaluate(() => {
            const hook = window.__collabpad;
            return hook ? [hook.editorText(), hook.text()] : ['<loading>'];
          }),
        ),
      );
      const all = texts.flat();
      return all.every((t) => t === all[0]) ? all[0] : `diverged: ${JSON.stringify(texts)}`;
    })
    .toBe(expected);
}

async function typeAt(page: Page, index: number, text: string) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  for (let i = 0; i < index; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.type(text);
}

test('three users edit live, one goes offline, everyone converges', async ({
  browser,
  page: alice,
}) => {
  const url = await createAs(alice);
  const bob = await openAs(browser, `${url}?debug`);
  const carol = await openAs(browser, url);
  const everyone = [alice, bob, carol];

  await typeAt(alice, 0, 'Hello world');
  await expectConverged(everyone, 'Hello world');

  // Remote cursors show the other users' names.
  await expect(bob.locator('.cp-remote-label')).toHaveCount(2);

  // Bob goes offline and keeps typing; the others edit too.
  await bob.getByLabel('Simulate offline').check();
  await typeAt(bob, 5, ' brave new');
  await expect(bob.getByRole('status')).toHaveText(/Offline · 10 changes pending/);
  await typeAt(alice, 11, '!');
  await typeAt(carol, 0, '> ');
  await expectConverged([alice, carol], '> Hello world!');

  await bob.getByLabel('Simulate offline').uncheck();
  await expectConverged(everyone, '> Hello brave new world!');
  await expect(bob.getByRole('status')).toHaveText('All changes saved');
});

test('offline edits survive a page reload', async ({ browser, page: bob }) => {
  const url = await createAs(bob);
  const alice = await openAs(browser, `${url}?debug`);

  await typeAt(alice, 0, 'base');
  await expectConverged([alice, bob], 'base');

  await alice.getByLabel('Simulate offline').check();
  await typeAt(alice, 4, ' + offline');
  await alice.reload();

  await expectConverged([alice, bob], 'base + offline');
});

test('unknown documents show a not-found page', async ({ page }) => {
  await page.goto('/d/doesNotExist123');
  await expect(page.getByRole('heading', { name: 'Document not found' })).toBeVisible();
});

test('two tabs in the same browser get separate replicas', async ({ page: first }) => {
  const url = await createAs(first);
  const second = await first.context().newPage(); // same profile: shared IndexedDB + locks
  await second.goto(url);
  await expect(second.getByRole('status')).toHaveText('All changes saved');

  const replica = (p: Page) =>
    p.evaluate(
      () =>
        (window.__collabpad as unknown as { client: { doc: { replica: string } } }).client.doc
          .replica,
    );
  expect(await replica(first)).not.toBe(await replica(second));

  await typeAt(first, 0, 'one');
  await typeAt(second, 3, ' two');
  await expectConverged([first, second], 'one two');
});

test('deleted text is garbage-collected in every browser', async ({ browser, page: alice }) => {
  const url = await createAs(alice);
  const bob = await openAs(browser, url);
  const carol = await openAs(browser, url);
  const everyone = [alice, bob, carol];

  await typeAt(alice, 0, 'keep this, drop that');
  await expectConverged(everyone, 'keep this, drop that');
  await bob.locator('.cm-content').click();
  await bob.keyboard.press('Control+End');
  for (let i = 0; i < 10; i++) await bob.keyboard.press('Backspace');
  await expectConverged(everyone, 'keep this,');

  const tombstones = (p: Page) =>
    p.evaluate(
      () =>
        (
          window.__collabpad as unknown as { client: { doc: { stats(): { tombstones: number } } } }
        ).client.doc.stats().tombstones,
    );
  // Two acknowledgement rounds (each client reports ~1 s after receiving ops).
  await expect
    .poll(async () => Promise.all(everyone.map(tombstones)), { timeout: 15_000 })
    .toEqual([0, 0, 0]);

  // Editing keeps working on the collected state.
  await typeAt(carol, 4, '!');
  await expectConverged(everyone, 'keep! this,');
});
