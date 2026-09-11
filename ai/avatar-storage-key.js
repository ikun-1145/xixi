export function encodeAvatarOwnerKey(userId) {
  const bytes = new TextEncoder().encode(String(userId));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
