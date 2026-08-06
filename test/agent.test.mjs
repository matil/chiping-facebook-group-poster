import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { signPayload } from '../src/auth.mjs';
import { loadConfig, normalizeGroupUrl } from '../src/config.mjs';
import { createServer } from '../src/server.mjs';
import {
  attachFacebookComposerImage,
  buildFacebookPreviewShareUrl,
  FacebookPostUnavailableError,
  FacebookSessionRequiredError,
  fillFacebookComposerText,
  findFacebookComposerTextBox,
  findFacebookGroupPostOnPage,
  findFacebookGroupPostViaLinkCardTitle,
  findFacebookGroupPostViaTargetAnchor,
  findFacebookGroupPostWithMediaFallback,
  findFacebookGroupComposer,
  hasLoadedFacebookPostLinkImage,
  hasLoadedFacebookPreviewVisual,
  isFacebookSecurityChallengeText,
  loginIfNeeded,
  normalizeFacebookGroupPostUrl,
  prepareFacebookComposerLinkPreview,
  readLoginCredentials,
  selectFacebookComposerText,
  sortFacebookGroupFeedNewest,
  validateChipingLinkPreviewMetadata,
  verifyFacebookPostImageDestination,
  waitForChipingLinkPreviewMetadata,
  waitForFacebookComposerToClose,
  waitForFacebookLinkPreview,
} from '../src/facebook.mjs';

import {
  advanceRememberedLogin,
  fillLoginForm,
  loginCompleted,
} from '../src/interactive-login.mjs';
import { JobStore } from '../src/store.mjs';
import { validChipingFacebookPayload } from '../src/payload.mjs';
import {
  inspectFacebookStatus,
  repairFacebookBlockedJobs,
  repairFacebookMediaBlock,
  runFacebookStatus,
} from '../src/status-runner.mjs';

test('Facebook publisher allows slow link-card images up to 90 seconds', async () => {
  const source = await readFile(path.join(process.cwd(), 'src', 'facebook.mjs'), 'utf8');
  assert.match(source, /FACEBOOK_COMPOSER_LINK_PREVIEW_TIMEOUT_MS = 90_000/);
  assert.match(
    source,
    /prepareFacebookComposerLinkPreview\([\s\S]*FACEBOOK_COMPOSER_LINK_PREVIEW_TIMEOUT_MS/
  );
});

const secret = 'facebook-group-poster-test-secret-with-at-least-32-characters';

function payload(overrides = {}) {
  return {
    idempotency_key: 'chiping-facebook:v1:9301',
    productId: '9301',
    site: 'chiping',
    channel: 'facebook',
    language: 'he',
    message: '\u05d3\u05d9\u05dc \u05d1\u05d3\u05d9\u05e7\u05d4',
    imageUrl: 'https://cdn.example.test/deal.jpg',
    itemUrl: 'https://www.chiping.co.il/?item=9301',
    ...overrides,
  };
}

function couponPayload(overrides = {}) {
  const fingerprint = 'b'.repeat(32);
  return {
    idempotency_key: `chiping-facebook:coupons:v1:${fingerprint}`,
    contentId: fingerprint,
    site: 'chiping',
    channel: 'facebook',
    language: 'he',
    post_type: 'coupon_announcement',
    posting_policy: 'coupon-announcement',
    message: '\u05e7\u05d5\u05e4\u05d5\u05e0\u05d9\u05dd \u05d7\u05d3\u05e9\u05d9\u05dd \u05dc-AliExpress',
    imageUrl: 'https://www.chiping.co.il/images/fb-coupons-aliexpress-v2.png',
    itemUrl: 'https://www.chiping.co.il/?coupons=1',
    ...overrides,
  };
}

test('Chiping group URL is fixed to the intended Facebook group', () => {
  assert.equal(normalizeGroupUrl('https://www.facebook.com/groups/chiping/'), 'https://www.facebook.com/groups/chiping');
  assert.throws(() => normalizeGroupUrl('https://www.facebook.com/groups/other'), /Chiping Facebook group/);
  assert.throws(() => normalizeGroupUrl('http://www.facebook.com/groups/chiping'), /https/);
});

test('Facebook post verification accepts only concrete group post permalinks', () => {
  assert.equal(
    normalizeFacebookGroupPostUrl('https://www.facebook.com/groups/chiping/posts/123456789/?__cft__=1'),
    'https://www.facebook.com/groups/chiping/posts/123456789/'
  );
  assert.equal(
    normalizeFacebookGroupPostUrl('/groups/123456789/permalink/987654321/'),
    'https://www.facebook.com/groups/123456789/permalink/987654321/'
  );
  assert.equal(
    normalizeFacebookGroupPostUrl('https://www.facebook.com/photo/?fbid=111&set=gm.222333444'),
    'https://www.facebook.com/groups/chiping/posts/222333444/'
  );
  assert.equal(
    normalizeFacebookGroupPostUrl('https://www.facebook.com/groups/chiping/?multi_permalinks=777888999'),
    'https://www.facebook.com/groups/chiping/posts/777888999/'
  );
  assert.equal(
    normalizeFacebookGroupPostUrl('https://www.facebook.com/groups/chiping/posts/pfbid02AbCdEf123/?__cft__=1'),
    'https://www.facebook.com/groups/chiping/posts/pfbid02AbCdEf123/'
  );
  assert.equal(normalizeFacebookGroupPostUrl('https://www.facebook.com/groups/chiping'), '');
  assert.equal(normalizeFacebookGroupPostUrl('https://www.facebook.com/groups/other/posts/123456789/'), '');
  assert.equal(normalizeFacebookGroupPostUrl('https://example.test/groups/chiping/posts/123456789/'), '');
});

test('Facebook post verification requires the exact item link and returns its permalink', async () => {
  const navigations = [];
  const hidden = { async isVisible() { return false; } };
  const articles = [
    {
      visible: true,
      text: 'Unrelated deal https://www.chiping.co.il/?item=9300',
      hrefs: ['https://www.facebook.com/groups/chiping/posts/111/'],
    },
    {
      visible: true,
      text: 'Deal link',
      hrefs: [
        'https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.chiping.co.il%2F%3Fitem%3D9301',
        'https://www.facebook.com/groups/chiping/posts/222/?__cft__=1',
      ],
    },
  ];
  const page = {
    async goto(url) { navigations.push(url); },
    async waitForTimeout() {},
    locator(selector) {
      assert.equal(selector, '[role="article"]');
      return {
        async count() { return articles.length; },
        nth(index) {
          const article = articles[index];
          return {
            async isVisible() { return article.visible; },
            async innerText() { return article.text; },
            locator(selector) {
              if (selector !== 'a[href]') {
                return {
                  async count() { return 0; },
                  nth() { return hidden; },
                };
              }
              return {
                async evaluateAll() { return article.hrefs; },
              };
            },
          };
        },
      };
    },
  };

  const result = await findFacebookGroupPostOnPage(page, {
    groupUrl: 'https://www.facebook.com/groups/chiping',
    itemUrl: 'https://www.chiping.co.il/?item=9301',
    timeoutMs: 5000,
  });
  assert.deepEqual(result, {
    found: true,
    postUrl: 'https://www.facebook.com/groups/chiping/posts/222/',
  });
  assert.equal(navigations.length, 0);
});

test('coupon payload validation keeps legacy queued artwork compatible', () => {
  assert.equal(validChipingFacebookPayload(couponPayload()), true);
  assert.equal(validChipingFacebookPayload(couponPayload({
    imageUrl: 'https://www.chiping.co.il/images/fb-coupons-aliexpress.png',
  })), true);
});

test('Facebook payload validation rejects corrupted Hebrew before posting', () => {
  assert.equal(validChipingFacebookPayload(payload({ message: '???? ????? ?????' })), false);
  assert.equal(validChipingFacebookPayload(payload({ message: '\ufffd\ufffd\ufffd' })), false);
  assert.equal(validChipingFacebookPayload(payload({ message: 'Under Armour Charged Assert 11' })), false);
  assert.equal(validChipingFacebookPayload(payload({
    message: '\u05de\u05d4 \u05d4\u05de\u05d7\u05d9\u05e8? \u05d6\u05d4 \u05d3\u05d9\u05dc \u05d8\u05d5\u05d1',
    title: '???? Under Armour',
  })), false);
  assert.equal(validChipingFacebookPayload(payload({
    message: '\u05de\u05d4 \u05d4\u05de\u05d7\u05d9\u05e8? \u05d6\u05d4 \u05d3\u05d9\u05dc \u05d8\u05d5\u05d1',
    title: '\u05e0\u05e2\u05dc\u05d9 \u05e8\u05d9\u05e6\u05d4 Under Armour',
    description: '\u05e8\u05d9\u05e4\u05d5\u05d3 \u05e0\u05d5\u05d7 \u05dc\u05e8\u05d9\u05e6\u05d4',
  })), true);
});

test('Facebook post verification matches the exact coupon-popup link', async () => {
  const articles = [{
    text: '\u05e7\u05d5\u05e4\u05d5\u05e0\u05d9\u05dd \u05d7\u05d3\u05e9\u05d9\u05dd',
    hrefs: [
      'https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.chiping.co.il%2F%3Fcoupons%3D1',
      'https://www.facebook.com/groups/chiping/posts/444/',
    ],
  }];
  const page = {
    async waitForTimeout() {},
    locator(selector) {
      assert.equal(selector, '[role="article"]');
      return {
        async count() { return articles.length; },
        nth(index) {
          const article = articles[index];
          return {
            async isVisible() { return true; },
            async innerText() { return article.text; },
            locator(innerSelector) {
              if (innerSelector.includes('role="button"')) return { async count() { return 0; } };
              return { async evaluateAll() { return article.hrefs; } };
            },
          };
        },
      };
    },
  };

  assert.deepEqual(await findFacebookGroupPostOnPage(page, {
    groupUrl: 'https://www.facebook.com/groups/chiping',
    itemUrl: 'https://www.chiping.co.il/?coupons=1',
    timeoutMs: 5000,
    currentPageOnly: true,
  }), {
    found: true,
    postUrl: 'https://www.facebook.com/groups/chiping/posts/444/',
  });
});

test('Facebook post verification associates a tracked Chiping link with its closest feed permalink', async () => {
  const page = {
    locator(selector) {
      assert.equal(selector, 'a[href], [data-lynx-uri]');
      return {
        async evaluateAll(_callback, productId) {
          assert.equal(productId, '9301');
          return {
            targetFound: true,
            hrefs: [
              'https://www.facebook.com/groups/chiping/?multi_permalinks=777888999',
            ],
          };
        },
      };
    },
  };

  assert.deepEqual(await findFacebookGroupPostViaTargetAnchor(
    page,
    'https://www.chiping.co.il/?item=9301'
  ), {
    found: true,
    postUrl: 'https://www.facebook.com/groups/chiping/posts/777888999/',
  });
});

test('Facebook post verification matches the exact Chiping link-card title when Facebook strips its query string', async () => {
  const title = '\u05e2\u05e8\u05db\u05ea \u05d8\u05d9\u05e4\u05d5\u05d7 \u05dc\u05e9\u05d9\u05e2\u05e8 Pantene Molecular Bond Repair';
  const articles = [
    {
      text: `${title}\nUnrelated source`,
      hrefs: ['https://www.facebook.com/groups/chiping/posts/111/'],
    },
    {
      text: `Pantene Molecular Bond Repair \u05e2\u05e8\u05db\u05ea \u05d8\u05d9\u05e4\u05d5\u05d7 \u05dc\u05e9\u05d9\u05e2\u05e8\nCHIPING.CO.IL`,
      hrefs: ['https://www.facebook.com/groups/chiping/posts/222/?__cft__=1'],
    },
  ];
  const page = {
    locator(selector) {
      assert.equal(selector, '[role="article"]');
      return {
        async count() { return articles.length; },
        nth(index) {
          const article = articles[index];
          return {
            async isVisible() { return true; },
            async innerText() { return article.text; },
            locator(innerSelector) {
              assert.equal(innerSelector, 'a[href], [data-lynx-uri]');
              return {
                async evaluateAll() { return article.hrefs; },
              };
            },
          };
        },
      };
    },
  };

  assert.deepEqual(await findFacebookGroupPostViaLinkCardTitle(page, title), {
    found: true,
    postUrl: 'https://www.facebook.com/groups/chiping/posts/222/',
  });
});

test('Facebook post verification rejects a matching blank link card without a clickable image', async () => {
  const title = '\u05e8\u05d0\u05e9 \u05de\u05e7\u05dc\u05d7\u05ea \u05d2\u05e9\u05dd \u05db\u05e4\u05d5\u05dc';
  const mediaSelector = [
    'img',
    '[role="img"]',
    '[data-visualcompletion="media-vc-image"]',
    '[style*="background-image"]',
  ].join(', ');
  const page = {
    locator(selector) {
      if (selector === '[role="article"]') {
        return {
          async count() { return 1; },
          nth() {
            return {
              async isVisible() { return true; },
              async innerText() { return `${title}\nCHIPING.CO.IL`; },
              locator(innerSelector) {
                if (innerSelector === 'a[href], [data-lynx-uri]') {
                  return { async evaluateAll() { return []; } };
                }
                assert.equal(innerSelector, mediaSelector);
                return {
                  async evaluateAll() {
                    return [{
                      width: 500,
                      height: 262,
                      visible: true,
                      imageLoaded: false,
                      clickable: true,
                    }];
                  },
                };
              },
            };
          },
        };
      }
      assert.equal(selector, 'body');
      return {
        async evaluate() {
          return {
            titleFound: false,
            hrefs: [],
            timestampMarked: false,
            diagnosticLinks: [],
            diagnosticControls: [],
          };
        },
      };
    },
  };

  assert.deepEqual(await findFacebookGroupPostViaLinkCardTitle(page, title, {
    requireLoadedLinkImage: true,
  }), { found: false, postUrl: '' });
});

test('Facebook post verification checks the current feed before opening search', async () => {
  const title = '\u05e2\u05e8\u05db\u05ea \u05de\u05e0\u05d9\u05e7\u05d5\u05e8 \u05d5\u05e4\u05d3\u05d9\u05e7\u05d5\u05e8 Beurer MP 64';
  let navigated = false;
  const mediaSelector = [
    'img',
    '[role="img"]',
    '[data-visualcompletion="media-vc-image"]',
    '[style*="background-image"]',
  ].join(', ');
  const article = {
    async isVisible() { return true; },
    async innerText() { return `${title}\nCHIPING.CO.IL`; },
    locator(selector) {
      if (selector === 'a[href], [data-lynx-uri]') {
        return {
          async evaluateAll() {
            return ['https://www.facebook.com/groups/chiping/posts/10463/'];
          },
        };
      }
      assert.equal(selector, mediaSelector);
      return {
        async evaluateAll() {
          return [{
            width: 500,
            height: 262,
            visible: true,
            imageLoaded: true,
            clickable: true,
            clickTargets: ['https://www.chiping.co.il/?item=10463&fb_preview=fresh'],
          }];
        },
      };
    },
  };
  const page = {
    async goto() { navigated = true; },
    locator(selector) {
      assert.equal(selector, '[role="article"]');
      return {
        async count() { return 1; },
        nth() { return article; },
      };
    },
  };

  assert.deepEqual(await findFacebookGroupPostWithMediaFallback(page, {
    groupUrl: 'https://www.facebook.com/groups/chiping',
    itemUrl: 'https://www.chiping.co.il/?item=10463',
    expectedTitle: title,
    requireLoadedLinkImage: true,
  }), {
    found: true,
    postUrl: 'https://www.facebook.com/groups/chiping/posts/10463/',
  });
  assert.equal(navigated, false);
});

test('Facebook post verification finds a minimal card by its exact queued description', async () => {
  const title = '\u05de\u05d0\u05e8\u05d6 \u05de\u05d2\u05d1\u05d5\u05e0\u05d9\u05dd Pampers Sensitive';
  const message = '\u05de\u05d2\u05d1\u05d5\u05e0\u05d9\u05dd \u05e2\u05d1\u05d9\u05dd \u05d5\u05e2\u05d3\u05d9\u05e0\u05d9\u05dd \u05dc\u05e0\u05d9\u05e7\u05d5\u05d9 \u05e0\u05d5\u05d7 \u05d1\u05db\u05dc \u05e9\u05d9\u05de\u05d5\u05e9';
  const mediaSelector = [
    'img',
    '[role="img"]',
    '[data-visualcompletion="media-vc-image"]',
    '[style*="background-image"]',
  ].join(', ');
  const article = {
    async isVisible() { return true; },
    async innerText() { return `${message}\n\u05dc\u05e4\u05e8\u05d8\u05d9 \u05d4\u05d3\u05d9\u05dc\nCHIPING.CO.IL`; },
    locator(selector) {
      if (selector === 'a[href], [data-lynx-uri]') {
        return {
          async evaluateAll() {
            return ['https://www.facebook.com/groups/chiping/posts/10670/'];
          },
        };
      }
      assert.equal(selector, mediaSelector);
      return {
        async evaluateAll() {
          return [{
            width: 500,
            height: 262,
            visible: true,
            imageLoaded: true,
            clickable: true,
            clickTargets: ['https://www.facebook.com/l.php?opaque=1'],
          }];
        },
      };
    },
  };
  const page = {
    locator(selector) {
      if (selector === '[role="article"]') {
        return {
          async count() { return 1; },
          nth() { return article; },
        };
      }
      assert.equal(selector, 'body');
      return {
        async evaluate() {
          return {
            titleFound: false,
            hrefs: [],
            timestampMarked: false,
            diagnosticLinks: [],
            diagnosticControls: [],
          };
        },
      };
    },
  };

  assert.deepEqual(await findFacebookGroupPostWithMediaFallback(page, {
    groupUrl: 'https://www.facebook.com/groups/chiping',
    itemUrl: 'https://www.chiping.co.il/?item=10670',
    expectedTitle: title,
    expectedMessage: message,
    requireLoadedLinkImage: true,
    currentPageOnly: true,
  }), {
    found: true,
    postUrl: 'https://www.facebook.com/groups/chiping/posts/10670/',
  });
});

test('Facebook loaded-card verification rejects a different Chiping item', async () => {
  const title = '\u05de\u05db\u05d5\u05e0\u05ea \u05d0\u05e1\u05e4\u05e8\u05e1\u05d5 Melitta Caffeo Solo';
  const mediaSelector = [
    'img',
    '[role="img"]',
    '[data-visualcompletion="media-vc-image"]',
    '[style*="background-image"]',
  ].join(', ');
  const article = {
    async isVisible() { return true; },
    async innerText() { return `${title}\nCHIPING.CO.IL`; },
    locator(selector) {
      if (selector === 'a[href], [data-lynx-uri]') {
        return {
          async evaluateAll() {
            return ['https://www.facebook.com/groups/chiping/posts/10646/'];
          },
        };
      }
      assert.equal(selector, mediaSelector);
      return {
        async evaluateAll() {
          return [{
            width: 500,
            height: 262,
            visible: true,
            imageLoaded: true,
            clickable: true,
            clickTargets: ['https://www.chiping.co.il/?item=10646'],
          }];
        },
      };
    },
  };
  const page = {
    locator(selector) {
      if (selector === 'body') {
        return {
          async evaluate() {
            return {
              titleFound: false,
              hrefs: [],
              timestampMarked: false,
              diagnosticLinks: [],
              diagnosticControls: [],
            };
          },
        };
      }
      assert.equal(selector, '[role="article"]');
      return {
        async count() { return 1; },
        nth() { return article; },
      };
    },
  };

  assert.deepEqual(await findFacebookGroupPostWithMediaFallback(page, {
    groupUrl: 'https://www.facebook.com/groups/chiping',
    itemUrl: 'https://www.chiping.co.il/?item=10675',
    expectedTitle: title,
    requireLoadedLinkImage: true,
    currentPageOnly: true,
  }), {
    found: false,
    postUrl: 'https://www.facebook.com/groups/chiping/posts/10646/',
    incomplete: true,
  });
});

test('Facebook link-card verification falls through to DOM permalink recovery', async () => {
  const title = '\u05e7\u05d5\u05e4\u05d5\u05e0\u05d9 AliExpress \u05d4\u05d7\u05d3\u05e9\u05d9\u05dd \u05db\u05d1\u05e8 \u05db\u05d0\u05df';
  const article = {
    async isVisible() { return true; },
    async innerText() { return `${title}\nCHIPING.CO.IL`; },
    locator() {
      return {
        async evaluateAll() { return ['https://www.facebook.com/groups/chiping']; },
      };
    },
  };
  const page = {
    locator(selector) {
      if (selector === '[role="article"]') {
        return {
          async count() { return 1; },
          nth() { return article; },
        };
      }
      if (selector === 'body') {
        return {
          async evaluate() {
            return {
              titleFound: true,
              hrefs: ['https://www.facebook.com/groups/chiping/posts/555/'],
              timestampMarked: false,
              diagnosticLinks: [],
              diagnosticControls: [],
            };
          },
        };
      }
      throw new Error(`Unexpected title recovery selector: ${selector}`);
    },
  };

  assert.deepEqual(await findFacebookGroupPostViaLinkCardTitle(page, title), {
    found: true,
    postUrl: 'https://www.facebook.com/groups/chiping/posts/555/',
  });
});

test('Facebook exact-link matches without anchors continue to title permalink recovery', async () => {
  const title = '\u05e7\u05d5\u05e4\u05d5\u05e0\u05d9 AliExpress \u05d4\u05d7\u05d3\u05e9\u05d9\u05dd \u05db\u05d1\u05e8 \u05db\u05d0\u05df';
  const page = {
    async waitForTimeout() {},
    async evaluate() {},
    locator(selector) {
      if (selector === '[role="article"]') {
        return { async count() { return 0; } };
      }
      if (selector === 'a[href], [data-lynx-uri]') {
        return {
          async evaluateAll() { return { targetFound: true, hrefs: [] }; },
        };
      }
      if (selector === 'body') {
        return {
          async evaluate() {
            return {
              titleFound: true,
              hrefs: ['https://www.facebook.com/groups/chiping/posts/666/'],
              timestampMarked: false,
              diagnosticLinks: [],
              diagnosticControls: [],
            };
          },
        };
      }
      if (selector === 'a[href]:has(img)') {
        throw new Error('media fallback must not run after title permalink recovery');
      }
      throw new Error(`Unexpected exact-link recovery selector: ${selector}`);
    },
  };

  assert.deepEqual(await findFacebookGroupPostWithMediaFallback(page, {
    groupUrl: 'https://www.facebook.com/groups/chiping',
    itemUrl: 'https://www.chiping.co.il/?coupons=1',
    expectedTitle: title,
    timeoutMs: 5000,
    currentPageOnly: true,
  }), {
    found: true,
    postUrl: 'https://www.facebook.com/groups/chiping/posts/666/',
  });
});

test('Facebook post verification can recover a link card outside role=article containers', async () => {
  const title = '\u05e2\u05e8\u05db\u05ea \u05d8\u05d9\u05e4\u05d5\u05d7 \u05dc\u05e9\u05d9\u05e2\u05e8 Pantene Molecular Bond Repair';
  const page = {
    locator(selector) {
      if (selector === '[role="article"]') {
        return {
          async count() { return 0; },
        };
      }
      assert.equal(selector, 'body');
      return {
        async evaluate(_callback, tokens) {
          assert.deepEqual(tokens, [
            '\u05e2\u05e8\u05db\u05ea',
            '\u05d8\u05d9\u05e4\u05d5\u05d7',
            '\u05dc\u05e9\u05d9\u05e2\u05e8',
            'pantene',
            'molecular',
            'bond',
            'repair',
          ]);
          return {
            titleFound: true,
            hrefs: ['https://www.facebook.com/groups/chiping/?multi_permalinks=333444555'],
          };
        },
      };
    },
  };

  assert.deepEqual(await findFacebookGroupPostViaLinkCardTitle(page, title), {
    found: true,
    postUrl: 'https://www.facebook.com/groups/chiping/posts/333444555/',
  });
});

test('Facebook post verification opens a non-anchor timestamp to recover the permalink', async () => {
  let currentUrl = 'https://www.facebook.com/groups/chiping';
  const page = {
    locator(selector) {
      if (selector === '[role="article"]') {
        return {
          async count() { return 0; },
        };
      }
      if (selector === 'body') {
        return {
          async evaluate() {
            return {
              titleFound: true,
              hrefs: [],
              timestampMarked: true,
              diagnosticLinks: [],
            };
          },
        };
      }
      if (selector === 'a[href]') {
        return { async evaluateAll() { return []; } };
      }
      assert.equal(selector, '[data-chiping-post-timestamp-probe="true"]');
      return {
        first() {
          return {
            async click() {
              currentUrl = 'https://www.facebook.com/groups/chiping/?multi_permalinks=444555666';
            },
          };
        },
      };
    },
    async waitForTimeout() {},
    context() {
      return { pages() { return [page]; } };
    },
    url() { return currentUrl; },
  };

  assert.deepEqual(await findFacebookGroupPostViaLinkCardTitle(
    page,
    '\u05e2\u05e8\u05db\u05ea \u05d8\u05d9\u05e4\u05d5\u05d7 \u05dc\u05e9\u05d9\u05e2\u05e8 Pantene Molecular Bond Repair'
  ), {
    found: true,
    postUrl: 'https://www.facebook.com/groups/chiping/posts/444555666/',
  });
  const source = await readFile(new URL('../src/facebook.mjs', import.meta.url), 'utf8');
  assert.match(source, /rawText\.includes\('\\u034f'\)/);
  assert.match(source, /facebookRootLink/);
});

test('Facebook post verification finds a permalink rendered after timestamp click', async () => {
  let timestampOpened = false;
  const page = {
    locator(selector) {
      if (selector === '[role="article"]') return { async count() { return 0; } };
      if (selector === 'body') {
        return {
          async evaluate() {
            return {
              titleFound: true,
              hrefs: [],
              timestampMarked: true,
              diagnosticLinks: [],
              diagnosticControls: [],
            };
          },
        };
      }
      if (selector === '[data-chiping-post-timestamp-probe="true"]') {
        return {
          first() {
            return { async click() { timestampOpened = true; } };
          },
        };
      }
      if (selector === 'a[href]') {
        return {
          async evaluateAll() {
            return timestampOpened
              ? ['https://www.facebook.com/groups/chiping/posts/777888999/']
              : [];
          },
        };
      }
      throw new Error(`Unexpected timestamp modal selector: ${selector}`);
    },
    async waitForTimeout() {},
    context() { return { pages() { return [page]; } }; },
    url() { return 'https://www.facebook.com/groups/chiping'; },
  };

  assert.deepEqual(await findFacebookGroupPostViaLinkCardTitle(
    page,
    'זוג מברשות שיניים חשמליות Oral-B iO2'
  ), {
    found: true,
    postUrl: 'https://www.facebook.com/groups/chiping/posts/777888999/',
  });
});

test('Facebook post verification expands collapsed text before matching the item URL', async () => {
  let expanded = false;
  const hidden = { async isVisible() { return false; } };
  const page = {
    async waitForTimeout() {},
    locator(selector) {
      assert.equal(selector, '[role="article"]');
      return {
        async count() { return 1; },
        nth() {
          return {
            async isVisible() { return true; },
            async innerText() {
              return expanded
                ? 'Deal https://www.chiping.co.il/?item=9301'
                : 'Deal... See more';
            },
            locator(innerSelector) {
              if (innerSelector === 'a[href]') {
                return {
                  async evaluateAll() {
                    return expanded
                      ? ['https://www.facebook.com/groups/chiping/posts/555/']
                      : [];
                  },
                };
              }
              return {
                async count() { return 1; },
                nth() {
                  return {
                    async isVisible() { return true; },
                    async click() { expanded = true; },
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  assert.deepEqual(await findFacebookGroupPostOnPage(page, {
    groupUrl: 'https://www.facebook.com/groups/chiping',
    itemUrl: 'https://www.chiping.co.il/?item=9301',
    timeoutMs: 5000,
    currentPageOnly: true,
  }), {
    found: true,
    postUrl: 'https://www.facebook.com/groups/chiping/posts/555/',
  });
  assert.equal(expanded, true);
});

test('Facebook post verification does not confuse a closed composer with a published post', async () => {
  let scrolls = 0;
  const page = {
    async goto() {},
    async waitForTimeout() {},
    async evaluate() { scrolls += 1; },
    locator(selector) {
      assert.equal(selector, '[role="article"]');
      return {
        async count() { return 1; },
        nth() {
          return {
            async isVisible() { return true; },
            async innerText() { return 'https://www.chiping.co.il/?item=9301'; },
            locator() {
              return {
                async evaluateAll() { return []; },
              };
            },
          };
        },
      };
    },
  };

  assert.deepEqual(await findFacebookGroupPostOnPage(page, {
    groupUrl: 'https://www.facebook.com/groups/chiping',
    itemUrl: 'https://www.chiping.co.il/?item=9301',
    timeoutMs: 5000,
  }), { found: false, postUrl: '' });
  assert.ok(scrolls > 0);
});

test('Facebook post verification tolerates Facebook replacing an in-flight document', async () => {
  let navigationAttempts = 0;
  let scans = 0;
  const page = {
    url: () => 'https://www.facebook.com/groups/chiping/search/?q=9301',
    async goto() {
      navigationAttempts += 1;
      throw new Error('page.goto: net::ERR_ABORTED; maybe frame was detached?');
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
    locator(selector) {
      assert.equal(selector, '[role="article"]');
      return {
        async count() { return 1; },
        nth() {
          scans += 1;
          return {
            async isVisible() { return true; },
            async innerText() {
              return scans <= 2 ? 'No matching item yet' : 'https://www.chiping.co.il/?item=9301';
            },
            locator() {
              return {
                async evaluateAll() {
                  return scans <= 2
                    ? []
                    : ['https://www.facebook.com/groups/chiping/posts/333/'];
                },
              };
            },
          };
        },
      };
    },
  };

  assert.deepEqual(await findFacebookGroupPostOnPage(page, {
    groupUrl: 'https://www.facebook.com/groups/chiping',
    itemUrl: 'https://www.chiping.co.il/?item=9301',
    timeoutMs: 5000,
  }), {
    found: true,
    postUrl: 'https://www.facebook.com/groups/chiping/posts/333/',
  });
  assert.equal(navigationAttempts, 1);
});

test('Facebook post verification follows the replacement tab Facebook opens', async () => {
  let originalScans = 0;
  const articleLocator = (matching) => ({
    async count() { return matching ? 1 : 0; },
    nth() {
      return {
        async isVisible() { return true; },
        async innerText() { return 'https://www.chiping.co.il/?item=9301'; },
        locator() {
          return {
            async evaluateAll() {
              return ['https://www.facebook.com/groups/chiping/posts/444/'];
            },
          };
        },
      };
    },
  });
  const replacement = {
    isClosed: () => false,
    async waitForTimeout() {},
    locator(selector) {
      assert.equal(selector, '[role="article"]');
      return articleLocator(true);
    },
  };
  const context = {
    pages: () => [replacement],
  };
  const original = {
    url: () => 'https://www.facebook.com/groups/chiping',
    context: () => context,
    isClosed: () => true,
    async goto() {
      throw new Error('page.goto: Target page, context or browser has been closed');
    },
    async waitForTimeout() {},
    locator(selector) {
      assert.equal(selector, '[role="article"]');
      originalScans += 1;
      return articleLocator(false);
    },
  };

  assert.deepEqual(await findFacebookGroupPostOnPage(original, {
    groupUrl: 'https://www.facebook.com/groups/chiping',
    itemUrl: 'https://www.chiping.co.il/?item=9301',
    timeoutMs: 5000,
  }), {
    found: true,
    postUrl: 'https://www.facebook.com/groups/chiping/posts/444/',
  });
  assert.equal(originalScans, 2);
});

test('Facebook post verification searches by the published title when the item query is stripped', async () => {
  const navigations = [];
  const page = {
    url: () => 'https://www.facebook.com/groups/chiping',
    async goto(url) { navigations.push(url); },
    async waitForLoadState() {},
    async waitForTimeout() {},
    locator(selector) {
      assert.equal(selector, '[role="article"]');
      return { async count() { return 0; } };
    },
  };

  await findFacebookGroupPostOnPage(page, {
    groupUrl: 'https://www.facebook.com/groups/chiping',
    itemUrl: 'https://www.chiping.co.il/?item=10432',
    searchTerm: 'זוג מברשות שיניים חשמליות Oral-B iO2',
    timeoutMs: 5000,
  });

  assert.equal(
    navigations[0],
    'https://www.facebook.com/groups/chiping/search/?q=%D7%96%D7%95%D7%92%20%D7%9E%D7%91%D7%A8%D7%A9%D7%95%D7%AA%20%D7%A9%D7%99%D7%A0%D7%99%D7%99%D7%9D%20%D7%97%D7%A9%D7%9E%D7%9C%D7%99%D7%95%D7%AA%20Oral-B%20iO2'
  );
});

test('Facebook post verification preserves an exact match while its permalink is pending', async () => {
  let mediaScanned = false;
  const page = {
    async waitForTimeout() {},
    async evaluate() {},
    locator(selector) {
      if (selector === '[role="article"]') {
        return { async count() { return 0; } };
      }
      if (selector === 'a[href], [data-lynx-uri]') {
        return {
          async evaluateAll() {
            return { targetFound: false, hrefs: [] };
          },
        };
      }
      if (selector === 'body') {
        return {
          async evaluate() {
            return {
              titleFound: true,
              hrefs: [],
              timestampMarked: false,
              diagnosticLinks: [],
              diagnosticControls: [],
            };
          },
        };
      }
      if (selector === 'a[href]:has(img)') {
        mediaScanned = true;
        return { async evaluateAll() { return []; } };
      }
      throw new Error(`Unexpected exact-match selector: ${selector}`);
    },
  };

  assert.deepEqual(await findFacebookGroupPostWithMediaFallback(page, {
    groupUrl: 'https://www.facebook.com/groups/chiping',
    itemUrl: 'https://www.chiping.co.il/?item=9301',
    expectedTitle: '\u05d3\u05d9\u05dc \u05d1\u05d3\u05d9\u05e7\u05d4',
    timeoutMs: 5000,
    currentPageOnly: true,
  }), { found: true, postUrl: '' });
  assert.equal(mediaScanned, false);
});

test('Facebook post verification checks media before a stale group feed can cause a duplicate', async () => {
  let openedMedia = 0;
  const candidatePage = {
    async goto(url) {
      openedMedia += 1;
      assert.equal(
        url,
        'https://www.facebook.com/photo/?fbid=123456&set=g.421300648875078'
      );
    },
    async waitForTimeout() {},
    async close() {},
    locator(selector) {
      if (selector === '[role="article"]') {
        return { async count() { return 0; } };
      }
      if (selector === 'body') {
        return {
          async innerText() {
            return 'Existing deal https://www.chiping.co.il/?item=9301';
          },
        };
      }
      if (selector === 'a[href]') {
        return { async evaluateAll() { return []; } };
      }
      throw new Error(`Unexpected candidate selector: ${selector}`);
    },
  };
  const page = {
    async waitForTimeout() {},
    async evaluate() {},
    context() {
      return {
        async newPage() { return candidatePage; },
      };
    },
    locator(selector) {
      if (selector === '[role="article"]') {
        return { async count() { return 0; } };
      }
      if (selector === 'a[href]:has(img)') {
        return {
          async evaluateAll() {
            return [
              'https://www.facebook.com/photo/?fbid=123456&set=g.421300648875078',
            ];
          },
        };
      }
      throw new Error(`Unexpected group selector: ${selector}`);
    },
  };

  assert.deepEqual(await findFacebookGroupPostWithMediaFallback(page, {
    groupUrl: 'https://www.facebook.com/groups/chiping',
    itemUrl: 'https://www.chiping.co.il/?item=9301',
    timeoutMs: 5000,
    currentPageOnly: true,
  }), {
    found: true,
    postUrl: 'https://www.facebook.com/photo/?fbid=123456&set=g.421300648875078',
  });
  assert.equal(openedMedia, 1);
});

test('Facebook media fallback does not match a different Chiping item', async () => {
  const candidatePage = {
    async goto() {},
    async waitForTimeout() {},
    async close() {},
    locator(selector) {
      if (selector === '[role="article"]') {
        return { async count() { return 0; } };
      }
      if (selector === 'body') {
        return {
          async innerText() {
            return 'Different deal https://www.chiping.co.il/?item=93010';
          },
        };
      }
      if (selector === 'a[href]') {
        return { async evaluateAll() { return []; } };
      }
      throw new Error(`Unexpected candidate selector: ${selector}`);
    },
  };
  const page = {
    async waitForTimeout() {},
    async evaluate() {},
    context() {
      return {
        async newPage() { return candidatePage; },
      };
    },
    locator(selector) {
      if (selector === '[role="article"]') {
        return { async count() { return 0; } };
      }
      if (selector === 'a[href]:has(img)') {
        return {
          async evaluateAll() {
            return ['https://www.facebook.com/photo/?fbid=654321&set=g.421300648875078'];
          },
        };
      }
      throw new Error(`Unexpected group selector: ${selector}`);
    },
  };

  assert.deepEqual(await findFacebookGroupPostWithMediaFallback(page, {
    groupUrl: 'https://www.facebook.com/groups/chiping',
    itemUrl: 'https://www.chiping.co.il/?item=9301',
    timeoutMs: 5000,
    currentPageOnly: true,
  }), { found: false, postUrl: '' });
});

test('Chiping link-preview metadata must expose the exact prepared 1200x630 image', async () => {
  const itemUrl = 'https://www.chiping.co.il/?item=9301';
  const imageUrl = 'https://cdn.example.test/facebook-link-9301.jpg';
  const fetchImpl = async (url, options) => {
    assert.equal(url, itemUrl);
    assert.match(options.headers['User-Agent'], /facebookexternalhit/);
    return new Response(`<!doctype html><html><head>
      <meta property="og:url" content="${itemUrl}">
      <meta property="og:image" content="${imageUrl}">
      <meta property="og:image:width" content="1200">
      <meta property="og:image:height" content="630">
    </head></html>`);
  };

  assert.deepEqual(
    await validateChipingLinkPreviewMetadata(itemUrl, imageUrl, fetchImpl),
    {
      canonicalUrl: itemUrl,
      imageUrl,
      imageWidth: 1200,
      imageHeight: 630,
    }
  );
});

test('Chiping link-preview metadata rejects a stale product image', async () => {
  const itemUrl = 'https://www.chiping.co.il/?item=9301';
  const fetchImpl = async () => new Response(`<!doctype html><html><head>
    <meta property="og:url" content="${itemUrl}">
    <meta property="og:image" content="https://cdn.example.test/old-product.jpg">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
  </head></html>`);

  await assert.rejects(
    validateChipingLinkPreviewMetadata(
      itemUrl,
      'https://cdn.example.test/facebook-link-9301.jpg',
      fetchImpl
    ),
    /has not exposed the prepared Facebook image/
  );
});

test('Chiping link-preview metadata permanently rejects an unavailable item', async () => {
  await assert.rejects(
    waitForChipingLinkPreviewMetadata(
      'https://www.chiping.co.il/?item=10807',
      'https://www.chiping.co.il/facebook-images/10807.jpg?v=stale',
      async () => new Response('', { status: 404 }),
      { attempts: 4, delayMs: 1 }
    ),
    FacebookPostUnavailableError
  );
});

test('Chiping link-preview metadata accepts a newer generated image version for the same item', async () => {
  const itemUrl = 'https://www.chiping.co.il/?item=10432';
  const currentImageUrl = 'https://www.chiping.co.il/facebook-images/10432.jpg?v=current';
  const fetchImpl = async () => new Response(`<!doctype html><html><head>
    <meta property="og:url" content="${itemUrl}">
    <meta property="og:image" content="${currentImageUrl}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
  </head></html>`);

  const result = await validateChipingLinkPreviewMetadata(
    itemUrl,
    'https://www.chiping.co.il/facebook-images/10432.jpg?v=queued',
    fetchImpl
  );

  assert.equal(result.imageUrl, currentImageUrl);
});

test('Chiping link-preview metadata rejects a generated image belonging to another item', async () => {
  const itemUrl = 'https://www.chiping.co.il/?item=10432';
  const fetchImpl = async () => new Response(`<!doctype html><html><head>
    <meta property="og:url" content="${itemUrl}">
    <meta property="og:image" content="https://www.chiping.co.il/facebook-images/10431.jpg?v=current">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
  </head></html>`);

  await assert.rejects(
    validateChipingLinkPreviewMetadata(
      itemUrl,
      'https://www.chiping.co.il/facebook-images/10432.jpg?v=queued',
      fetchImpl
    ),
    /has not exposed the prepared Facebook image/
  );
});

test('Chiping link-preview metadata retries a transient stale crawler response', async () => {
  const itemUrl = 'https://www.chiping.co.il/?item=10486';
  const imageUrl = 'https://cdn.example.test/facebook-link-10486.jpg';
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls += 1;
    assert.equal(url, itemUrl);
    assert.equal(options.headers['Cache-Control'], 'no-cache');
    assert.equal(options.headers.Pragma, 'no-cache');
    const currentImage = calls < 3
      ? 'https://cdn.example.test/stale-product.jpg'
      : imageUrl;
    return new Response(`<!doctype html><html><head>
      <meta property="og:url" content="${itemUrl}">
      <meta property="og:image" content="${currentImage}">
      <meta property="og:image:width" content="1200">
      <meta property="og:image:height" content="630">
    </head></html>`);
  };

  const result = await waitForChipingLinkPreviewMetadata(itemUrl, imageUrl, fetchImpl, {
    attempts: 3,
    delayMs: 1,
    sleep: async () => {},
  });

  assert.equal(calls, 3);
  assert.equal(result.imageUrl, imageUrl);
});

test('Facebook composer requires a rendered Chiping link card before publishing', async () => {
  const visualSelector = [
    'a[href]',
    '[role="link"]',
    'img',
    '[role="img"]',
    '[data-visualcompletion="media-vc-image"]',
    '[style*="background-image"]',
  ].join(', ');
  const dialog = {
    async innerText() {
      return [
        'https://www.chiping.co.il/?item=9301',
        'chiping.co.il',
      ].join('\n');
    },
    locator(selector) {
      if (selector === 'a[href]') {
        return {
          async evaluateAll() {
            return ['https://www.chiping.co.il/?item=9301'];
          },
        };
      }
      if (selector === visualSelector) {
        return {
          async evaluateAll() {
            return [{
              width: 540,
              height: 284,
              visible: true,
              tagName: 'A',
              role: '',
              clickTargets: ['https://www.chiping.co.il/?item=9301'],
            }];
          },
        };
      }
      throw new Error(`Unexpected preview selector: ${selector}`);
    },
  };
  const page = {
    locator(selector) {
      assert.equal(selector, '[role="dialog"]');
      return { last() { return dialog; } };
    },
    async waitForTimeout() {},
  };

  const result = await waitForFacebookLinkPreview(
    page,
    'https://www.chiping.co.il/?item=9301'
  );
  assert.equal(result.hasTargetAnchor, true);
  assert.equal(result.visualMetrics[0].width, 540);
});

test('Facebook composer rejects a large placeholder until the preview image is loaded', () => {
  const placeholder = [{
    width: 500,
    height: 261,
    visible: true,
    tagName: 'IMG',
    imageLoaded: false,
  }];
  const loaded = [{ ...placeholder[0], imageLoaded: true }];

  assert.equal(hasLoadedFacebookPreviewVisual(placeholder), false);
  assert.equal(hasLoadedFacebookPreviewVisual(loaded), true);
});

test('published Facebook posts require a loaded clickable link-card image', () => {
  assert.equal(hasLoadedFacebookPostLinkImage([{
    width: 500,
    height: 262,
    visible: true,
    imageLoaded: true,
    clickable: true,
  }]), true);
  assert.equal(hasLoadedFacebookPostLinkImage([{
    width: 500,
    height: 262,
    visible: true,
    imageLoaded: false,
    clickable: true,
  }]), false);
  assert.equal(hasLoadedFacebookPostLinkImage([{
    width: 500,
    height: 262,
    visible: true,
    imageLoaded: true,
    clickable: false,
  }]), false);
  const target = { type: 'item', value: '10463' };
  assert.equal(hasLoadedFacebookPostLinkImage([{
    width: 500,
    height: 262,
    visible: true,
    imageLoaded: true,
    clickable: true,
    clickTargets: ['https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.chiping.co.il%2F%3Fitem%3D10463%26fb_preview%3Dfresh'],
  }], target), true);
  assert.equal(hasLoadedFacebookPostLinkImage([{
    width: 500,
    height: 262,
    visible: true,
    imageLoaded: true,
    clickable: true,
    clickTargets: ['https://www.chiping.co.il/?item=10464'],
  }], target), false);
});

test('Facebook product image click opens the exact Chiping item', async () => {
  const title = '\u05e2\u05e8\u05db\u05ea \u05de\u05e0\u05d9\u05e7\u05d5\u05e8 \u05d5\u05e4\u05d3\u05d9\u05e7\u05d5\u05e8 Beurer MP 64';
  let currentUrl = 'https://www.facebook.com/groups/chiping/posts/1760303761641420/';
  const image = {
    async click() {
      currentUrl = 'https://www.chiping.co.il/?item=10463&fbclid=verified';
    },
  };
  const media = {
    async evaluateAll() {
      return [{ index: 0, loaded: true, clickable: true }];
    },
    nth() { return image; },
  };
  const article = {
    async isVisible() { return true; },
    async innerText() { return `${title}\nCHIPING.CO.IL`; },
    locator() { return media; },
  };
  const page = {
    url() { return currentUrl; },
    context() { return { pages: () => [page] }; },
    async waitForTimeout() {},
    locator(selector) {
      assert.equal(selector, '[role="article"]');
      return {
        async count() { return 1; },
        nth() { return article; },
      };
    },
  };

  assert.deepEqual(await verifyFacebookPostImageDestination(page, {
    expectedTitle: title,
    itemUrl: 'https://www.chiping.co.il/?item=10463',
  }), {
    verified: true,
    destinationUrl: 'https://www.chiping.co.il/?item=10463&fbclid=verified',
    observedUrls: ['https://www.chiping.co.il/?item=10463&fbclid=verified'],
  });
});

test('Facebook product image verification accepts a minimal link title only for the exact item URL', async () => {
  const title = '\u05e2\u05e8\u05db\u05ea \u05de\u05e0\u05d9\u05e7\u05d5\u05e8 \u05d5\u05e4\u05d3\u05d9\u05e7\u05d5\u05e8 Beurer MP 64';
  let currentUrl = 'https://www.facebook.com/groups/chiping/posts/1760303761641420/';
  const image = {
    async click() {
      currentUrl = 'https://www.chiping.co.il/?item=10463&fbclid=verified';
    },
  };
  const article = {
    async isVisible() { return true; },
    async innerText() { return '\u05dc\u05e4\u05e8\u05d8\u05d9 \u05d4\u05d3\u05d9\u05dc\nCHIPING.CO.IL'; },
    locator(selector) {
      if (selector === 'a[href], [data-lynx-uri]') {
        return {
          async evaluateAll() {
            return ['https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.chiping.co.il%2F%3Fitem%3D10463'];
          },
        };
      }
      return {
        async evaluateAll() { return [{ index: 0, loaded: true, clickable: true }]; },
        nth() { return image; },
      };
    },
  };
  const page = {
    url() { return currentUrl; },
    context() { return { pages: () => [page] }; },
    async waitForTimeout() {},
    locator(selector) {
      if (selector === '[role="article"]') {
        return {
          async count() { return 1; },
          nth() { return article; },
        };
      }
      assert.equal(selector, '[role="dialog"]');
      return { async count() { return 0; } };
    },
  };

  const result = await verifyFacebookPostImageDestination(page, {
    expectedTitle: title,
    itemUrl: 'https://www.chiping.co.il/?item=10463',
  });
  assert.equal(result.verified, true);
  assert.match(result.destinationUrl, /item=10463/);
});

test('Facebook product image verification uses the queued description but still requires the exact item', async () => {
  const message = '\u05de\u05d2\u05d1\u05d5\u05e0\u05d9\u05dd \u05e2\u05d1\u05d9\u05dd \u05d5\u05e2\u05d3\u05d9\u05e0\u05d9\u05dd \u05dc\u05e0\u05d9\u05e7\u05d5\u05d9 \u05e0\u05d5\u05d7 \u05d1\u05db\u05dc \u05e9\u05d9\u05de\u05d5\u05e9';
  let currentUrl = 'https://www.facebook.com/groups/chiping/posts/10670/';
  const image = {
    async click() {
      currentUrl = 'https://www.chiping.co.il/?item=10671&fbclid=wrong-item';
    },
  };
  const media = {
    async evaluateAll() {
      return [{ index: 0, loaded: true, clickable: true, area: 131000 }];
    },
    nth() { return image; },
  };
  const article = {
    async isVisible() { return true; },
    async innerText() { return `${message}\n\u05dc\u05e4\u05e8\u05d8\u05d9 \u05d4\u05d3\u05d9\u05dc\nCHIPING.CO.IL`; },
    locator() { return media; },
  };
  const page = {
    url() { return currentUrl; },
    context() { return { pages: () => [page] }; },
    async waitForTimeout() {},
    locator(selector) {
      if (selector === '[role="article"]') {
        return {
          async count() { return 1; },
          nth() { return article; },
        };
      }
      if (selector === '[role="dialog"]') return { async count() { return 0; } };
      if (selector === 'body') return { async evaluate() { return null; } };
      throw new Error(`Unexpected description verification selector: ${selector}`);
    },
  };

  const result = await verifyFacebookPostImageDestination(page, {
    expectedTitle: '\u05de\u05d0\u05e8\u05d6 \u05de\u05d2\u05d1\u05d5\u05e0\u05d9\u05dd Pampers Sensitive',
    expectedMessage: message,
    itemUrl: 'https://www.chiping.co.il/?item=10670',
    timeoutMs: 3000,
  });
  assert.equal(result.verified, false);
  assert.ok(result.observedUrls.includes('https://www.chiping.co.il/?item=10671&fbclid=wrong-item'));
});

test('Facebook description verification does not treat a missing title as a match', async () => {
  const message = '\u05ea\u05d9\u05d0\u05d5\u05e8 \u05d9\u05d9\u05d7\u05d5\u05d3\u05d9 \u05dc\u05de\u05d5\u05e6\u05e8 \u05d4\u05de\u05d9\u05d5\u05e2\u05d3';
  let clicked = false;
  const media = {
    async evaluateAll() {
      return [{ index: 0, loaded: true, clickable: true, area: 131000 }];
    },
    nth() {
      return {
        async click() { clicked = true; },
      };
    },
  };
  const article = {
    async isVisible() { return true; },
    async innerText() { return '\u05e4\u05d5\u05e1\u05d8 \u05d0\u05d7\u05e8 \u05dc\u05d2\u05de\u05e8\u05d9\nCHIPING.CO.IL'; },
    locator() { return media; },
  };
  const page = {
    async waitForTimeout() {},
    locator(selector) {
      if (selector === '[role="article"]') {
        return {
          async count() { return 1; },
          nth() { return article; },
        };
      }
      if (selector === '[role="dialog"]') return { async count() { return 0; } };
      if (selector === 'body') return { async evaluate() { return null; } };
      throw new Error(`Unexpected missing-title selector: ${selector}`);
    },
  };

  const result = await verifyFacebookPostImageDestination(page, {
    expectedTitle: '',
    expectedMessage: message,
    itemUrl: 'https://www.chiping.co.il/?item=10670',
    timeoutMs: 3000,
  });
  assert.equal(result.verified, false);
  assert.equal(clicked, false);
});

test('Facebook composer stages a versioned URL while preserving the clean item target', () => {
  assert.equal(
    buildFacebookPreviewShareUrl(
      'https://www.chiping.co.il/?item=10432',
      'https://www.chiping.co.il/facebook-images/10432.jpg?v=411b61b15fcaab1e'
    ),
    'https://www.chiping.co.il/?item=10432&fb_preview=411b61b15fcaab1e'
  );
  assert.equal(
    buildFacebookPreviewShareUrl(
      'https://www.chiping.co.il/?item=10432',
      'https://www.chiping.co.il/facebook-images/10432.jpg?v=411b61b15fcaab1e',
      2
    ),
    'https://www.chiping.co.il/?item=10432&fb_preview=411b61b15fcaab1e-r2'
  );
});

test('Facebook composer recognizes a CSS-backed link card around a contained product image', async () => {
  const dialog = {
    async innerText() {
      return [
        'https://www.chiping.co.il/?item=10042',
        'CHIPING.CO.IL',
      ].join('\n');
    },
    locator(selector) {
      if (selector === 'a[href]') {
        return {
          async evaluateAll() {
            return ['https://l.facebook.com/l.php?u=https%3A%2F%2Fwww.chiping.co.il%2F%3Fitem%3D10042'];
          },
        };
      }
      return {
        async evaluateAll() {
          return [{
            width: 466,
            height: 277,
            visible: true,
            tagName: 'DIV',
            role: 'img',
            clickTargets: ['https://www.chiping.co.il/?item=10042'],
          }];
        },
      };
    },
  };
  const page = {
    locator(selector) {
      assert.equal(selector, '[role="dialog"]');
      return { last() { return dialog; } };
    },
    async waitForTimeout() {},
  };

  const result = await waitForFacebookLinkPreview(
    page,
    'https://www.chiping.co.il/?item=10042'
  );
  assert.equal(result.hasTargetAnchor, true);
  assert.equal(result.hostOccurrences, 2);
  assert.equal(result.visualMetrics[0].role, 'img');
});

test('Facebook link-card validation stays scoped to the textbox composer dialog', async () => {
  const composerDialog = {
    async innerText() {
      return [
        'https://www.chiping.co.il/?item=10042',
        'CHIPING.CO.IL',
      ].join('\n');
    },
    locator(selector) {
      if (selector === 'a[href]') {
        return {
          async evaluateAll() {
            return ['https://www.chiping.co.il/?item=10042'];
          },
        };
      }
      return {
        async evaluateAll() {
          return [{
            width: 466,
            height: 277,
            visible: true,
            tagName: 'DIV',
            role: 'img',
            clickTargets: ['https://www.chiping.co.il/?item=10042'],
          }];
        },
      };
    },
  };
  const unrelatedLastDialog = {
    async innerText() { return ''; },
    locator() {
      return { async evaluateAll() { return []; } };
    },
  };
  const textBox = {
    locator(selector) {
      assert.equal(selector, 'xpath=ancestor::*[@role="dialog"][1]');
      return composerDialog;
    },
  };
  const page = {
    locator(selector) {
      assert.equal(selector, '[role="dialog"]');
      return { last() { return unrelatedLastDialog; } };
    },
    async waitForTimeout() {},
  };

  const result = await waitForFacebookLinkPreview(
    page,
    'https://www.chiping.co.il/?item=10042',
    30000,
    textBox
  );
  assert.equal(result.hasTargetAnchor, true);
});

test('Facebook publisher uses a clickable link preview instead of uploading a photo', async () => {
  const source = await readFile(new URL('../src/facebook.mjs', import.meta.url), 'utf8');
  const publisher = source.slice(
    source.indexOf('export async function postFacebookGroupJob'),
    source.length
  );
  assert.match(publisher, /waitForChipingLinkPreviewMetadata/);
  assert.match(publisher, /prepareFacebookComposerLinkPreview/);
  assert.match(source, /buildFacebookPreviewShareUrl\(payload\.itemUrl, payload\.imageUrl\)/);
  assert.match(publisher, /const expectedTitle = String\(job\.payload\.title \|\| ''\)\.trim\(\) \|\| await fetchChipingLinkPreviewTitle/);
  assert.match(source, /\{ requireLoadedLinkImage: true, requiredItemUrl: itemUrl \}/);
  assert.match(publisher, /if \(existing\.found\)/);
  assert.match(publisher, /verifyFacebookPostImageDestination/);
  assert.match(
    publisher,
    /if \(existing\.incomplete\)[\s\S]*page = await navigateFacebookForVerification\(page, config\.groupUrl\);[\s\S]*const composer = await findFacebookGroupComposer\(page\)/
  );
  const postSubmitVerification = publisher.slice(publisher.indexOf('await postButton.click()'));
  assert.match(postSubmitVerification, /timeoutMs: 60000/);
  assert.match(postSubmitVerification, /currentPageOnly: false/);
  assert.doesNotMatch(publisher, /attachFacebookComposerImage/);
  assert.doesNotMatch(publisher, /downloadImage/);
});

test('posting profile selection is opt-in and read from configuration', () => {
  assert.equal(loadConfig({ FACEBOOK_POSTING_PROFILE_NAME: 'Chiping Deals' }).facebookPostingProfileName, 'Chiping Deals');
  assert.equal(loadConfig({}).facebookPostingProfileName, '');
});

test('automatic login reads credentials only from configured secret files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-poster-'));
  try {
    const emailFile = path.join(directory, 'email');
    const passwordFile = path.join(directory, 'password');
    await writeFile(emailFile, 'admin@example.test\n');
    await writeFile(passwordFile, 'secret-password\n');
    assert.deepEqual(await readLoginCredentials({ facebookLoginEmailFile: emailFile, facebookLoginPasswordFile: passwordFile }), {
      email: 'admin@example.test',
      password: 'secret-password',
    });
    assert.equal(await readLoginCredentials({ facebookLoginEmailFile: emailFile, facebookLoginPasswordFile: '' }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('automatic login stops on a two-step challenge before navigating away', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-poster-'));
  try {
    const emailFile = path.join(directory, 'email');
    const passwordFile = path.join(directory, 'password');
    await writeFile(emailFile, 'admin@example.test');
    await writeFile(passwordFile, 'secret-password');

    let currentUrl = 'https://www.facebook.com/login';
    let groupNavigations = 0;
    const page = {
      url: () => currentUrl,
      waitForTimeout: async () => {},
      goto: async () => { groupNavigations += 1; },
      locator: (selector) => {
        const isEmail = selector.includes('input[name="email"]');
        const isPassword = selector.includes('input[name="pass"]');
        const isSubmit = selector.includes('button[name="login"]');
        return {
          first() { return this; },
          async isVisible() { return isEmail || isPassword; },
          async fill() {},
          async click() {
            if (isSubmit) currentUrl = 'https://www.facebook.com/two_step_verification/authentication/';
          },
          async innerText() {
            return selector === 'body' && currentUrl.includes('two_step_verification')
              ? 'Complete the security check'
              : '';
          },
        };
      },
    };

    await assert.rejects(
      loginIfNeeded(page, {
        groupUrl: 'https://www.facebook.com/groups/chiping',
        facebookLoginEmailFile: emailFile,
        facebookLoginPasswordFile: passwordFile,
      }),
      (error) => error instanceof FacebookSessionRequiredError
        && error.message === 'Facebook requires a security check'
    );
    assert.equal(groupNavigations, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('interactive login ignores a hidden submit control', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-poster-'));
  try {
    const emailFile = path.join(directory, 'email');
    const passwordFile = path.join(directory, 'password');
    await writeFile(emailFile, 'admin@example.test');
    await writeFile(passwordFile, 'secret-password');

    let clickedVisibleSubmit = false;
    let pressedEnter = false;
    let submitSelector = '';
    const input = (kind) => ({
      first() { return this; },
      async isVisible() { return true; },
      async fill() {},
      async press(key) {
        if (kind === 'password' && key === 'Enter') pressedEnter = true;
      },
    });
    const page = {
      locator(selector) {
        if (selector.startsWith('input[name="email"]')) return input('email');
        if (selector.startsWith('input[name="pass"]')) return input('password');
        submitSelector = selector;
        return {
          async count() { return 2; },
          nth(index) {
            return {
              async isVisible() { return index === 1; },
              async click() { clickedVisibleSubmit = true; },
            };
          },
        };
      },
    };

    assert.equal(await fillLoginForm(page, {
      facebookLoginEmailFile: emailFile,
      facebookLoginPasswordFile: passwordFile,
    }), true);
    assert.equal(clickedVisibleSubmit, true);
    assert.equal(pressedEnter, false);
    assert.match(submitSelector, /aria-label="התחברות"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('interactive login continues a remembered Facebook account automatically', async () => {
  let clicked = false;
  const hidden = { async isVisible() { return false; } };
  const collection = (items = []) => ({
    first() { return items[0] || hidden; },
    async count() { return items.length; },
    nth(index) { return items[index]; },
  });
  const page = {
    url: () => 'https://www.facebook.com/login/?next=%2Fgroups%2Fchiping',
    locator(selector) {
      if (selector.includes('input[name="email"]')) return collection();
      if (selector === 'input[name="pass"], input[type="password"]') return collection();
      if (selector.includes('button:has-text("Continue")')) {
        return collection([{
          async isVisible() { return true; },
          async click() { clicked = true; },
        }]);
      }
      return collection();
    },
  };

  assert.equal(await advanceRememberedLogin(page, {}), true);
  assert.equal(clicked, true);
});

test('interactive login fills password-only confirmation from the secret file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-poster-'));
  try {
    const passwordFile = path.join(directory, 'password');
    const emailFile = path.join(directory, 'email');
    await writeFile(emailFile, 'admin@example.test');
    await writeFile(passwordFile, 'secret-password');

    let filledPassword = '';
    let clicked = false;
    const hidden = { async isVisible() { return false; } };
    const collection = (items = []) => ({
      first() { return items[0] || hidden; },
      async count() { return items.length; },
      nth(index) { return items[index]; },
    });
    const page = {
      url: () => 'https://www.facebook.com/?crypted_string=confirmation',
      locator(selector) {
        if (selector.includes('input[name="email"]')) return collection();
        if (selector === 'input[name="pass"], input[type="password"]') {
          return collection([{
            async isVisible() { return true; },
            async fill(value) { filledPassword = value; },
          }]);
        }
        if (selector.includes('button[type="submit"]')) {
          return collection([{
            async isVisible() { return true; },
            async click() { clicked = true; },
          }]);
        }
        return collection();
      },
    };

    assert.equal(await advanceRememberedLogin(page, {
      facebookLoginEmailFile: emailFile,
      facebookLoginPasswordFile: passwordFile,
    }), true);
    assert.equal(filledPassword, 'secret-password');
    assert.equal(clicked, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('current Facebook text-only composer is recognized after scrolling to the top', async () => {
  let scrolledToTop = false;
  let matchedSelector = '';
  const composer = { async isVisible() { return true; } };
  const page = {
    async evaluate() { scrolledToTop = true; },
    async waitForTimeout() {},
    locator(selector) {
      return {
        first() {
          matchedSelector = selector;
          return selector === '[role="button"]:has-text("Write something")'
            ? composer
            : { async isVisible() { return false; } };
        },
      };
    },
  };

  assert.equal(await findFacebookGroupComposer(page), composer);
  assert.equal(scrolledToTop, true);
  assert.equal(matchedSelector, '[role="button"]:has-text("Write something")');
});

test('Facebook composer text lookup ignores visible comment editors', async () => {
  const postEditor = {
    async isVisible() { return true; },
    async getAttribute() { return 'Create a public post'; },
  };
  const commentEditor = {
    async isVisible() { return true; },
    async getAttribute() { return 'Comment as Chi'; },
  };
  const page = {
    locator(selector) {
      assert.equal(selector, '[role="dialog"] [contenteditable="true"][role="textbox"]');
      return {
        async count() { return 2; },
        nth(index) { return [postEditor, commentEditor][index]; },
      };
    },
    async waitForTimeout() {},
  };

  assert.equal(await findFacebookComposerTextBox(page), postEditor);
});

test('Facebook group feed is switched from most relevant to recent posts', async () => {
  let menuOpen = false;
  let selectedRecent = false;
  const hidden = { async isVisible() { return false; } };
  const page = {
    async waitForTimeout() {},
    keyboard: { async press() {} },
    locator(selector) {
      const visibleMostRelevant = selector.includes('Most relevant');
      const visibleRecentOption = menuOpen && selector.includes('Recent posts')
        && !selector.startsWith('[role="button"]');
      return {
        first() {
          if (visibleMostRelevant) {
            return {
              async isVisible() { return true; },
              async click() { menuOpen = true; },
            };
          }
          if (visibleRecentOption) {
            return {
              async isVisible() { return true; },
              async click() { selectedRecent = true; },
            };
          }
          return hidden;
        },
      };
    },
  };

  assert.equal(await sortFacebookGroupFeedNewest(page), true);
  assert.equal(menuOpen, true);
  assert.equal(selectedRecent, true);
});

test('Facebook composer image is attached through its own file chooser', async () => {
  let previewCount = 1;
  let selectedFile = null;
  const image = {
    filename: 'deal.jpg',
    mimeType: 'image/jpeg',
    bytes: Buffer.from('image'),
  };
  const previewImages = {
    async count() { return previewCount; },
  };
  const dialog = {
    locator(selector) {
      assert.equal(selector, 'img');
      return previewImages;
    },
  };
  const photoButton = {
    async isVisible() { return true; },
    async click() {},
  };
  const page = {
    locator(selector) {
      if (selector === '[role="dialog"]') {
        return { last() { return dialog; } };
      }
      return { first() { return photoButton; } };
    },
    async waitForEvent(event) {
      assert.equal(event, 'filechooser');
      return {
        async setFiles(file) {
          selectedFile = file;
          previewCount = 2;
        },
      };
    },
    async waitForTimeout() {},
  };

  await attachFacebookComposerImage(page, image);
  assert.equal(selectedFile.name, 'deal.jpg');
  assert.equal(selectedFile.mimeType, 'image/jpeg');
});

test('Facebook CSS-backed image preview is accepted through its visible controls', async () => {
  let previewReady = false;
  const hidden = { async isVisible() { return false; } };
  const visible = { async isVisible() { return true; }, async click() {} };
  const dialog = {
    locator(selector) {
      assert.equal(selector, 'img');
      return { async count() { return 0; } };
    },
  };
  const page = {
    locator(selector) {
      if (selector === '[role="dialog"]') return { last() { return dialog; } };
      if (selector.includes('Photo/video')) return { first() { return visible; } };
      if (selector.includes('has-text("Edit")')) {
        return { first() { return previewReady ? visible : hidden; } };
      }
      return { first() { return hidden; } };
    },
    async waitForEvent() {
      return {
        async setFiles() { previewReady = true; },
      };
    },
    async waitForTimeout() {},
  };

  await attachFacebookComposerImage(page, {
    filename: 'deal.jpg',
    mimeType: 'image/jpeg',
    bytes: Buffer.from('image'),
  });
  assert.equal(previewReady, true);
});

test('Facebook composer text falls back to keyboard input and verifies retention', async () => {
  let value = '';
  const textBox = {
    async click() {},
    async fill() {},
    async innerText() { return value; },
  };
  const page = {
    async waitForTimeout() {},
    keyboard: {
      async press() {},
      async insertText(text) { value = text; },
    },
  };

  await fillFacebookComposerText(page, textBox, 'Verified deal text');
  assert.equal(value, 'Verified deal text');
});

test('Facebook security detection does not mistake product compatibility for verification', () => {
  assert.equal(
    isFacebookSecurityChallengeText('בזכות התאימות ל-MagSafe תוכלו להטעין בקלות.'),
    false
  );
  assert.equal(isFacebookSecurityChallengeText('נדרש אימות לחשבון Facebook.'), true);
  assert.equal(isFacebookSecurityChallengeText('Complete the security check to continue.'), true);
});

test('Facebook status repair verifies access and cleans malformed media posts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-status-'));
  try {
    const store = new JobStore(directory);
    await store.init();
    const sessionJob = await store.enqueue(payload());
    const mediaJob = await store.enqueue(payload({
      idempotency_key: 'chiping-facebook:v1:9302',
      productId: '9302',
      itemUrl: 'https://www.chiping.co.il/?item=9302',
    }));
    await store.markBlocked(
      sessionJob.job.id,
      'Facebook session needs an interactive login or security verification'
    );
    await store.markBlocked(
      mediaJob.job.id,
      'Facebook published the Chiping post without its product image link card'
    );

    const inspection = inspectFacebookStatus(store);
    assert.equal(inspection.outcome, 'blocked_recoverable');
    assert.equal(inspection.recoverableIds, '9301,9302');
    assert.equal(inspection.mediaRecoverableIds, '9302');
    assert.equal(inspection.unresolvedIds, '');

    let verifications = 0;
    let mediaRepairs = 0;
    const repaired = await repairFacebookBlockedJobs(store, async () => {
      verifications += 1;
    }, {
      repairMediaBlock: async (job) => {
        mediaRepairs += 1;
        assert.equal(job.product_id, '9302');
        return { repaired: true, postUrl: 'https://www.facebook.com/groups/chiping/posts/9302/' };
      },
    });
    assert.equal(verifications, 1);
    assert.equal(mediaRepairs, 1);
    assert.equal(repaired.outcome, 'repaired');
    assert.equal(repaired.resumed, 2);
    assert.equal(store.state.jobs[sessionJob.job.id].status, 'retry');
    assert.equal(store.state.jobs[mediaJob.job.id].status, 'retry');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Facebook status repair quarantines a media post when exact cleanup fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-status-'));
  try {
    const store = new JobStore(directory);
    await store.init();
    const mediaJob = await store.enqueue(payload());
    await store.markBlocked(
      mediaJob.job.id,
      'Facebook product image does not open the exact Chiping item'
    );

    let accessChecks = 0;
    const result = await repairFacebookBlockedJobs(store, async () => {
      accessChecks += 1;
    }, {
      repairMediaBlock: async () => ({ repaired: false, postUrl: '' }),
    });
    assert.equal(accessChecks, 0);
    assert.equal(result.outcome, 'repair_failed');
    assert.equal(result.resumed, 0);
    assert.equal(store.state.jobs[mediaJob.job.id].status, 'blocked');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Facebook media repair finds the exact item by its description before deleting', async () => {
  const job = {
    product_id: '10809',
    payload: {
      itemUrl: 'https://www.chiping.co.il/?item=10809',
      title: 'נעלי סניקרס לגברים',
      message: 'נעלי הסניקרס כוללות עיצוב שרוכים קלאסי להתאמה בטוחה.',
    },
  };
  let findOptions = null;
  let deletedUrl = '';
  const result = await repairFacebookMediaBlock(job, {}, {
    findPost: async (_config, itemUrl, options) => {
      assert.equal(itemUrl, job.payload.itemUrl);
      findOptions = options;
      return { postUrl: 'https://www.facebook.com/groups/chiping/posts/10809/' };
    },
    deletePost: async (postUrl) => {
      deletedUrl = postUrl;
      return { deleted: true };
    },
  });
  assert.equal(findOptions.expectedMessage, job.payload.message);
  assert.equal(findOptions.requireLoadedLinkImage, false);
  assert.equal(deletedUrl, 'https://www.facebook.com/groups/chiping/posts/10809/');
  assert.equal(result.repaired, true);
});

test('Facebook media repair deletes by exact queued description when no permalink exists', async () => {
  const job = {
    product_id: '10809',
    payload: {
      itemUrl: 'https://www.chiping.co.il/?item=10809',
      title: 'נעלי סניקרס לגברים',
      message: 'נעלי הסניקרס כוללות עיצוב שרוכים קלאסי להתאמה בטוחה.',
    },
  };
  let deletedJob = null;
  const result = await repairFacebookMediaBlock(job, {}, {
    findPost: async () => ({ found: true, postUrl: '' }),
    deletePost: async () => {
      throw new Error('URL deletion must not run without a permalink');
    },
    deletePostByMessage: async (candidate) => {
      deletedJob = candidate;
      return { deleted: true, postUrl: '' };
    },
  });
  assert.equal(deletedJob, job);
  assert.equal(result.repaired, true);
  assert.equal(result.postUrl, '');
});

test('Facebook status repair keeps the queue blocked when access verification fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-status-'));
  try {
    const store = new JobStore(directory);
    await store.init();
    const queued = await store.enqueue(payload());
    await store.markBlocked(
      queued.job.id,
      'Facebook session needs an interactive login or security verification'
    );

    const result = await repairFacebookBlockedJobs(store, async () => {
      throw new FacebookSessionRequiredError();
    });
    assert.equal(result.outcome, 'verification_required');
    assert.equal(store.state.jobs[queued.job.id].status, 'blocked');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Facebook status checker fails closed when encrypted state is missing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-status-'));
  try {
    await assert.rejects(
      runFacebookStatus({
        FACEBOOK_ACTION_STATE_FILE: path.join(directory, 'missing.enc'),
        FACEBOOK_STATE_ENCRYPTION_KEY: secret,
        FACEBOOK_STORAGE_STATE_FILE: path.join(directory, 'storage.json'),
        POSTER_DATA_DIR: path.join(directory, 'data'),
      }),
      /Encrypted Facebook state is missing/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Facebook composer stages a versioned card and retains only the clean visible item URL', async () => {
  const canonicalUrl = 'https://www.chiping.co.il/?item=9301';
  const itemUrl = `${canonicalUrl}&fb_preview=fresh-image`;
  const cleanMessage = '\u05e7\u05d5\u05e4\u05d5\u05e0\u05d9\u05dd \u05d7\u05d3\u05e9\u05d9\u05dd \u05dc-AliExpress';
  let value = '';
  let previewReady = false;
  let selection = '';
  const fills = [];
  const visualSelector = [
    'a[href]',
    '[role="link"]',
    'img',
    '[role="img"]',
    '[data-visualcompletion="media-vc-image"]',
    '[style*="background-image"]',
  ].join(', ');
  const dialog = {
    async innerText() { return previewReady ? `${value}\nCHIPING.CO.IL` : value; },
    locator(selector) {
      if (selector === 'a[href]') {
        return {
          async evaluateAll() {
            return previewReady
              ? [`https://l.facebook.com/l.php?u=${encodeURIComponent(itemUrl)}`]
              : [];
          },
        };
      }
      if (selector === visualSelector) {
        return {
          async evaluateAll() {
            return previewReady
              ? [{
                width: 500,
                height: 262,
                visible: true,
                tagName: 'A',
                role: 'link',
                clickTargets: [`https://l.facebook.com/l.php?u=${encodeURIComponent(itemUrl)}`],
              }]
              : [];
          },
        };
      }
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };
  const textBox = {
    async click() {},
    async fill(text) {
      value = text;
      fills.push(text);
      if (text.includes(itemUrl)) previewReady = true;
    },
    async innerText() { return value; },
    async evaluate(_callback, target) {
      if (!value.includes(target)) return false;
      selection = target;
      return true;
    },
    locator(selector) {
      assert.equal(selector, 'xpath=ancestor::*[@role="dialog"][1]');
      return dialog;
    },
  };
  const page = {
    async waitForTimeout() {},
    keyboard: {
      async press(key) {
        if (key === 'Backspace' && selection) {
          value = value.replace(selection, '');
          selection = '';
        }
      },
      async insertText(text) { value += text; },
    },
  };

  const result = await prepareFacebookComposerLinkPreview(
    page,
    textBox,
    `${cleanMessage}\n\ud83d\udd17 ${canonicalUrl}`,
    itemUrl
  );

  assert.deepEqual(fills, [`${cleanMessage}\n\n${itemUrl}`]);
  assert.equal(value.trim(), `${cleanMessage}\n\n${canonicalUrl}`);
  assert.equal(previewReady, true);
  assert.equal(result.visibleUrlRemoved, false);
  assert.equal(result.visibleUrlRetained, canonicalUrl);
  assert.equal(result.hasTargetAnchor, true);
  assert.equal(result.hostOccurrences, 2);
});

test('Facebook composer rejects an image card that links only to the homepage', () => {
  const itemTarget = { type: 'item', value: '9302' };
  const homepageCard = [{
    width: 500,
    height: 262,
    visible: true,
    tagName: 'A',
    role: 'link',
    imageLoaded: true,
    clickTargets: ['https://www.chiping.co.il/'],
  }];

  assert.equal(hasLoadedFacebookPreviewVisual(homepageCard), true);
  assert.equal(hasLoadedFacebookPreviewVisual(homepageCard, itemTarget), false);
});

test('Facebook URL range selection fails closed when the staged URL is absent', async () => {
  const textBox = {
    async evaluate() { return false; },
  };
  assert.equal(await selectFacebookComposerText(
    textBox,
    'https://www.chiping.co.il/?item=9301'
  ), false);
});

test('Facebook posting waits for the composer to close instead of aborting an upload', async () => {
  let visibilityChecks = 0;
  let waits = 0;
  const textBox = {
    async isVisible() {
      visibilityChecks += 1;
      return visibilityChecks < 3;
    },
  };
  const page = {
    async waitForTimeout() { waits += 1; },
  };

  await waitForFacebookComposerToClose(page, textBox, 5000);
  assert.equal(visibilityChecks, 3);
  assert.equal(waits, 2);
});

test('interactive login accepts the current group composer without an aria-label', async () => {
  const page = {
    url: () => 'https://www.facebook.com/groups/chiping',
    async evaluate() {},
    async waitForTimeout() {},
    locator(selector) {
      const visible = selector === '[role="button"]:has-text("Write something")';
      return {
        first() {
          return { async isVisible() { return visible; } };
        },
      };
    },
  };

  assert.equal(
    await loginCompleted(page, 'https://www.facebook.com/groups/chiping'),
    true
  );
});

test('job store is durable and idempotent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-poster-'));
  try {
    const store = new JobStore(directory);
    await store.init();
    const first = await store.enqueue(payload());
    const second = await store.enqueue(payload());
    assert.equal(first.accepted, true);
    assert.equal(second.deduplicated, true);
    const claimed = await store.claimNext();
    assert.equal(claimed.id, first.job.id);
    await store.markPosted(claimed.id, 'https://www.facebook.com/groups/chiping');

    const reopened = new JobStore(directory);
    await reopened.init();
    assert.deepEqual(reopened.summary(), {
      pending: 0,
      retry: 0,
      processing: 0,
      blocked: 0,
      posted: 1,
      skipped: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('job store prioritizes Amazon Deals posts over curated backlog', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-poster-'));
  try {
    const store = new JobStore(directory);
    await store.init();
    await store.enqueue(payload());
    await store.enqueue(payload({
      posting_policy: 'amazon-deals-all',
      idempotency_key: 'chiping-facebook:v1:9302',
      productId: '9302',
      itemUrl: 'https://www.chiping.co.il/?item=9302',
    }));

    assert.equal(store.peekNext().product_id, '9302');
    assert.equal((await store.claimNext()).product_id, '9302');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('job store prioritizes a coupon announcement over product backlogs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-poster-'));
  try {
    const store = new JobStore(directory);
    await store.init();
    await store.enqueue(payload());
    await store.enqueue(payload({
      posting_policy: 'amazon-deals-all',
      idempotency_key: 'chiping-facebook:v1:9302',
      productId: '9302',
      itemUrl: 'https://www.chiping.co.il/?item=9302',
    }));
    await store.enqueue(couponPayload());

    const next = store.peekNext();
    assert.equal(next.payload.post_type, 'coupon_announcement');
    assert.equal(next.content_id, 'b'.repeat(32));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('job store refreshes a failed duplicate payload without reopening a posted job', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-poster-'));
  try {
    const store = new JobStore(directory);
    await store.init();
    const first = await store.enqueue(payload({ imageUrl: 'https://cdn.example.test/old.jpg' }));
    await store.markRetry(first.job.id, 'stale image', new Date(Date.now() + 60000).toISOString());
    const refreshed = await store.enqueue(payload({ imageUrl: 'https://www.chiping.co.il/facebook-images/9301.jpg?v=new' }));
    assert.equal(refreshed.deduplicated, true);
    assert.equal(refreshed.job.payload.imageUrl, 'https://www.chiping.co.il/facebook-images/9301.jpg?v=new');

    await store.markPosted(first.job.id, 'https://www.facebook.com/groups/chiping/posts/111/');
    const postedDuplicate = await store.enqueue(payload({ imageUrl: 'https://cdn.example.test/never-use.jpg' }));
    assert.equal(postedDuplicate.job.payload.imageUrl, 'https://www.chiping.co.il/facebook-images/9301.jpg?v=new');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('posted-product ledger prevents reposting after the original job is pruned', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-poster-'));
  try {
    const store = new JobStore(directory);
    await store.init();
    const queued = await store.enqueue(payload());
    const postUrl = 'https://www.facebook.com/groups/chiping/posts/111/';
    await store.markPosted(queued.job.id, postUrl);
    delete store.state.jobs[queued.job.id];
    store.state.order = [];
    await store.persist();

    const reopened = new JobStore(directory);
    await reopened.init();
    const duplicate = await reopened.enqueue(payload({
      imageUrl: 'https://cdn.example.test/new-image-that-must-not-post.jpg',
    }));

    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.job.status, 'posted');
    assert.equal(duplicate.job.post_url, postUrl);
    assert.deepEqual(reopened.postedLedgerEntries(), [{
      product_id: '9301',
      post_url: postUrl,
      posted_at: reopened.state.posted_products['9301'].posted_at,
    }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('job store can reset one falsely completed product without touching others', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-poster-'));
  try {
    const store = new JobStore(directory);
    await store.init();
    const first = await store.enqueue(payload());
    const second = await store.enqueue({
      ...payload(),
      idempotency_key: 'chiping-facebook:v1:9302',
      productId: '9302',
      itemUrl: 'https://www.chiping.co.il/?item=9302',
    });
    await store.markPosted(first.job.id, 'https://www.facebook.com/groups/chiping/posts/111/');
    await store.markPosted(second.job.id, 'https://www.facebook.com/groups/chiping/posts/222/');

    assert.equal(await store.resetProduct('9301'), 1);
    assert.deepEqual(store.summary(), {
      pending: 1,
      retry: 0,
      processing: 0,
      blocked: 0,
      posted: 1,
      skipped: 0,
    });
    const resetJob = store.state.jobs[first.job.id];
    assert.equal(resetJob.post_url, null);
    assert.equal('posted_at' in resetJob, false);
    assert.equal(store.state.jobs[second.job.id].status, 'posted');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('job store can confirm a recovered Facebook permalink without reposting', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-poster-'));
  try {
    const store = new JobStore(directory);
    await store.init();
    const queued = await store.enqueue(payload());
    await store.markRetry(queued.job.id, 'verification_failed', new Date().toISOString());
    const postUrl = 'https://www.facebook.com/photo/?fbid=111&set=g.222';

    assert.equal(await store.confirmProductPosted('9301', postUrl), 1);
    assert.equal(store.state.jobs[queued.job.id].status, 'posted');
    assert.equal(store.state.jobs[queued.job.id].post_url, postUrl);
    assert.equal(store.state.jobs[queued.job.id].last_error, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('job store can finalize one reviewed product without a permalink', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-poster-'));
  try {
    const store = new JobStore(directory);
    await store.init();
    const queued = await store.enqueue(payload());
    await store.markBlocked(queued.job.id, 'missing image');

    assert.equal(await store.finalizeProductPostedUnlinked('9301'), 1);
    assert.equal(store.state.jobs[queued.job.id].status, 'posted');
    assert.equal(store.state.jobs[queued.job.id].post_url, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('poster accepts only signed Chiping jobs and acknowledges duplicates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'facebook-poster-'));
  const config = {
    host: '127.0.0.1',
    port: 0,
    dataDir: directory,
    profileDir: path.join(directory, 'profile'),
    groupUrl: 'https://www.facebook.com/groups/chiping',
    sharedSecret: secret,
    dryRun: false,
    headless: true,
    maxAttempts: 5,
    retryIntervalMs: 3600000,
    facebookLoginEmailFile: '',
    facebookLoginPasswordFile: '',
    alertWebhookUrl: '',
  };
  const app = await createServer({ config, postJob: async () => ({ postUrl: config.groupUrl }) });
  await new Promise((resolve) => app.server.listen(0, config.host, resolve));
  const port = app.server.address().port;
  const body = JSON.stringify(payload());
  const timestamp = String(Date.now());
  try {
    const rejected = await fetch(`http://127.0.0.1:${port}/v1/jobs`, { method: 'POST', body });
    assert.equal(rejected.status, 401);

    const request = () => fetch(`http://127.0.0.1:${port}/v1/jobs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-chiping-timestamp': timestamp,
        'x-chiping-signature': signPayload(secret, timestamp, body),
      },
      body,
    });
    const first = await request();
    const second = await request();
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal((await second.json()).deduplicated, true);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
      if (health.queue.posted === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(app.store.summary().posted, 1);
  } finally {
    app.runner.stop();
    await new Promise((resolve) => app.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
