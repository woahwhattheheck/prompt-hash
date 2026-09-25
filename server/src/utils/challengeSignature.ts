/**
 * Re-export the authoritative Stellar challenge verifier (#184).
 *
 * Prefer importing from `src/lib/auth/challenge`. This shim keeps older
 * server-relative imports working without forking the crypto check.
 */
export { verifyChallengeSignature } from "../../../src/lib/auth/challenge";
