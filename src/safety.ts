/**
 * Secret hygiene helpers for the command-line tools.
 *
 * The signing key must never be printed, including as part of an error message
 * from a library. Redaction is done by matching the *actual* configured secret
 * value rather than a generic 64-character hex pattern, so transaction hashes
 * and addresses in error output stay readable while the key never leaks.
 */

export function redactSecrets(text: string, extra: Array<string | undefined> = []): string {
  let out = text;
  const secrets = [process.env.NIBIRU_PRIVATE_KEY, ...extra].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  for (const secret of secrets) {
    const bare = secret.startsWith("0x") ? secret.slice(2) : secret;
    out = out.split(secret).join("0x[redacted]");
    if (bare.length > 0) out = out.split(bare).join("[redacted]");
  }
  return out;
}
