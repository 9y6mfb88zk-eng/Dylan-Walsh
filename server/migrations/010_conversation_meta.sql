-- JARVIS 6.8: per-message conversation metadata (what JARVIS looked up for a reply, and whether you interrupted it
-- and what you actually heard). Used to keep follow-up questions in context; never copied into long-term memory.
ALTER TABLE messages ADD COLUMN meta TEXT;
