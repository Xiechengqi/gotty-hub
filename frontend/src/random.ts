// getRandomValues works on plain HTTP too. randomUUID requires a secure context,
// but Hub explicitly supports LAN addresses served over HTTP.
export function randomId(): string {
  return Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16).padStart(8, '0')).join('');
}
