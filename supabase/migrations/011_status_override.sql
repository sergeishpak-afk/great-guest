-- Migration 011: Guest status override
-- Allows organizers to manually pin a guest's status instead of auto-calculating from visits.
-- NULL = auto (calculated from visit_count), otherwise = locked value.

ALTER TABLE organizer_contacts
  ADD COLUMN IF NOT EXISTS status_override VARCHAR(10) DEFAULT NULL
  CHECK (status_override IN ('Bronze', 'Silver', 'Gold', 'Platinum', 'VIP'));
