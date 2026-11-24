ALTER TABLE membership_applications ADD COLUMN screened_at TEXT;
ALTER TABLE membership_applications ADD COLUMN screening_version INTEGER CHECK (screening_version > 0);
ALTER TABLE membership_applications ADD COLUMN screening_checks TEXT CHECK (
    screening_checks IS NULL OR (json_valid(screening_checks) AND json_type(screening_checks) = 'array')
);
ALTER TABLE membership_applications ADD COLUMN verification_confirmed INTEGER CHECK (
    verification_confirmed IS NULL OR (verification_confirmed = 1 AND requested_role <> 'CONSUMER'
      AND status = 'APPROVED' AND reviewer_id IS NOT NULL AND screened_at IS NOT NULL)
);

CREATE UNIQUE INDEX ux_membership_application_owner ON membership_applications(id, applicant_id);
CREATE TABLE membership_submission_keys (
    applicant_id TEXT NOT NULL REFERENCES users(id),
    request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 100),
    request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
    application_id TEXT NOT NULL,
    PRIMARY KEY (applicant_id, request_key),
    FOREIGN KEY (application_id, applicant_id) REFERENCES membership_applications(id, applicant_id)
) STRICT;
