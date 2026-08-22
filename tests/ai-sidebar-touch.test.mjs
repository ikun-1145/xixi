import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { installSidebarTouchScrollGuard } from '../ai/sidebar-touch.js';

const styles = fs.readFileSync(new URL('../ai/styles-2.css', import.meta.url), 'utf8');

function dispatchTouch(target, type, points = []) {
  const event = new Event(type);
  Object.defineProperty(event, 'touches', {
    value: points.map(([clientX, clientY]) => ({ clientX, clientY })),
  });
  target.dispatchEvent(event);
}

test('mobile sidebar keeps native vertical scrolling enabled', () => {
  const sidebarStyles = styles.match(/#sidebar\s*\{([\s\S]*?)\}/u)?.[1] || '';

  assert.match(sidebarStyles, /overflow-y:\s*auto;/u);
  assert.match(sidebarStyles, /-webkit-overflow-scrolling:\s*touch;/u);
  assert.match(sidebarStyles, /overscroll-behavior-y:\s*contain;/u);
  assert.match(sidebarStyles, /touch-action:\s*pan-y;/u);
});

test('sidebar drag suppresses only its synthetic click', () => {
  const sidebar = new EventTarget();
  let clickCount = 0;

  installSidebarTouchScrollGuard(sidebar);
  sidebar.addEventListener('click', () => {
    clickCount += 1;
  });

  dispatchTouch(sidebar, 'touchstart', [[20, 100]]);
  dispatchTouch(sidebar, 'touchmove', [[21, 125]]);
  dispatchTouch(sidebar, 'touchend');

  const syntheticClick = new Event('click', { cancelable: true });
  sidebar.dispatchEvent(syntheticClick);

  assert.equal(syntheticClick.defaultPrevented, true);
  assert.equal(clickCount, 0);

  dispatchTouch(sidebar, 'touchstart', [[20, 125]]);
  dispatchTouch(sidebar, 'touchend');
  const intentionalClick = new Event('click', { cancelable: true });
  sidebar.dispatchEvent(intentionalClick);

  assert.equal(intentionalClick.defaultPrevented, false);
  assert.equal(clickCount, 1);
});

test('minor finger movement still allows an intentional tap', () => {
  const sidebar = new EventTarget();
  let clickCount = 0;

  installSidebarTouchScrollGuard(sidebar);
  sidebar.addEventListener('click', () => {
    clickCount += 1;
  });

  dispatchTouch(sidebar, 'touchstart', [[20, 100]]);
  dispatchTouch(sidebar, 'touchmove', [[23, 104]]);
  dispatchTouch(sidebar, 'touchend');
  const click = new Event('click', { cancelable: true });
  sidebar.dispatchEvent(click);

  assert.equal(click.defaultPrevented, false);
  assert.equal(clickCount, 1);
});
