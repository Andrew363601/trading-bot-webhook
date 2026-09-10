-- Migration 042: challenge entries — add pending_payment status
-- Join API creates 'pending_payment' pre-checkout; flips to 'active' on checkout.session.completed.

ALTER TABLE challenge_entries DROP CONSTRAINT IF EXISTS challenge_entries_status_check;
ALTER TABLE challenge_entries ADD CONSTRAINT challenge_entries_status_check
  CHECK (status IN ('pending_payment','active','completed','disqualified'));