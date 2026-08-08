-- Check-in resolves each line, and "never came back" is one of the answers.
--
-- A return used to be yes-or-no with a condition on it. A customer can hand
-- back three of four and lose the fourth, and the fourth is not a return in any
-- sense: the unit is gone, it has to leave the deployable fleet, and somebody
-- has to be invoiced for it.
--
-- LOST is a **resolved** status, not an open one. It stops holding the
-- reservation window (the `rental_no_overlap` predicate is OPEN/OVERDUE only)
-- and stops keeping the order open, because there is nothing left to wait for.

ALTER TYPE "RentalStatus" ADD VALUE IF NOT EXISTS 'LOST';
