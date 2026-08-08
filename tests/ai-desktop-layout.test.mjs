import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const styles = fs.readFileSync(new URL('../ai/styles-2.css', import.meta.url), 'utf8');
const desktopStart = styles.indexOf('/* 桌面端：聊天区和输入框为侧边栏留出空间 */');
const desktopEnd = styles.indexOf('#uploadPreview > div', desktopStart);
const desktopStyles = styles.slice(desktopStart, desktopEnd);

test('desktop chat width stays inside the sidebar-adjusted viewport', () => {
  assert.notEqual(desktopStart, -1);
  assert.notEqual(desktopEnd, -1);
  assert.match(
    desktopStyles,
    /\.chat-container\s*{[^}]*width:\s*calc\(100%\s*-\s*220px\);[^}]*box-sizing:\s*border-box;/s,
  );
  assert.match(
    desktopStyles,
    /#sidebar\.collapsed\s*~\s*\.chat-container\s*{[^}]*width:\s*100%;/s,
  );
});
