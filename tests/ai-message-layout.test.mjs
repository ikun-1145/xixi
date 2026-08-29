import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const primaryStyles = fs.readFileSync(new URL('../ai/styles-1.css', import.meta.url), 'utf8');
const secondaryStyles = fs.readFileSync(new URL('../ai/styles-2.css', import.meta.url), 'utf8');

test('assistant replies use the full chat width without a bubble shell', () => {
  assert.match(
    primaryStyles,
    /\.chat-inner\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*none;[^}]*box-sizing:\s*border-box;/su,
  );
  assert.match(
    primaryStyles,
    /\.message\.ai \.bubble\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/su,
  );
  assert.match(
    secondaryStyles,
    /\.message\.ai \.bubble\s*\{[^}]*background:\s*transparent;[^}]*backdrop-filter:\s*none;/su,
  );
});

test('user messages keep their bounded gradient bubble', () => {
  assert.match(primaryStyles, /\.bubble\s*\{[^}]*max-width:\s*65%;/su);
  assert.match(
    primaryStyles,
    /\.message\.user \.bubble\s*\{[^}]*background:\s*linear-gradient\(135deg,#22d3ee,#67e8f9\);/su,
  );
  assert.match(primaryStyles, /\.message\.user\s*\{[^}]*justify-content:\s*flex-end;/su);
});
