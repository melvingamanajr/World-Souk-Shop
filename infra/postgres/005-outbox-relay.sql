CREATE TABLE wss.outbox_relay_state (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    lease_id uuid,
    lease_until timestamptz,
    retry_at timestamptz,
    consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    last_success_at timestamptz,
    CHECK ((lease_id IS NULL) = (lease_until IS NULL))
);

INSERT INTO wss.outbox_relay_state DEFAULT VALUES;

-- Acquire the aggregate lock before allocating a sequence. Writers for the same
-- aggregate cannot commit later events while an earlier event is still invisible.
CREATE FUNCTION wss.record_outbox_event(kind text, entity uuid, data jsonb) RETURNS uuid
LANGUAGE plpgsql SET search_path TO pg_catalog, wss AS $$
DECLARE event_id uuid;
BEGIN
    IF kind IS NULL OR length(kind) < 1 OR length(kind) > 128 THEN
        RAISE EXCEPTION 'The event type must contain 1 to 128 characters' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(entity::text, 839872));
    INSERT INTO wss.event_outbox(event_type, aggregate_id, payload)
      VALUES (kind, entity, data) RETURNING id INTO event_id;
    RETURN event_id;
END;
$$;
