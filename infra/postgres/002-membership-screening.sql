ALTER TABLE wss.membership_applications
    ADD COLUMN screened_at timestamptz,
    ADD COLUMN screening_version integer CHECK (screening_version > 0),
    ADD COLUMN screening_checks jsonb CHECK (jsonb_typeof(screening_checks) = 'array'),
    ADD COLUMN verification_confirmed boolean CHECK (
        verification_confirmed IS NULL OR (verification_confirmed AND requested_role <> 'CONSUMER'
          AND status = 'APPROVED' AND reviewer_id IS NOT NULL AND screened_at IS NOT NULL)
    );

CREATE UNIQUE INDEX ux_membership_application_owner ON wss.membership_applications(id, applicant_id);
CREATE TABLE wss.membership_submission_keys (
    applicant_id uuid NOT NULL REFERENCES wss.users(id),
    request_key text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 100),
    request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    application_id uuid NOT NULL,
    PRIMARY KEY (applicant_id, request_key),
    FOREIGN KEY (application_id, applicant_id) REFERENCES wss.membership_applications(id, applicant_id)
);
