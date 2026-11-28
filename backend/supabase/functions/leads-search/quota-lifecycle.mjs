// Coordinates the three-phase quota protocol. Database RPCs enforce ownership,
// locking and idempotency; this helper ensures every post-reservation failure
// attempts an idempotent refund and retries only when its transport fails.
export async function executeReservedSearch({requestId, reserve, search, confirm, refund, signal}) {
  if (signal?.aborted) {
    return {kind: "cancelled", error: signal.reason, refunded: false};
  }
  let reservationAttempted = false;
  let reserved = false;
  try {
    reservationAttempted = true;
    const quota = await reserve(requestId);
    if (!quota || typeof quota.ok !== "boolean") {
      throw Object.assign(new Error("quota_reservation_response_invalid"), {code:"QUOTA_RESPONSE_INVALID"});
    }
    if (!quota.ok) {
      return {kind: "rejected", quota, refundAttempted: false};
    }
    reserved = true;
    if (signal?.aborted) throw Object.assign(new Error("request_cancelled"), {code:"REQUEST_CANCELLED"});
    const value = await search();
    if (signal?.aborted) throw Object.assign(new Error("request_cancelled"), {code:"REQUEST_CANCELLED"});
    const result = await confirm(requestId);
    if (!result?.confirmed) throw Object.assign(new Error("quota_confirmation_failed"), {code:"QUOTA_CONFIRM_FAILED"});
    reserved = false;
    return {kind: "success", value, quota};
  } catch (error) {
    let refunded = false;
    // Reserve may have reached Postgres even if its HTTP response was lost.
    // The caller binds settlement to this invocation's private attempt UUID.
    // A duplicate invocation cannot refund a different invocation's reservation.
    if (reserved || reservationAttempted) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await refund(requestId);
          if (typeof result?.refunded !== "boolean" || result.reason === "not_found") continue;
          refunded = result.refunded || result.duplicate === true;
          break;
        } catch { /* An unsettled reservation can be reclaimed after its TTL. */ }
      }
    }
    return {kind: signal?.aborted ? "cancelled" : "failed", error, refunded};
  }
}
