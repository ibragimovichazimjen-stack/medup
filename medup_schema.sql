 category TEXT NOT NULL DEFAULT 'Прочее', entry_type TEXT NOT NULL,
 entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
 created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS hidden_chat_channels (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS hidden_chat_messages (
 id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 nickname TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
 channel_id INTEGER NOT NULL REFERENCES hidden_chat_channels(id),
 reply_to_id INTEGER REFERENCES hidden_chat_messages(id) ON DELETE SET NULL,
 image_url TEXT, file_url TEXT, file_name TEXT,
 file_faculty_id INTEGER REFERENCES faculties(id) ON DELETE SET NULL,
 file_course INTEGER, file_language TEXT, review_status TEXT,
 approved_subject_id INTEGER REFERENCES subjects(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS hidden_chat_presence (
 id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 channel_id INTEGER NOT NULL REFERENCES hidden_chat_channels(id),
 nickname TEXT NOT NULL, last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(user_id, channel_id)
);
CREATE TABLE IF NOT EXISTS hidden_chat_reactions (
 id SERIAL PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES hidden_chat_messages(id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 emoji TEXT NOT NULL, UNIQUE(message_id, user_id)
);
INSERT INTO faculties(name) VALUES
 ('Лечебный'), ('Педиатрический'), ('Стоматологический'),
 ('Фармацевтический'), ('Медико-профилактический')
ON CONFLICT (name) DO NOTHING;
INSERT INTO hidden_chat_channels(id, name) VALUES
 (1, 'Общий чат'), (2, 'Администрация'), (3, 'Руководство')
ON CONFLICT (id) DO NOTHING;
COMMIT;
