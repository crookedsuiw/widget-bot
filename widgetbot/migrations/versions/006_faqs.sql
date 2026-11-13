-- Phase 2, slice 4: an FAQ is a set of question wordings plus rotating answers and an optional button.

-- Each wording is matched on its own; the closest one decides which FAQ answers
CREATE TABLE faq_questions (
    id         BIGSERIAL PRIMARY KEY,
    faq_id     BIGINT NOT NULL REFERENCES faqs(id) ON DELETE CASCADE,
    client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    question   TEXT NOT NULL,
    embedding  VECTOR(384) NOT NULL,
    position   INT NOT NULL DEFAULT 0     -- 0 = the wording shown as the FAQ's title
);
-- The same wording can't point at two FAQs
CREATE UNIQUE INDEX faq_questions_unique ON faq_questions (client_id, lower(question));
CREATE INDEX ON faq_questions (client_id);
CREATE INDEX ON faq_questions (faq_id);

-- Existing FAQs keep their one question as their only wording (duplicates are merged by hand in the dashboard)
INSERT INTO faq_questions (faq_id, client_id, question, embedding)
SELECT id, client_id, question, embedding FROM faqs;

-- Old answers keep their inline HTML button until they're re-saved from the dashboard
ALTER TABLE faqs
    DROP COLUMN question,
    DROP COLUMN embedding,
    ADD COLUMN button_label TEXT,
    ADD COLUMN button_url   TEXT,
    ADD CONSTRAINT faqs_button_pair CHECK ((button_label IS NULL) = (button_url IS NULL));

-- Match strictness is per website now (edited on the FAQs page), not per prompt setting
ALTER TABLE clients ADD COLUMN faq_threshold REAL NOT NULL DEFAULT 0.70;
UPDATE clients c SET faq_threshold = s.faq_threshold FROM bot_settings s WHERE s.client_id = c.id AND s.is_active;
ALTER TABLE bot_settings DROP COLUMN faq_threshold;
