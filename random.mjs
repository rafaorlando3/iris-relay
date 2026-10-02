// Random hex tokens from Web Crypto, available both in Node.js 22 and in browsers,
// so the review, audit and session logic runs unchanged in either place.
export function randomHex(bytes) {
  const values = globalThis.crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (b) => b.toString(16).padStart(2, "0")).join("");
}
