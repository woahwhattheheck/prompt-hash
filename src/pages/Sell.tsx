/**
 * Legacy compatibility entry for older imports.
 *
 * The routed /sell experience lives in ./sell/page and submits through
 * CreatePromptForm's encrypted, wallet-backed createPrompt flow. Keeping a
 * second legacy listing implementation here risks bypassing that authoritative
 * production path.
 */
export { default } from "./sell/page";
