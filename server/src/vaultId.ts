/**
 * vaultId validation, isolated in its own module (no Workers-runtime imports)
 * so it can be unit tested directly under plain Node — index.ts pulls in
 * partyserver, which requires `cloudflare:workers` and can't load outside a
 * Workers runtime.
 */
export const VAULT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** Decode + validate a vaultId from a URL segment. Rejects malformed percent-
 * encoding (decodeURIComponent throws) and anything outside the plugin's
 * actual vaultId alphabet — in particular '/', which would otherwise reach
 * R2 key construction and DO naming. */
export function decodeAndValidateVaultId(raw: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return null;
	}
	return VAULT_ID_PATTERN.test(decoded) ? decoded : null;
}
